import { eq, services, type DB, type Service } from '@ninedeploy/db';
import { autoscaleConfig } from '@ninedeploy/schemas';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { readNodeContainerMetrics } from './nodeContainerMetrics.js';

const snapshot = (service: Service) => JSON.stringify([service.id, service.slug, service.type, service.serverId, service.orchestrator,
  service.status, service.asleepAt, service.runtimeId, service.runtimeReplicas, service.autoscale, service.cpuLimitMilli, service.memLimitMb]);

/** Read node-only resource evidence for the exact current serving generation. */
export async function readNodeAutoscaleSample(db: DB, service: Service, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const timeout = options.timeoutMs ?? 15_000;
  const count = service.runtimeReplicas, serverId = service.serverId;
  const deploymentId = Number(/-([1-9]\d*)$/.exec(service.runtimeId ?? '')?.[1]);
  if (service.type !== 'docker' || service.orchestrator === 'swarm' || !serverId || service.status !== 'running' || service.asleepAt != null ||
    !service.runtimeId || service.runtimeId !== `${service.slug}-${deploymentId}` || !Number.isSafeInteger(deploymentId) || deploymentId < 1 ||
    !Number.isSafeInteger(count) || count < 1 || count > MAX_REPLICAS || !autoscaleConfig.safeParse(service.autoscale).success ||
    !Number.isFinite(timeout) || timeout < 1 || timeout > 15_000) throw new Error('Node autoscale sample placement or deadline is invalid');
  const expected = snapshot(service), deadline = Date.now() + timeout;
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.ceil(timeout))]);
  const checkpoint = async () => {
    signal.throwIfAborted();
    const fresh = await db.query.services.findFirst({ where: eq(services.id, service.id) });
    if (!fresh || snapshot(fresh) !== expected) throw new Error('Node autoscale service changed during measurement');
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Node autoscale measurement deadline exceeded');
  };
  const call = async (op: string, params: Record<string, unknown>, sink: (line: string) => void) => {
    await checkpoint();
    try {
      return await agentOp(db, serverId, op, params, sink, { signal, timeoutMs: Math.max(1, deadline - Date.now()) });
    } finally {
      await checkpoint();
    }
  };
  await checkpoint();
  const sealed = await agentTransportSealed(db, serverId, signal);
  await checkpoint();
  const refusal = await capabilityRefusal(call, `#${serverId}`, sealed,
    { cap: 'docker.recovery', feature: 'identify node autoscale replicas', sealedRequired: true });
  if (refusal) throw new Error(refusal.message);
  const targets = await Promise.all(replicaNames(service.runtimeId, count).map(async name => {
    const reply = await call('docker.identity', { name }, () => {});
    const lines = reply.lines.filter(line => line.startsWith('ND-CONTAINER '));
    if (reply.exitCode !== 0 || lines.length !== 1 || Buffer.byteLength(lines[0]!) > 16_384) throw new Error('Node autoscale replica identity is unconfirmed');
    const identity: unknown = JSON.parse(lines[0]!.slice(13));
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('Node autoscale replica identity is unconfirmed');
    const row = identity as Record<string, unknown>;
    if (typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) || row.name !== name || row.managed !== 'service' ||
      row.serviceId !== String(service.id) || row.deploymentId !== String(deploymentId)) throw new Error('Node autoscale replica identity is unconfirmed');
    return { id: row.id, name };
  }));
  if (new Set(targets.map(target => target.id)).size !== targets.length) throw new Error('Node autoscale replica identities are duplicated');
  await checkpoint();
  return readNodeContainerMetrics(db, serverId, { serviceId: service.id, deploymentId, targets },
    { checkpoint, signal, timeoutMs: Math.max(1, deadline - Date.now()) });
}
