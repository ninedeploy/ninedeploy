import { eq } from 'drizzle-orm';
import { services, deployments, type DB } from '@ninedeploy/db';
import { proxyTrafficOpen, proxyTrafficSnapshot, type ProxyTrafficOpen, type ProxyTrafficSnapshot } from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { proxyTrafficTargetHash, proxyTrafficRoutingGeneration, proxyTrafficUnavailable } from './proxyTrafficCounter.js';

/** Private controller adapter. The caller still owns deployment authorization/lease checks. */
export async function openNodeProxyTraffic(db: DB, params: ProxyTrafficOpen, options: { signal?: AbortSignal; checkpoint?: () => Promise<void> } = {}) {
  const input = proxyTrafficOpen.parse(params), targetHash = proxyTrafficTargetHash(input), routingGeneration = proxyTrafficRoutingGeneration(input);
  const current = async () => {
    options.signal?.throwIfAborted(); await options.checkpoint?.();
    const [service, deployment] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, input.serviceId) }),
      db.query.deployments.findFirst({ where: eq(deployments.id, input.deploymentId) }),
    ]);
    if (!service || service.type !== 'docker' || service.serverId !== input.nodeId || service.slug !== input.slug ||
      service.orchestrator === 'swarm' || service.status === 'stopped' ||
      !input.stable.some(target => target.name === service.runtimeId || target.id === service.runtimeId) ||
      !deployment || deployment.serviceId !== input.serviceId || ['failed', 'cancelled', 'running'].includes(deployment.status) || deployment.finishedAt != null) {
      throw proxyTrafficUnavailable('deployment placement or ownership changed');
    }
  };
  await current();
  const refusal = await capabilityRefusal((op, args, sink) => agentOp(db, input.nodeId, op, args, sink, { signal: options.signal, timeoutMs: 5000 }), `#${input.nodeId}`,
    await agentTransportSealed(db, input.nodeId), { cap: 'proxy.traffic', feature: 'observe proxy traffic', sealedRequired: true });
  options.signal?.throwIfAborted();
  if (refusal) throw proxyTrafficUnavailable(refusal.message);

  const rpc = async (op: string, args: Record<string, unknown>, useSignal = true): Promise<any> => {
    const result = await agentOp(db, input.nodeId, op, args, () => undefined, { timeoutMs: useSignal ? 20_000 : 2000, ...(useSignal ? { signal: options.signal } : {}) });
    const lines = result.lines.filter(line => line.startsWith('ND-PROXY-TRAFFIC '));
    if (result.exitCode !== 0 || lines.length !== 1 || lines[0]!.length > 64 * 1024) throw proxyTrafficUnavailable('node receipt was not confirmed');
    try { return JSON.parse(lines[0]!.slice('ND-PROXY-TRAFFIC '.length)); } catch { throw proxyTrafficUnavailable('node receipt was not confirmed'); }
  };
  const bind = (raw: unknown): ProxyTrafficSnapshot => {
    const snapshot = proxyTrafficSnapshot.parse(raw);
    if (snapshot.requestId !== input.requestId || snapshot.targetHash !== targetHash || snapshot.nodeId !== input.nodeId ||
      snapshot.serviceId !== input.serviceId || snapshot.deploymentId !== input.deploymentId || snapshot.step !== input.step || snapshot.routingGeneration !== routingGeneration) {
      throw proxyTrafficUnavailable('receipt belongs to a different observation');
    }
    return snapshot;
  };
  const opened = await rpc('proxy.traffic.open', input);
  if (opened?.kind !== 'open') throw proxyTrafficUnavailable('open receipt was not confirmed');
  const initial = bind(opened.snapshot);
  if (initial.complete || initial.endCounter !== null) throw proxyTrafficUnavailable('reservation was already completed');
  let last = initial, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await rpc('proxy.traffic.close', { windowId: initial.windowId }, false); } catch { /* the bounded agent idle expiry is the backstop */ }
  };
  try { await current(); } catch (err) { await close(); throw err; }
  const verify = (raw: unknown, complete: boolean) => {
    const next = bind(raw);
    if (next.windowId !== initial.windowId || next.sourceId !== initial.sourceId || next.proxyId !== initial.proxyId || next.epoch !== initial.epoch ||
      next.startCounter !== initial.startCounter || next.elapsedMs < last.elapsedMs || next.complete !== complete ||
      (!complete && next.endCounter !== null) || next.observed < last.observed || next.canary.requests < last.canary.requests ||
      next.canary.errors < last.canary.errors || next.stable.requests < last.stable.requests || next.stable.errors < last.stable.errors ||
      (complete && next.elapsedMs < input.durationMs)) throw proxyTrafficUnavailable('source or observation coverage changed');
    last = next; return next;
  };
  return {
    receipt: initial,
    sample: async () => {
      if (closed) throw proxyTrafficUnavailable('window closed');
      try {
        await current(); const reply = await rpc('proxy.traffic.sample', { windowIds: [initial.windowId] }); await current();
        if (reply?.kind !== 'sample' || !Array.isArray(reply.items) || reply.items.length !== 1 || reply.items[0]?.ok !== true) throw proxyTrafficUnavailable('node observation unavailable');
        return verify(reply.items[0].snapshot, false);
      } catch (err) { await close(); throw err; }
    },
    finish: async () => {
      if (closed) throw proxyTrafficUnavailable('window closed');
      try {
        await current(); const reply = await rpc('proxy.traffic.finish', { windowId: initial.windowId }); await current();
        if (reply?.kind !== 'finish') throw proxyTrafficUnavailable('final receipt was not confirmed');
        return verify(reply.snapshot, true);
      } catch (err) { await close(); throw err; }
    },
    close,
  };
}
