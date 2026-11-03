import type { DB } from '@ninedeploy/db';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { validNodeCatcherName } from './nodeCatcherIdentity.js';
import { withRoutingAck } from './proxyRoutingAck.js';

const id = z.string().regex(/^[a-f0-9]{64}$/), time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ensured = z.object({ id, image: z.string().regex(/^sha256:[a-f0-9]{64}$/), created: z.boolean() }).strict();
const prepared = ensured.extend({ name: z.string().length(50).regex(/^ninedeploy-wake-g-[a-f0-9]{32}$/) }).strict();
const retirement = z.object({ id, name: z.string().max(50).refine(validNodeCatcherName), removed: z.boolean(), fenced: z.literal(true),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), requestId: z.string().length(32).regex(/^[a-f0-9]{32}$/),
  contentHash: z.string().length(64).regex(/^[a-f0-9]{64}$/) }).strict();
const demand = z.object({ catcherId: id, startedAt: z.string().max(128).refine(value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0),
  cursorMs: time, truncated: z.boolean(), items: z.array(z.object({ token: z.string().regex(/^[a-f0-9]{32}$/),
    count: z.number().int().positive().max(2000), lastAt: time }).strict()).max(2000),
}).strict().refine(reply => new Set(reply.items.map(item => item.token)).size === reply.items.length && reply.items.reduce((sum, item) => sum + item.count, 0) <= 2000, 'Invalid demand coverage');

/** One sealed, bounded exchange; no response text or node credential appears in errors. */
async function exchange(db: DB, nodeId: number, op: 'wake.demand' | 'wake.catcher.ensure' | 'wake.catcher.prepare' | 'wake.catcher.retire', params: Record<string, unknown>, parent?: AbortSignal, pinned = false) {
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0) throw new Error('Invalid wake node');
  const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(op === 'wake.demand' ? 25_000 : op === 'wake.catcher.retire' ? 40_000 : 80_000)]);
  signal.throwIfAborted();
  const sealed = await agentTransportSealed(db, nodeId, signal);
  signal.throwIfAborted();
  const refusal = await capabilityRefusal((operation, input, sink) => agentOp(db, nodeId, operation, input, sink, { signal, timeoutMs: 5000 }),
    `#${nodeId}`, sealed, { cap: op === 'wake.catcher.retire' ? ['wake.catcher.retire', 'proxy.orderedWrite', 'proxy.routingAck'] : pinned || op === 'wake.catcher.prepare' ? 'wake.catcher.prepare' : 'wake.catcher', feature: 'observe or recover the node wake catcher', sealedRequired: true });
  if (refusal) throw new Error(refusal.message);
  signal.throwIfAborted();
  const result = await agentOp(db, nodeId, op, params, () => undefined, { signal, timeoutMs: op === 'wake.demand' ? 15_000 : op === 'wake.catcher.retire' ? 35_000 : 65_000 });
  signal.throwIfAborted();
  const frames = result.lines.filter(line => line.startsWith('ND-WAKE-CATCHER '));
  if (result.exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 262_144) throw new Error('Node wake catcher receipt unavailable');
  try { return JSON.parse(frames[0]!.slice('ND-WAKE-CATCHER '.length)) as unknown; }
  catch { throw new Error('Node wake catcher receipt invalid'); }
}

export async function ensureNodeWakeCatcher(db: DB, nodeId: number, key: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid node wake credential');
  return ensured.parse(await exchange(db, nodeId, 'wake.catcher.ensure', { key }, signal));
}

/** Prepares a separate generation only; it grants no routing or retirement permission. */
export async function prepareNodeWakeCatcher(db: DB, nodeId: number, key: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid node wake credential');
  return prepared.parse(await exchange(db, nodeId, 'wake.catcher.prepare', { key }, signal));
}

/** Exact sealed retirement receipt; no raw routing text or wake credential is returned. */
export async function retireNodeWakeCatcher(db: DB, nodeId: number, target: { id: string; name: string },
  routing: { revision: number; requestId: string; content: string }, signal?: AbortSignal) {
  if (!id.safeParse(target.id).success || !validNodeCatcherName(target.name) || !Number.isSafeInteger(routing.revision) || routing.revision < 1 ||
    routing.requestId.length !== 32 || !/^[a-f0-9]{32}$/.test(routing.requestId) || typeof routing.content !== 'string' ||
    routing.content.includes('\0') || Buffer.byteLength(routing.content) > 1_048_576) throw new Error('Invalid wake retirement binding');
  let contentHash: string;
  try { contentHash = createHash('sha256').update(withRoutingAck(routing.content)).digest('hex'); }
  catch { throw new Error('Invalid wake retirement configuration'); }
  const reply = retirement.parse(await exchange(db, nodeId, 'wake.catcher.retire', { ...routing, timeoutMs: 30_000, target }, signal));
  if (reply.id !== target.id || reply.name !== target.name || reply.revision !== routing.revision || reply.requestId !== routing.requestId || reply.contentHash !== contentHash) {
    throw new Error('Node wake retirement receipt changed');
  }
  return reply;
}

/** Positive demand is valid only for the pinned catcher and a complete fresh log window. */
export async function readNodeWakeDemand(db: DB, nodeId: number, expectedCatcherId: string, sinceMs: number, signal?: AbortSignal, catcherName = 'ninedeploy-wake') {
  if (!id.safeParse(expectedCatcherId).success || !time.safeParse(sinceMs).success || !validNodeCatcherName(catcherName)) throw new Error('Invalid node wake demand binding');
  const pinned = catcherName !== 'ninedeploy-wake';
  const before = Date.now(), monotonic = performance.now();
  const reply = demand.parse(await exchange(db, nodeId, 'wake.demand', { sinceMs, ...(pinned ? { catcherId: expectedCatcherId } : {}) }, signal, pinned));
  const receivedAt = Date.now(), elapsed = performance.now() - monotonic;
  if (receivedAt < before || receivedAt - before >= 30_000 || elapsed < 0 || elapsed >= 30_000 || reply.catcherId !== expectedCatcherId || reply.truncated ||
    reply.cursorMs < sinceMs || reply.cursorMs > receivedAt + 5000 || Date.parse(reply.startedAt) > receivedAt + 5000 ||
    reply.items.some(item => item.lastAt < Math.max(Math.floor(sinceMs / 1000) * 1000, Date.parse(reply.startedAt)) || item.lastAt > reply.cursorMs || item.lastAt > receivedAt + 5000)) {
    throw new Error('Node wake demand is incomplete, stale or from another catcher');
  }
  return { ...reply, receivedAt };
}
