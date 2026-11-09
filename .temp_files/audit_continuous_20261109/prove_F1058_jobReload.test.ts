import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../apps/server/src/lib/jobRunner.js', () => ({ runJob: run }));
const plugin = (await import('../../apps/server/src/plugins/jobScheduler.js')).default;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  vi.stubEnv('TZ', 'UTC');
  vi.useFakeTimers({ now: new Date('2026-01-01T00:00:10Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  run.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
for (const mode of ['quick control', 'pending', 'failed'] as const) {
  it(`preserves the next job deadline during a ${mode} reload`, async () => {
    const app = Fastify({ logger: false }); const entered = gate(); const blocked = gate();
    let reads = 0;
    const findMany = vi.fn(async () => {
      if (++reads === 2) {
        if (mode === 'failed') throw new Error('injected transient read failure');
        if (mode === 'pending') { entered.release(); await blocked.promise; }
      }
      return [{ id: 1, enabled: true, cron: '* * * * *' }];
    });
    app.decorate('db', { query: { scheduledJobs: { findMany } } } as never);
    await app.register(plugin); await app.ready();
    try {
      await vi.advanceTimersByTimeAsync(300000); // 00:05:10, first reload
      if (mode === 'pending') await entered.promise;
      expect(findMany).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(5); // five real Cron deadlines before reload
      await vi.advanceTimersByTimeAsync(50000); // 00:06:00, while reload is blocked/failed
      console.log('EXPECTED: six minute deadlines dispatched; ACTUAL:', run.mock.calls.length); console.log(run.mock.calls.length === 6 ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); expect(run).toHaveBeenCalledTimes(6);
      expect(run).toHaveBeenLastCalledWith(app.getDecorator('db'), 1, { scheduled: true });
    } finally { blocked.release(); await checkpoint(); await app.close(); }
  });
}
