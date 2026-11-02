import type { DB } from '@ninedeploy/db';
import { z } from 'zod';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';

const id = z.string().regex(/^[a-f0-9]{64}$/), time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ensured = z.object({ id, image: z.string().regex(/^sha256:[a-f0-9]{64}$/), created: z.boolean() }).strict();
const demand = z.object({ catcherId: id, startedAt: z.string().max(128).refine(value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0),
  cursorMs: time, truncated: z.boolean(), items: z.array(z.object({ token: z.string().regex(/^[a-f0-9]{32}$/),
    count: z.number().int().positive().max(2000), lastAt: time }).strict()).max(2000),
}).strict().refine(reply => new Set(reply.items.map(item => item.token)).size === reply.items.length && reply.items.reduce((sum, item) => sum + item.count, 0) <= 2000, 'Invalid demand coverage');

/** One sealed, bounded exchange; no response text or node credential appears in errors. */
async function exchange(db: DB, nodeId: number, op: 'wake.demand' | 'wake.catcher.ensure', params: Record<string, unknown>, parent?: AbortSignal) {
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0) throw new Error('Invalid wake node');
  const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(op === 'wake.demand' ? 25_000 : 80_000)]);
  signal.throwIfAborted();
  const sealed = await agentTransportSealed(db, nodeId, signal);
  signal.throwIfAborted();
  const refusal = await capabilityRefusal((operation, input, sink) => agentOp(db, nodeId, operation, input, sink, { signal, timeoutMs: 5000 }),
    `#${nodeId}`, sealed, { cap: 'wake.catcher', feature: 'observe or recover the node wake catcher', sealedRequired: true });
  if (refusal) throw new Error(refusal.message);
  signal.throwIfAborted();
  const result = await agentOp(db, nodeId, op, params, () => undefined, { signal, timeoutMs: op === 'wake.demand' ? 15_000 : 65_000 });
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

/** Positive demand is valid only for the pinned catcher and a complete fresh log window. */
export async function readNodeWakeDemand(db: DB, nodeId: number, expectedCatcherId: string, sinceMs: number, signal?: AbortSignal) {
  if (!id.safeParse(expectedCatcherId).success || !time.safeParse(sinceMs).success) throw new Error('Invalid node wake demand binding');
  const before = Date.now(), monotonic = performance.now();
  const reply = demand.parse(await exchange(db, nodeId, 'wake.demand', { sinceMs }, signal));
  const receivedAt = Date.now(), elapsed = performance.now() - monotonic;
  if (receivedAt < before || receivedAt - before >= 30_000 || elapsed < 0 || elapsed >= 30_000 || reply.catcherId !== expectedCatcherId || reply.truncated ||
    reply.cursorMs < sinceMs || reply.cursorMs > receivedAt + 5000 || Date.parse(reply.startedAt) > receivedAt + 5000 ||
    reply.items.some(item => item.lastAt < Math.max(Math.floor(sinceMs / 1000) * 1000, Date.parse(reply.startedAt)) || item.lastAt > reply.cursorMs || item.lastAt > receivedAt + 5000)) {
    throw new Error('Node wake demand is incomplete, stale or from another catcher');
  }
  return { ...reply, receivedAt };
}
