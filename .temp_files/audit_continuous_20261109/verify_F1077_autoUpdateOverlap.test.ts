import Fastify from 'fastify';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
const sweep = vi.hoisted(() => vi.fn());
vi.mock('../../apps/server/src/lib/autoUpdate.js', () => ({ sweepAutoUpdates: sweep }));
const plugin = (await import('../../apps/server/src/plugins/autoUpdateScheduler.js')).default;
const initial = 5 * 60000, cadence = 30 * 60000;
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function boot() { const app = Fastify({ logger: false }); app.decorate('db', {} as never); await app.register(plugin); await app.ready(); return app; }
let failed = false;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); sweep.mockReset().mockResolvedValue({ probed: 0, enqueued: 0, skipped: 0 }); });
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
it('preserves delayed first tick then interval cadence', async () => {
 const app = await boot(); try {
  await vi.advanceTimersByTimeAsync(initial - 1); expect(sweep).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(sweep).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(cadence - 1); expect(sweep).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1); expect(sweep).toHaveBeenCalledTimes(2);
 } finally { await app.close(); }
});
for (const reject of [false, true]) it(`first pending sweep holds interval installation and recovers (${reject})`, async () => {
 const blocked = gate(); const entered = gate(); sweep.mockImplementationOnce(async () => { entered.release(); await blocked.promise; if (reject) throw new Error('injected'); return { probed: 0, enqueued: 0, skipped: 0 }; });
 const app = await boot(); try {
  await vi.advanceTimersByTimeAsync(initial); await entered.promise; await vi.advanceTimersByTimeAsync(cadence * 4); expect(sweep).toHaveBeenCalledOnce();
  blocked.release(); await checkpoint(); await vi.advanceTimersByTimeAsync(cadence); expect(sweep).toHaveBeenCalledTimes(2);
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
for (const reject of [false, true]) it(`periodic pending sweep excludes repeats then releases busy (${reject})`, async () => {
 const app = await boot(); const blocked = gate(); const entered = gate(); try {
  await vi.advanceTimersByTimeAsync(initial); sweep.mockImplementationOnce(async () => { entered.release(); await blocked.promise; if (reject) throw new Error('injected periodic'); return { probed: 1, enqueued: 1, skipped: 0 }; });
  await vi.advanceTimersByTimeAsync(cadence); await entered.promise; await vi.advanceTimersByTimeAsync(cadence * 4); expect(sweep).toHaveBeenCalledTimes(2);
  blocked.release(); await checkpoint(); await vi.advanceTimersByTimeAsync(cadence); expect(sweep).toHaveBeenCalledTimes(3);
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('close before delayed tick prevents all work', async () => {
 const app = await boot(); await app.close(); await vi.advanceTimersByTimeAsync(initial + cadence * 4); expect(sweep).not.toHaveBeenCalled();
});
for (const periodic of [false, true]) it(`close while ${periodic ? 'periodic' : 'initial'} sweep waits never schedules another`, async () => {
 const app = await boot(); const blocked = gate(); const entered = gate(); try {
  if (periodic) await vi.advanceTimersByTimeAsync(initial);
  sweep.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return { probed: 0, enqueued: 0, skipped: 0 }; });
  await vi.advanceTimersByTimeAsync(periodic ? cadence : initial); await entered.promise; const count = sweep.mock.calls.length;
  await app.close(); blocked.release(); await checkpoint(); await vi.advanceTimersByTimeAsync(cadence * 4); expect(sweep).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
for (const periodic of [false, true]) it(`retained ${periodic ? 'interval' : 'timeout'} callback cannot dispatch after close`, async () => {
 const timeout = vi.spyOn(globalThis, 'setTimeout'); const interval = vi.spyOn(globalThis, 'setInterval'); const app = await boot();
 if (periodic) await vi.advanceTimersByTimeAsync(initial);
 const callback = (periodic ? interval.mock.calls.find(call => call[1] === cadence) : timeout.mock.calls.find(call => call[1] === initial))?.[0];
 expect(typeof callback).toBe('function'); const count = sweep.mock.calls.length; await app.close(); if (typeof callback === 'function') callback(); await checkpoint(); expect(sweep).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
});
it('independent plugin instances retain separate admission', async () => {
 const a = await boot(), b = await boot(); try { await vi.advanceTimersByTimeAsync(initial); expect(sweep).toHaveBeenCalledTimes(2); await a.close(); await vi.advanceTimersByTimeAsync(cadence); expect(sweep).toHaveBeenCalledTimes(3); } finally { await a.close(); await b.close(); }
});
