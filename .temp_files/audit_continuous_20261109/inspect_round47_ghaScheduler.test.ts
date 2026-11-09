import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const sweep = vi.hoisted(() => vi.fn());
vi.mock('../../apps/server/src/lib/githubRunners.js', () => ({ sweepGithubRunners: sweep }));
const plugin = (await import('../../apps/server/src/plugins/githubRunnerScheduler.js')).default;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
async function boot() {
  const app = Fastify({ logger: false }); app.decorate('db', {} as never);
  await app.register(plugin); await app.ready(); return app;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); sweep.mockReset().mockResolvedValue(undefined); });
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('control: dispatches first at one minute and repeats on cadence', async () => {
  const app = await boot();
  try {
    await vi.advanceTimersByTimeAsync(59999); expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await checkpoint(); expect(sweep).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000); await checkpoint(); expect(sweep).toHaveBeenCalledTimes(2);
  } finally { await app.close(); }
});
it('suppresses overlap during a gated sweep and resumes after completion', async () => {
  const app = await boot(); const entered = gate(); const blocked = gate();
  sweep.mockImplementationOnce(async () => { entered.release(); await blocked.promise; });
  try {
    await vi.advanceTimersByTimeAsync(60000); await entered.promise;
    await vi.advanceTimersByTimeAsync(600000); expect(sweep).toHaveBeenCalledOnce();
    blocked.release(); await checkpoint(); await vi.advanceTimersByTimeAsync(60000);
    expect(sweep).toHaveBeenCalledTimes(2);
  } finally { blocked.release(); await checkpoint(); await app.close(); }
});
for (const closeOwner of [false, true]) it(`failed sweep releases busy, without future closed-owner dispatch (${closeOwner})`, async () => {
  const app = await boot(); const blocked = gate();
  sweep.mockImplementationOnce(async () => { await blocked.promise; throw new Error('injected sweep failure'); });
  try {
    await vi.advanceTimersByTimeAsync(60000);
    if (closeOwner) await app.close();
    blocked.release(); await checkpoint(); await vi.advanceTimersByTimeAsync(60000);
    expect(sweep).toHaveBeenCalledTimes(closeOwner ? 1 : 2);
  } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('close before the first interval prevents every sweep', async () => {
  const app = await boot(); await app.close();
  await vi.advanceTimersByTimeAsync(600000); expect(sweep).not.toHaveBeenCalled();
});
it('close while a sweep waits prevents any next sweep after release', async () => {
  const app = await boot(); const blocked = gate();
  sweep.mockImplementationOnce(async () => { await blocked.promise; });
  try {
    await vi.advanceTimersByTimeAsync(60000); await app.close(); blocked.release(); await checkpoint();
    await vi.advanceTimersByTimeAsync(600000); expect(sweep).toHaveBeenCalledOnce();
  } finally { blocked.release(); await checkpoint(); await app.close(); }
});

it('a retained timer callback invoked after close cannot dispatch', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval'); const app = await boot();
  const callback = interval.mock.calls.find(call => call[1] === 60000)?.[0];
  expect(typeof callback).toBe('function'); await app.close();
  if (typeof callback === 'function') callback();
  await checkpoint(); expect(sweep).not.toHaveBeenCalled();
});
