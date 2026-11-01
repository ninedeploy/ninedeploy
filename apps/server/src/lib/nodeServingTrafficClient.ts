import type { DB } from '@ninedeploy/db';
import { servingTrafficOpen, servingTrafficSnapshot, type ServingTrafficOpen, type ServingTrafficSnapshot } from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { nodeServingTrafficContext } from './nodeServingTrafficContext.js';
import { proxyTrafficTargetHash, proxyTrafficRoutingGeneration, proxyTrafficUnavailable } from './proxyTrafficCounter.js';

/** Private panel transport. RPS decisions remain gated until controller acceptance. */
export async function openNodeServingTraffic(db: DB, params: ServingTrafficOpen, options: { signal?: AbortSignal; checkpoint?: () => Promise<void> } = {}) {
  const input = servingTrafficOpen.parse(params), targetHash = proxyTrafficTargetHash(input), routingGeneration = proxyTrafficRoutingGeneration(input);
  const deadline = AbortSignal.timeout(input.durationMs + 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let context: string | undefined;
  const current = async () => {
    signal.throwIfAborted(); await options.checkpoint?.();
    const next = await nodeServingTrafficContext(db, input);
    signal.throwIfAborted();
    if (context !== undefined && next !== context) throw proxyTrafficUnavailable('serving runtime context changed');
    context = next;
  };
  await current();
  const refusal = await capabilityRefusal((op, args, sink) => agentOp(db, input.nodeId, op, args, sink, { signal, timeoutMs: 5000 }), `#${input.nodeId}`,
    await agentTransportSealed(db, input.nodeId), { cap: 'proxy.servingTraffic', feature: 'observe serving traffic', sealedRequired: true });
  await current();
  if (refusal) throw proxyTrafficUnavailable(refusal.message);
  const rpc = async (op: string, args: Record<string, unknown>, cleanup = false): Promise<unknown> => {
    const result = await agentOp(db, input.nodeId, `proxy.servingTraffic.${op}`, args, () => undefined,
      cleanup ? { timeoutMs: 2000 } : { timeoutMs: 20_000, signal });
    const lines = result.lines.filter(line => line.startsWith('ND-SERVING-TRAFFIC '));
    if (result.exitCode !== 0 || lines.length !== 1 || Buffer.byteLength(lines[0]!) > 64 * 1024) throw proxyTrafficUnavailable('node receipt was not confirmed');
    try { return JSON.parse(lines[0]!.slice('ND-SERVING-TRAFFIC '.length)); } catch { throw proxyTrafficUnavailable('node receipt was not confirmed'); }
  };
  const bind = (raw: unknown): ServingTrafficSnapshot => {
    const snapshot = servingTrafficSnapshot.parse(raw);
    if (snapshot.requestId !== input.requestId || snapshot.targetHash !== targetHash || snapshot.nodeId !== input.nodeId ||
      snapshot.serviceId !== input.serviceId || snapshot.deploymentId !== input.deploymentId || snapshot.routingGeneration !== routingGeneration) {
      throw proxyTrafficUnavailable('receipt belongs to a different observation');
    }
    return snapshot;
  };
  const opened = await rpc('open', input) as { kind?: unknown; snapshot?: unknown };
  if (opened?.kind !== 'open') throw proxyTrafficUnavailable('open receipt was not confirmed');
  const initial = bind(opened.snapshot);
  let last = initial, closed = false, busy = false, closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true; signal.removeEventListener('abort', onAbort);
    closing = rpc('close', { windowId: initial.windowId }, true).then(() => undefined, () => undefined);
    return closing;
  };
  const onAbort = () => { void close(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (initial.complete || initial.endCounter !== null) throw proxyTrafficUnavailable('reservation was already completed');
    await current();
  } catch (err) { await close(); throw err; }
  const observe = async (finish: boolean): Promise<ServingTrafficSnapshot> => {
    if (closed || busy) throw proxyTrafficUnavailable(closed ? 'window closed' : 'observation already in progress');
    busy = true;
    try {
      await current();
      const reply = await rpc(finish ? 'finish' : 'sample', finish ? { windowId: initial.windowId } : { windowIds: [initial.windowId] }) as {
        kind?: unknown; snapshot?: unknown; items?: Array<{ ok?: unknown; snapshot?: unknown }>;
      };
      await current();
      if (closed) throw proxyTrafficUnavailable('window closed');
      if (finish ? reply?.kind !== 'finish' : reply?.kind !== 'sample' || !Array.isArray(reply.items) || reply.items.length !== 1 || reply.items[0]?.ok !== true) {
        throw proxyTrafficUnavailable('node observation unavailable');
      }
      const next = bind(finish ? reply.snapshot : reply.items![0]!.snapshot);
      if (next.windowId !== initial.windowId || next.sourceId !== initial.sourceId || next.proxyId !== initial.proxyId || next.epoch !== initial.epoch ||
        next.startCounter !== initial.startCounter || next.elapsedMs < last.elapsedMs || next.complete !== finish ||
        (!finish && next.endCounter !== null) || next.observed < last.observed || next.serving.requests < last.serving.requests ||
        next.serving.errors < last.serving.errors || (finish && next.elapsedMs < input.durationMs)) {
        throw proxyTrafficUnavailable('source or observation coverage changed');
      }
      last = next;
      if (finish) { await close(); await current(); }
      return structuredClone(next);
    } catch (err) { await close(); throw err; } finally { busy = false; }
  };
  return { receipt: structuredClone(initial), sample: () => observe(false), finish: () => observe(true), close };
}
