import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';
import { ensureNodeWakeCatcher, inventoryNodeWakeCatchers, prepareNodeWakeCatcher, readNodeWakeDemand, retireNodeWakeCatcher } from '../../src/lib/nodeWakeCatcherClient.js';
import { createHash } from 'node:crypto';
import { withRoutingAck } from '../../src/lib/proxyRoutingAck.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
const db = {} as DB, catcher = 'c'.repeat(64), token = 'a'.repeat(32), key = 'd'.repeat(64);
let reply: Record<string, unknown>, caps: string[], exitCode: number, raw: string[] | undefined;
const since = () => Date.now() - 10_000;
beforeEach(() => {
  caps = ['wake.catcher']; exitCode = 0; raw = undefined;
  reply = { catcherId: catcher, startedAt: new Date(Date.now() - 60_000).toISOString(), cursorMs: Date.now(), truncated: false,
    items: [{ token, count: 2, lastAt: Date.now() }] };
  io.sealed.mockReset().mockResolvedValue(true); io.agent.mockReset().mockImplementation(async (_db, node, op) => {
    expect(node).toBe(4);
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
    return { exitCode, lines: raw ?? [`ND-WAKE-CATCHER ${JSON.stringify(reply)}`] };
  });
});
afterEach(() => vi.restoreAllMocks());
it('requires explicit sealed inventory support and refuses duplicate or incomplete discovery', async () => {
  await expect(inventoryNodeWakeCatchers(db, 4, key)).rejects.toThrow();
  expect(io.agent.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  caps.push('wake.catcher.inventory');
  const item = { id: catcher, name: `ninedeploy-wake-g-${'b'.repeat(32)}`, image: `sha256:${'f'.repeat(64)}` };
  reply = { items: [item] }; expect(await inventoryNodeWakeCatchers(db, 4, key)).toEqual([item]);
  reply = { items: [item, item] }; await expect(inventoryNodeWakeCatchers(db, 4, key)).rejects.toThrow();
  reply = {}; await expect(inventoryNodeWakeCatchers(db, 4, key)).rejects.toThrow();
  io.sealed.mockResolvedValue(false); reply = { items: [] };
  await expect(inventoryNodeWakeCatchers(db, 4, key)).rejects.toThrow();
});
it('accepts complete fresh demand bound to the pinned catcher and returns its panel receipt time', async () => {
  const before = Date.now(), result = await readNodeWakeDemand(db, 4, catcher, since());
  expect(result.items).toEqual(reply.items); expect(result.receivedAt).toBeGreaterThanOrEqual(before);
  expect(io.agent.mock.calls.at(-1)![2]).toBe('wake.demand');
  expect(io.agent.mock.calls.at(-1)![5].timeoutMs).toBe(15_000);
});
it('pins prepared-generation demand by immutable ID and refuses agents without the new protocol', async () => {
  const name = `ninedeploy-wake-g-${'b'.repeat(32)}`, start = since();
  await expect(readNodeWakeDemand(db, 4, catcher, start, undefined, name)).rejects.toThrow();
  expect(io.agent.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  caps.push('wake.catcher.prepare'); io.agent.mockClear();
  expect((await readNodeWakeDemand(db, 4, catcher, start, undefined, name)).catcherId).toBe(catcher);
  expect(io.agent.mock.calls.at(-1)![3]).toEqual({ sinceMs: start, catcherId: catcher });
  for (const invalid of ['other', `${name}\n`]) await expect(readNodeWakeDemand(db, 4, catcher, start, undefined, invalid)).rejects.toThrow();
});
it('ensures a catcher only through a sealed capability-checked exchange with a valid credential', async () => {
  reply = { id: catcher, image: `sha256:${'f'.repeat(64)}`, created: true };
  expect(await ensureNodeWakeCatcher(db, 4, key)).toEqual(reply);
  expect(io.agent.mock.calls.at(-1)![3]).toEqual({ key });
  io.agent.mockClear(); await expect(ensureNodeWakeCatcher(db, 4, 'bad')).rejects.toThrow(); expect(io.agent).not.toHaveBeenCalled();
});
it('retires only through the new sealed capability and binds the receipt to identity and ordered routing', async () => {
  const target = { id: catcher, name: 'ninedeploy-wake' }, routing = { revision: 2, requestId: 'e'.repeat(32), content: 'http: {}\n' };
  reply = { ...target, fenced: true, removed: true, revision: routing.revision, requestId: routing.requestId,
    contentHash: createHash('sha256').update(withRoutingAck(routing.content)).digest('hex') };
  await expect(retireNodeWakeCatcher(db, 4, target, routing)).rejects.toThrow();
  expect(io.agent.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  caps.push('wake.catcher.retire', 'proxy.orderedWrite', 'proxy.routingAck'); io.agent.mockClear();
  expect(await retireNodeWakeCatcher(db, 4, target, routing)).toEqual(reply);
  expect(io.agent.mock.calls.at(-1)![3]).toEqual({ ...routing, timeoutMs: 30_000, target });
  for (const changed of [{ id: 'f'.repeat(64) }, { name: `ninedeploy-wake-g-${'f'.repeat(32)}` }, { revision: 3 }, { contentHash: '0'.repeat(64) }, { fenced: false }]) {
    const correct = { ...reply }; Object.assign(reply, changed);
    await expect(retireNodeWakeCatcher(db, 4, target, routing)).rejects.toThrow(); reply = correct;
  }
});
it('requires the separate preparation capability and a generation name rather than a legacy ensure receipt', async () => {
  reply = { id: catcher, name: `ninedeploy-wake-g-${'b'.repeat(32)}`, image: `sha256:${'f'.repeat(64)}`, created: true };
  await expect(prepareNodeWakeCatcher(db, 4, key)).rejects.toThrow();
  expect(io.agent.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  caps.push('wake.catcher.prepare'); io.agent.mockClear();
  expect(await prepareNodeWakeCatcher(db, 4, key)).toEqual(reply);
  expect(io.agent.mock.calls.at(-1)![2]).toBe('wake.catcher.prepare');
  expect(io.agent.mock.calls.at(-1)![3]).toEqual({ key });
  for (const name of ['ninedeploy-wake', 'another-container', 'ninedeploy-wake-g-bad', undefined]) {
    reply.name = name; await expect(prepareNodeWakeCatcher(db, 4, key)).rejects.toThrow();
  }
});
it('never prepares over plaintext or after cancellation and validates the credential before I/O', async () => {
  caps.push('wake.catcher.prepare'); io.sealed.mockResolvedValue(false);
  await expect(prepareNodeWakeCatcher(db, 4, key)).rejects.toThrow();
  expect(io.agent.mock.calls.some(call => call[2] === 'wake.catcher.prepare')).toBe(false);
  io.agent.mockClear(); io.sealed.mockClear();
  await expect(prepareNodeWakeCatcher(db, 4, 'bad')).rejects.toThrow();
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await expect(prepareNodeWakeCatcher(db, 4, key, abort.signal)).rejects.toThrow('cancelled');
  expect(io.agent).not.toHaveBeenCalled(); expect(io.sealed).not.toHaveBeenCalled();
});
it.each(['foreign', 'truncated', 'cursor regression', 'future cursor', 'future item', 'before process', 'duplicates', 'oversized count'] as const)('refuses %s demand', async kind => {
  const start = since();
  if (kind === 'foreign') reply.catcherId = 'e'.repeat(64);
  if (kind === 'truncated') reply.truncated = true;
  if (kind === 'cursor regression') reply.cursorMs = start - 1;
  if (kind === 'future cursor') reply.cursorMs = Date.now() + 60_000;
  if (kind === 'future item') reply.items = [{ token, count: 1, lastAt: Date.now() + 60_000 }];
  if (kind === 'before process') { reply.startedAt = new Date(Date.now() - 1000).toISOString(); reply.items = [{ token, count: 1, lastAt: Date.now() - 2000 }]; }
  if (kind === 'duplicates') reply.items = [reply.items as unknown[], reply.items as unknown[]].flat();
  if (kind === 'oversized count') reply.items = [{ token, count: 2001, lastAt: Date.now() }];
  await expect(readNodeWakeDemand(db, 4, catcher, start)).rejects.toThrow();
});
it.each(['missing', 'multiple', 'malformed', 'failed'] as const)('refuses a %s receipt without interpreting it as no demand', async kind => {
  if (kind === 'missing') raw = [];
  if (kind === 'multiple') raw = [`ND-WAKE-CATCHER ${JSON.stringify(reply)}`, `ND-WAKE-CATCHER ${JSON.stringify(reply)}`];
  if (kind === 'malformed') raw = ['ND-WAKE-CATCHER {'];
  if (kind === 'failed') exitCode = 1;
  await expect(readNodeWakeDemand(db, 4, catcher, since())).rejects.toThrow();
});
it('refuses missing capability, unsealed transport and pre-cancelled discovery before reading demand', async () => {
  caps = []; await expect(readNodeWakeDemand(db, 4, catcher, since())).rejects.toThrow();
  expect(io.agent.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  io.agent.mockClear(); io.sealed.mockResolvedValue(false);
  await expect(readNodeWakeDemand(db, 4, catcher, since())).rejects.toThrow();
  expect(io.agent.mock.calls.some(call => call[2] === 'wake.demand')).toBe(false);
  io.agent.mockClear(); io.sealed.mockClear(); const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await expect(readNodeWakeDemand(db, 4, catcher, since(), abort.signal)).rejects.toThrow('cancelled');
  expect(io.sealed).not.toHaveBeenCalled(); expect(io.agent).not.toHaveBeenCalled();
});
it('rejects a reply delayed beyond the demand freshness budget', async () => {
  const start = since(), now = Date.now(), original = io.agent.getMockImplementation()!;
  io.agent.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[2] === 'wake.demand') vi.spyOn(Date, 'now').mockReturnValue(now + 30_001);
    return result;
  });
  await expect(readNodeWakeDemand(db, 4, catcher, start)).rejects.toThrow(/stale/);
});
it('discards an otherwise valid reply when cancellation arrives during the exchange', async () => {
  const abort = new AbortController(), original = io.agent.getMockImplementation()!;
  io.agent.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[2] === 'wake.demand') abort.abort(new Error('cancelled'));
    return result;
  });
  await expect(readNodeWakeDemand(db, 4, catcher, since(), abort.signal)).rejects.toThrow('cancelled');
});
