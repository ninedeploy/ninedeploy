import { randomBytes } from 'node:crypto';
import { eq, services, type DB, type Service } from '@ninedeploy/db';
import { idleWatchOpen, IDLE_WATCH_MIN_MS } from '@ninedeploy/schemas';
import { replicaNames } from '../engine/dockerNames.js';
import { renderDynamicConfig } from '../engine/proxy.js';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { openNodeIdleWatch } from './nodeIdleWatchClient.js';
import { readServiceRuntimeOwner, sameRuntimeOwner } from './serviceRuntimeOwner.js';
import { proxyTrafficUnavailable } from './proxyTrafficCounter.js';

/** Resolve normal node serving identities without requiring autoscale spare capacity. */
export async function openServiceNodeIdleWatch(db: DB, service: Service, signal: AbortSignal) {
  if (service.type !== 'docker' || service.orchestrator === 'swarm' || !service.serverId || service.status !== 'running' ||
    service.asleepAt != null || !service.runtimeId || !service.port || !Number.isSafeInteger(service.runtimeReplicas) || service.runtimeReplicas < 1 || service.runtimeReplicas > 10) {
    throw proxyTrafficUnavailable('node idle placement is not eligible');
  }
  const deploymentId = Number(/-([1-9]\d*)$/.exec(service.runtimeId)?.[1]);
  if (!Number.isSafeInteger(deploymentId) || deploymentId < 1 || service.runtimeId !== `${service.slug}-${deploymentId}`) throw proxyTrafficUnavailable('node idle generation is unconfirmed');
  const expected = JSON.stringify(service), owner = await readServiceRuntimeOwner(db, service.id);
  const checkpoint = async () => {
    signal.throwIfAborted();
    const fresh = await db.query.services.findFirst({ where: eq(services.id, service.id) });
    if (!fresh || JSON.stringify(fresh) !== expected || !sameRuntimeOwner(await readServiceRuntimeOwner(db, service.id), owner)) {
      throw proxyTrafficUnavailable('node idle runtime ownership or configuration changed');
    }
    signal.throwIfAborted();
  };
  const call = async (op: string, args: Record<string, unknown>, sink: (line: string) => void) => {
    await checkpoint();
    try { return await agentOp(db, service.serverId!, op, args, sink, { signal, timeoutMs: 5000 }); }
    finally { await checkpoint(); }
  };
  await checkpoint();
  const sealed = await agentTransportSealed(db, service.serverId, signal);
  await checkpoint();
  const refusal = await capabilityRefusal(call, `#${service.serverId}`, sealed,
    { cap: ['docker.recovery', 'proxy.idleWatch'], feature: 'observe continuous node idle coverage', sealedRequired: true });
  if (refusal) throw proxyTrafficUnavailable(refusal.message);
  const serving = await Promise.all(replicaNames(service.runtimeId, service.runtimeReplicas).map(async name => {
    const result = await call('docker.identity', { name }, () => undefined);
    const lines = result.lines.filter(line => line.startsWith('ND-CONTAINER '));
    if (result.exitCode !== 0 || lines.length !== 1 || Buffer.byteLength(lines[0]!) > 16_384) throw proxyTrafficUnavailable('node idle serving identity is unconfirmed');
    let identity: unknown;
    try { identity = JSON.parse(lines[0]!.slice('ND-CONTAINER '.length)); } catch { throw proxyTrafficUnavailable('node idle serving identity is malformed'); }
    const row = identity as Record<string, unknown> | null;
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) ||
      row.name !== name || row.managed !== 'service' || row.serviceId !== String(service.id) || row.deploymentId !== String(deploymentId)) {
      throw proxyTrafficUnavailable('node idle serving labels or identity changed');
    }
    return { name, id: row.id, port: service.port! };
  }));
  await checkpoint();
  const routingConfig = await renderDynamicConfig(db, { serverId: service.serverId });
  await checkpoint();
  const input = idleWatchOpen.parse({ purpose: 'idle', requestId: randomBytes(16).toString('hex'), nodeId: service.serverId,
    serviceId: service.id, deploymentId, slug: service.slug, durationMs: IDLE_WATCH_MIN_MS, routingConfig, serving });
  const window = await openNodeIdleWatch(db, input, { signal, checkpoint });
  return { ...window, input };
}
