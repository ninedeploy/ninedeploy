import type { DB } from '@ninedeploy/db';
import {
  runtimeFenceRequest, runtimeFenceReply, containerPrepareRequest, containerPrepareReply,
  containerNetworkSetRequest, containerNetworkSetReply, containerRetireSetRequest, containerRetireSetReply,
  containerLimitsRequest, containerLimitsReply,
  containerStartSetRequest, containerStartSetReply,
  containerStopSetRequest, containerStopSetReply,
  containerInventoryRequest, containerInventoryReply,
  type RuntimeFenceRequest, type ContainerPrepareRequest, type ContainerNetworkSetRequest, type ContainerRetireSetRequest, type ContainerLimitsRequest, type ContainerStartSetRequest, type ContainerStopSetRequest, type ContainerInventoryRequest, type MultiNodeCapability,
} from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { z } from 'zod';

type Header = { requestId: string; serviceId: number; revision: number };
type Target = { id: string; name: string; deploymentId: number };
const sameTargets = (expected: Target[], actual: Target[]) => expected.length === actual.length && expected.every(target =>
  actual.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId));

/** The caller supplies its durable nonce/revision and rechecks its SQL authority at every boundary. */
export function createNodeRuntimeMutationClient(db: DB, serverId: number,
  options: { checkpoint: () => Promise<void>; signal?: AbortSignal; onLine?: (line: string) => void }) {
  if (!Number.isSafeInteger(serverId) || serverId < 1) throw new Error('Runtime mutation requires an explicit node');
  async function exchange<Request extends Header & { timeoutMs: number }, Reply extends Header>(
    op: string, prefix: string, input: Request, parse: (value: unknown) => Reply, matches: (reply: Reply) => boolean, cap: MultiNodeCapability = 'docker.mutations',
  ): Promise<Reply> {
    const deadline = performance.now() + input.timeoutMs;
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(input.timeoutMs)]);
    const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
    const current = async () => {
      signal.throwIfAborted(); await options.checkpoint(); signal.throwIfAborted();
      if (remaining() < 1) throw new Error('Runtime mutation deadline exceeded');
    };
    await current();
    const sealed = await agentTransportSealed(db, serverId, signal);
    await current();
    const refusal = await capabilityRefusal(async (operation, params, sink) => {
      await current();
      const result = await agentOp(db, serverId, operation, params, sink, { signal, timeoutMs: Math.min(5000, remaining()) });
      await current(); return result;
    }, '#' + serverId, sealed, { cap, feature: 'order immutable runtime mutations', sealedRequired: true });
    if (refusal) throw new Error(refusal.message);
    await current();
    const budget = remaining();
    const result = await agentOp(db, serverId, op, { ...input, timeoutMs: budget }, options.onLine ?? (() => undefined),
      { signal, timeoutMs: budget });
    await current();
    const frames = result.lines.filter(line => line.startsWith(prefix));
    if (result.exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 65_536) throw new Error('Runtime mutation receipt unavailable');
    const reply = parse(JSON.parse(frames[0]!.slice(prefix.length)));
    if (reply.requestId !== input.requestId || reply.serviceId !== input.serviceId || reply.revision !== input.revision || !matches(reply)) {
      throw new Error('Runtime mutation receipt identity or coverage changed');
    }
    return reply;
  }
  return {
    legacyHandoff(params: { requestId: string; serviceId: number; revision: number; timeoutMs: number; deploymentWatermark: number }) {
      const input = z.object({ requestId: z.string().regex(/^[a-f0-9]{32}$/), serviceId: z.number().int().positive().safe(), revision: z.number().int().positive().safe(),
        timeoutMs: z.number().int().positive().max(595_000), deploymentWatermark: z.number().int().positive().safe() }).strict().parse(params);
      return exchange('docker.runtimeLegacyHandoff', 'ND-RUNTIME-LEGACY ', input,
        value => z.object({ requestId: z.string(), serviceId: z.number(), revision: z.number(), deploymentWatermark: z.number(), complete: z.literal(true) }).strict().parse(value),
        reply => reply.deploymentWatermark === input.deploymentWatermark, 'docker.retireHandoff');
    },
    fence(params: RuntimeFenceRequest) {
      const input = runtimeFenceRequest.parse(params);
      return exchange('docker.runtimeFence', 'ND-RUNTIME-FENCE ', input, value => runtimeFenceReply.parse(value), reply => reply.deploymentWatermark === input.deploymentWatermark);
    },
    inventory(params: ContainerInventoryRequest) {
      const input = containerInventoryRequest.parse(params);
      return exchange('docker.runtimeInventory', 'ND-RUNTIME-INVENTORY ', input, value => containerInventoryReply.parse(value),
        reply => reply.deploymentWatermark === input.deploymentWatermark);
    },
    prepare(params: ContainerPrepareRequest) {
      const input = containerPrepareRequest.parse(params), serving = new Set(input.startNames ?? input.specs.map(spec => spec.name));
      return exchange('docker.prepare', 'ND-PREPARED ', input, value => containerPrepareReply.parse(value), reply =>
        reply.deploymentId === input.deploymentId && reply.items.length === input.specs.length && input.specs.every(spec =>
          reply.items.some(item => item.name === spec.name && item.deploymentId === input.deploymentId && item.running === serving.has(spec.name))));
    },
    networks(params: ContainerNetworkSetRequest) {
      const input = containerNetworkSetRequest.parse(params);
      return exchange('docker.networkSet', 'ND-NETWORKS ', input, value => containerNetworkSetReply.parse(value), reply =>
        reply.action === input.action && reply.networks.length === input.networks.length && input.networks.every(network => reply.networks.includes(network)) &&
        sameTargets(input.targets, reply.items));
    },
    retire(params: ContainerRetireSetRequest) {
      const input = containerRetireSetRequest.parse(params);
      return exchange('docker.retireSet', 'ND-RETIRED-SET ', input, value => containerRetireSetReply.parse(value), reply => sameTargets(input.targets, reply.items));
    },
    limits(params: ContainerLimitsRequest) {
      const input = containerLimitsRequest.parse(params);
      return exchange('docker.limits', 'ND-LIMITS ', input, value => containerLimitsReply.parse(value), reply => sameTargets(input.targets, reply.items), 'docker.limits');
    },
    start(params: ContainerStartSetRequest) {
      const input = containerStartSetRequest.parse(params);
      return exchange('docker.startSet', 'ND-STARTED-SET ', input, value => containerStartSetReply.parse(value), reply => sameTargets(input.targets, reply.items), 'docker.startSet');
    },
    stop(params: ContainerStopSetRequest) {
      const input = containerStopSetRequest.parse(params);
      return exchange('docker.stopSet', 'ND-STOPPED-SET ', input, value => containerStopSetReply.parse(value), reply => sameTargets(input.targets, reply.items));
    },
  };
}
