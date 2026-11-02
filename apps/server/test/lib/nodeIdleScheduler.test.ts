import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Service } from '@ninedeploy/db';
import { idleWatchOpen, type IdleWatchOpen } from '@ninedeploy/schemas';
import { NodeIdleWatch } from '../../src/lib/nodeIdleWatch.js';
import { createNodeIdleScheduler } from '../../src/lib/nodeIdleScheduler.js';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';

let f: Awaited<ReturnType<typeof servingReceiptFixture>>, service: Service, rows: Service[], clock: number, sequence: number, nonce: number, source: string;
let engine: NodeIdleWatch, scheduler: ReturnType<typeof createNodeIdleScheduler>;
const readers = new Set<(line: string) => void>();
const errors: unknown[] = [];
const emit = (path: string, router = '-', upstream = '-', status = 404) => {
  const id = ++sequence;
  for (const line of readers) line(`127.0.0.1 - - [02/Nov/2026:12:00:00 +0000] "GET ${path} HTTP/1.1" ${status} 0 "-" "-" ${id} "${router}" "${upstream}" 1ms`);
};
const requests: IdleWatchOpen[] = [];
const open = async (svc: Service, signal: AbortSignal) => {
  signal.throwIfAborted();
  const input = idleWatchOpen.parse({ purpose: 'idle', requestId: (++nonce).toString(16).padStart(32, '0'), nodeId: svc.serverId,
    serviceId: svc.id, deploymentId: 9, slug: svc.slug, durationMs: 60_000, routingConfig: 'http: {}',
    serving: [{ name: svc.runtimeId, id: 'a'.repeat(64), port: svc.port }] });
  requests.push(input);
  const beforeOpen = clock, receipt = await engine.open(input), afterOpen = clock;
  const close = async () => { engine.close({ windowId: receipt.windowId }); };
  signal.addEventListener('abort', () => void close(), { once: true });
  return { input, receipt, beforeOpen, afterOpen, context: JSON.stringify(svc), close,
    sample: async () => {
      const result = (await engine.sample({ windowIds: [receipt.windowId] }))[0]!;
      if (!result.ok) throw new Error(result.reason); return result.snapshot;
    },
    finish: () => engine.finish({ windowId: receipt.windowId }),
  };
};
const advance = async (ms = 15_000) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); await scheduler.tick(); };
beforeEach(async () => {
  f = await servingReceiptFixture('file::memory:');
  service = { ...(await f.c.db.query.services.findFirst())!, sleepAfterMinutes: 5 };
  rows = [service]; clock = 0; nonce = sequence = 0; source = 'e'.repeat(64); requests.length = 0; errors.length = 0;
  vi.useFakeTimers();
  engine = new NodeIdleWatch({ inspect: async () => ({ proxyId: 'f'.repeat(64), sourceId: source }),
    connect: (_proxy, line) => { readers.add(line); return { ready: Promise.resolve(), close: () => readers.delete(line) }; },
    heartbeat: async (_proxy, path) => emit(path),
  }, () => clock);
  scheduler = createNodeIdleScheduler({ load: async () => rows, open, now: () => clock, onError: error => errors.push(error) });
});
afterEach(async () => { await scheduler.close(); engine.closeAll(); expect(readers.size).toBe(0); vi.clearAllTimers(); vi.useRealTimers(); f.c.client?.close(); });

