import { setTimeout as sleep } from 'node:timers/promises';
import { eq, services, type DB } from '@ninedeploy/db';
import { writeDynamicConfig } from '../engine/proxy.js';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { checkpointNodeAutoscale, type NodeAutoscaleAdmission } from './nodeAutoscaleAuthority.js';
import type { NodeAutoscaleControllerDeps } from './nodeAutoscaleController.js';
import { verifyNodeReadiness } from './nodeReadiness.js';
import { createNodeRuntimeMutationClient } from './nodeRuntimeMutationClient.js';

/** Bind the controller to sealed agent operations and confirmed node proxy routing. */
export function nodeAutoscaleRuntime(db: DB, admission: NodeAutoscaleAdmission,
  options: { signal?: AbortSignal; log?: (line: string) => void } = {}): NodeAutoscaleControllerDeps {
  const checkpoint = async () => {
    options.signal?.throwIfAborted();
    const service = await db.query.services.findFirst({ where: eq(services.id, admission.service.id) });
    if (!service || ![admission.service.runtimeReplicas, admission.desiredReplicas].includes(service.runtimeReplicas)) throw new Error('Node autoscale serving count changed');
    await checkpointNodeAutoscale(db, admission, service.runtimeReplicas);
    options.signal?.throwIfAborted();
  };
  const client = (serverId: number) => createNodeRuntimeMutationClient(db, serverId, { checkpoint, signal: options.signal });
  return {
    preflight: async serverId => {
      await checkpoint();
      const sealed = await agentTransportSealed(db, serverId, options.signal);
      const refusal = await capabilityRefusal(async (op, params, sink) => {
        await checkpoint();
        const result = await agentOp(db, serverId, op, params, sink, { signal: options.signal, timeoutMs: 5000 });
        await checkpoint(); return result;
      }, `#${serverId}`, sealed, { cap: ['docker.mutations', 'docker.retireHandoff'], feature: 'safely complete node autoscaling', sealedRequired: true });
      if (refusal) throw new Error(refusal.message);
    },
    fence: (serverId, input) => client(serverId).fence(input),
    inventory: (serverId, input) => client(serverId).inventory(input),
    start: (serverId, input) => client(serverId).start(input),
    stop: (serverId, input) => client(serverId).stop(input),
    retire: (serverId, input) => client(serverId).retire(input),
    handoff: (serverId, input) => client(serverId).legacyHandoff(input),
    ready: async (service, targets) => {
      const serverId = admission.service.serverId!;
      await checkpoint();
      const sealed = await agentTransportSealed(db, serverId, options.signal);
      const call = async (op: string, params: Record<string, unknown>, sink: (line: string) => void, timeoutMs = 15_000) => {
        await checkpoint();
        const result = await agentOp(db, serverId, op, params, sink, { signal: options.signal, timeoutMs });
        await checkpoint(); return result;
      };
      const refusal = await capabilityRefusal((op, params, sink) => call(op, params, sink, 5_000), `#${serverId}`, sealed,
        { cap: 'docker.readiness', feature: 'verify candidate replica readiness', sealedRequired: true });
      if (refusal) throw new Error(refusal.message);
      const mode = service.healthCheck;
      return verifyNodeReadiness((op, params, sink, opts) => call(op, params, sink, Math.min(15_000, opts?.timeoutMs ?? 15_000)),
        { targets: targets.map(({ id, name }) => ({ id, name })), port: service.port, path: service.healthPath || '/',
          mode: mode === 'running' || mode === 'command' || mode === 'http-strict' || mode === 'tcp' ? mode : service.port ? 'tcp' : 'auto' },
        Math.min(60_000, (service.healthTimeoutSeconds ?? 60) * 1000), checkpoint, options.log ?? (() => undefined));
    },
    route: async (_service, serverId) => {
      const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(60_000)]);
      const up = admission.desiredReplicas > admission.service.runtimeReplicas;
      await checkpoint();
      await writeDynamicConfig(db, { requireNode: serverId, confirmNodeRouting: true, confirmServiceId: admission.service.id, requireOrderedNode: true, signal,
        ...(up ? { autoscalePromotion: { serviceId: admission.service.id, workerToken: admission.workerToken,
          ownerEpoch: admission.owner.epoch, requestId: admission.owner.requestId! } } : {}) });
      await checkpoint();
    },
    drain: async () => { await sleep(2000, undefined, { signal: options.signal }); },
    ...options,
  };
}
