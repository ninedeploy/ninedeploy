import type { DB } from '@ninedeploy/db';
import {
  runtimeFenceRequest, runtimeFenceReply, containerPrepareRequest, containerPrepareReply,
  containerNetworkSetRequest, containerNetworkSetReply, containerRetireSetRequest, containerRetireSetReply,
  type RuntimeFenceRequest, type ContainerPrepareRequest, type ContainerNetworkSetRequest, type ContainerRetireSetRequest,
} from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';

type Header = { requestId: string; serviceId: number; revision: number };
type Target = { id: string; name: string; deploymentId: number };
const sameTargets = (expected: Target[], actual: Target[]) => expected.length === actual.length && expected.every(target =>
  actual.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId));

/** The caller supplies its durable nonce/revision and rechecks its SQL authority at every boundary. */
export function createNodeRuntimeMutationClient(db: DB, serverId: number,
  options: { checkpoint: () => Promise<void>; signal?: AbortSignal; onLine?: (line: string) => void }) {
  if (!Number.isSafeInteger(serverId) || serverId < 1) throw new Error('Runtime mutation requires an explicit node');
  async function exchange<Request extends Header & { timeoutMs: number }, Reply extends Header>(
    op: string, prefix: string, input: Request, parse: (value: unknown) => Reply, matches: (reply: Reply) => boolean,
  ): Promise<Reply> {
    const deadline = performance.now() + input.timeoutMs;
    const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
    const current = async () => {
      options.signal?.throwIfAborted(); await options.checkpoint(); options.signal?.throwIfAborted();
      if (remaining() < 1) throw new Error('Runtime mutation deadline exceeded');
    };
    await current();
    const sealed = await agentTransportSealed(db, serverId, options.signal);
    await current();
    const refusal = await capabilityRefusal(async (operation, params, sink) => {
      await current();
      const result = await agentOp(db, serverId, operation, params, sink, { signal: options.signal, timeoutMs: Math.min(5000, remaining()) });
      await current(); return result;
    }, '#' + serverId, sealed, { cap: 'docker.mutations', feature: 'order immutable runtime mutations', sealedRequired: true });
    if (refusal) throw new Error(refusal.message);
    await current();
    const budget = remaining();
    const result = await agentOp(db, serverId, op, { ...input, timeoutMs: budget }, options.onLine ?? (() => undefined),
      { signal: options.signal, timeoutMs: budget });
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
    fence(params: RuntimeFenceRequest) {
      const input = runtimeFenceRequest.parse(params);
      return exchange('docker.runtimeFence', 'ND-RUNTIME-FENCE ', input, value => runtimeFenceReply.parse(value), () => true);
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
  };
}