it('samples within the lease and proves five continuous idle minutes through overlapping windows', async () => {
  await scheduler.tick(); expect(scheduler.status(service)).toMatchObject({ idleMs: null, idleSatisfied: false });
  for (let tick = 0; tick < 20; tick++) await advance();
  // At five panel minutes the last completed window only proves 285 s.
  // The still-open tail cannot authorize sleep until its end marker is verified.
  expect(scheduler.status(service)).toMatchObject({ idleMs: 285_000, requiredMs: 300_000, idleSatisfied: false });
  await advance(); expect(scheduler.status(service)).toMatchObject({ idleMs: 315_000, idleSatisfied: true });
  expect(errors).toEqual([]); expect(readers.size).toBeLessThanOrEqual(2);
  expect(requests.length).toBeGreaterThan(2);
});
it('does not confuse unrelated proxy requests with serving traffic', async () => {
  await scheduler.tick();
  for (let tick = 0; tick < 4; tick++) { emit('/other', 'other_1@file', 'http://other:3000', 200); await advance(); }
  expect(scheduler.status(service)).toMatchObject({ idleMs: 60_000, idleSatisfied: false });
});
it('discards completed idle history and both windows when one serving request arrives', async () => {
  await scheduler.tick(); for (let tick = 0; tick < 5; tick++) await advance();
  expect(scheduler.status(service)?.idleMs).toBeGreaterThan(0);
  emit('/active', 'web_1@file', 'http://web-9:3000', 200); await advance();
  expect(scheduler.status(service)).toMatchObject({ idleMs: 0, idleSatisfied: false, holding: expect.stringMatching(/traffic/) });
  expect(readers.size).toBe(0); await advance(); expect(scheduler.status(service)?.idleMs).toBeNull();
});
it('never keeps usable idle evidence after a lapsed lease', async () => {
  await scheduler.tick(); for (let tick = 0; tick < 4; tick++) await advance();
  clock += 30_000; await vi.advanceTimersByTimeAsync(30_000);
  expect(scheduler.status(service)).toMatchObject({ idleMs: null, idleSatisfied: false, holding: expect.stringMatching(/lease/) });
  await scheduler.tick(); expect(scheduler.status(service)?.idleMs).toBeNull();
  expect(readers.size).toBe(1);
});
it('resets coverage on proxy source loss and refuses unavailable coverage as zero', async () => {
  await scheduler.tick(); for (let tick = 0; tick < 4; tick++) await advance();
  source = '0'.repeat(64); await advance();
  expect(scheduler.status(service)).toMatchObject({ idleMs: null, idleSatisfied: false }); expect(readers.size).toBe(0);
  expect(errors).toHaveLength(1);
});
it.each([{ runtimeReplicas: 2 }, { sleepAfterMinutes: 10 }, { port: 4000 }])('restarts the watch for a changed generation/configuration: %j', async patch => {
  await scheduler.tick(); await advance(); service = { ...service, ...patch }; rows = [service]; await scheduler.tick();
  expect(scheduler.status(service)).toMatchObject({ idleMs: null, idleSatisfied: false }); expect(readers.size).toBe(1);
});
it.each([{ status: 'stopped' }, { asleepAt: new Date() }, { serverId: null }, { orchestrator: 'swarm' }, { sleepAfterMinutes: null }])('closes windows when the service leaves the eligible set: %j', async patch => {
  await scheduler.tick(); rows = [{ ...service, ...patch } as Service]; await scheduler.tick();
  expect(scheduler.status(service)).toBeNull(); expect(readers.size).toBe(0);
});
it('discards all watches when loading current state fails', async () => {
  await scheduler.close(); let fail = false;
  scheduler = createNodeIdleScheduler({ load: async () => { if (fail) throw new Error('database unavailable'); return rows; }, open, now: () => clock });
  await scheduler.tick(); fail = true; await scheduler.tick(); expect(scheduler.status(service)).toBeNull(); expect(readers.size).toBe(0);
});
it('does not resurrect a late opening reply after shutdown', async () => {
  await scheduler.close(); const pending = Promise.withResolvers<Awaited<ReturnType<typeof open>>>();
  scheduler = createNodeIdleScheduler({ load: async () => rows, open: () => pending.promise, now: () => clock });
  const tick = scheduler.tick(); await vi.waitFor(() => expect(scheduler.status(service)).not.toBeNull());
  const close = scheduler.close(); const returned = await open(service, new AbortController().signal); pending.resolve(returned);
  await tick; await close; expect(readers.size).toBe(0); expect(scheduler.status(service)).toBeNull();
});
it('does not let an in-flight slow service block another service lease tick', async () => {
  await scheduler.close(); const pending = Promise.withResolvers<Awaited<ReturnType<typeof open>>>();
  const other = { ...service, id: 2, slug: 'other', runtimeId: 'other-9' }; rows = [service, other];
  scheduler = createNodeIdleScheduler({ load: async () => rows, open: (svc, signal) => svc.id === 1 ? pending.promise : open(svc, signal), now: () => clock });
  const first = scheduler.tick(); await vi.waitFor(() => expect(readers.size).toBe(1));
  await advance(); await advance(); expect(readers.size).toBe(2); // Other service opened its overlapping successor.
  const stop = scheduler.close(); pending.resolve(await open(service, new AbortController().signal)); await first; await stop;
  expect(readers.size).toBe(0);
});
it('reserves successor capacity so full agents can still complete and chain windows', async () => {
  rows = Array.from({ length: 9 }, (_, index) => ({ ...service, id: index + 1, slug: `svc${index + 1}`, runtimeId: `svc${index + 1}-9` }));
  await scheduler.tick(); expect(readers.size).toBe(8);
  expect(scheduler.status(rows[8]!)).toMatchObject({ idleMs: null, idleSatisfied: false, holding: expect.stringMatching(/capacity/) });
  await advance(); await advance(); expect(readers.size).toBe(16);
  await advance(); await advance();
  expect(scheduler.status(rows[0]!)).toMatchObject({ idleMs: 60_000 }); expect(errors).toEqual([]);
  const waiting = rows[8]!; rows = rows.slice(1); await scheduler.tick();
  expect(scheduler.status(waiting)).toMatchObject({ idleMs: null, holding: expect.stringMatching(/complete/) });
  expect(requests.some(input => input.serviceId === waiting.id)).toBe(true);
});
it('retains a precise held reason and backs off unavailable agents rather than polling every lease tick', async () => {
  await scheduler.close(); const unavailable = vi.fn(async () => { throw new Error('Node proxy traffic unavailable: node owner opt-in is off'); });
  scheduler = createNodeIdleScheduler({ load: async () => rows, open: unavailable, now: () => clock });
  await scheduler.tick(); await advance(); await advance(); await advance();
  expect(unavailable).toHaveBeenCalledTimes(1);
  expect(scheduler.status(service)).toMatchObject({ idleMs: null, holding: expect.stringMatching(/opt-in/) });
  await advance(); expect(unavailable).toHaveBeenCalledTimes(2);
});
it('does not let failed services reserve empty slots and starve a healthy service on the same node', async () => {
  await scheduler.close();
  rows = Array.from({ length: 9 }, (_, index) => ({ ...service, id: index + 1, slug: `svc${index + 1}`, runtimeId: `svc${index + 1}-9` }));
  scheduler = createNodeIdleScheduler({ load: async () => rows, now: () => clock, open: (svc, signal) => {
    if (svc.id < 9) throw new Error('Node proxy traffic unavailable: no routed domain');
    return open(svc, signal);
  } });
  await scheduler.tick(); expect(readers.size).toBe(0);
  await advance(); expect(readers.size).toBe(1);
  expect(scheduler.status(rows[0]!)).toMatchObject({ idleMs: null, holding: expect.stringMatching(/no routed domain/) });
  expect(scheduler.status(rows[8]!)).toMatchObject({ idleMs: null, holding: expect.stringMatching(/complete/) });
});
