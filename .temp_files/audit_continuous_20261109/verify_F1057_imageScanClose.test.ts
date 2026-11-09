import Fastify from 'fastify';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
type Critical = (service: { id: number; name: string }, result: { imageId: string; fixable: { critical: number } }) => void;
const seam = vi.hoisted(() => ({ rescanRunningImages: vi.fn(), summaryLine: vi.fn(() => 'synthetic summary'), audit: vi.fn(async () => undefined) }));
vi.mock('../../apps/server/src/lib/imageScan.js', () => seam);
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: seam.audit }));
const plugin = (await import('../../apps/server/src/plugins/imageScanScheduler.js')).default;
const service = { id: 7, name: 'synthetic service' };
const result = { imageId: `sha256:${'a'.repeat(64)}`, fixable: { critical: 2 } };
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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  seam.rescanRunningImages.mockReset().mockResolvedValue(0); seam.audit.mockClear(); seam.summaryLine.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

for (const closeOwner of [false, true]) for (const count of [0, 1, 3]) {
  it(`independent ${closeOwner ? 'closed' : 'live'} owner with ${count} late callbacks`, async () => {
    const app = await boot(); const entered = gate(); const blocked = gate();
    seam.rescanRunningImages.mockImplementationOnce(async (_db: unknown, deps: { onNewCritical: Critical }) => {
      entered.release(); await blocked.promise;
      for (let i = 0; i < count; i++) deps.onNewCritical({ id: service.id + i, name: `service-${i}` }, result);
      return count;
    });
    try {
      await vi.advanceTimersByTimeAsync(3_600_000); await entered.promise;
      if (closeOwner) await app.close();
      blocked.release(); await checkpoint();
      expect(seam.audit).toHaveBeenCalledTimes(closeOwner ? 0 : count);
      expect(seam.summaryLine).toHaveBeenCalledTimes(closeOwner ? 0 : count);
      if (closeOwner) { await vi.advanceTimersByTimeAsync(6 * 3_600_000); expect(seam.rescanRunningImages).toHaveBeenCalledOnce(); }
    } finally { blocked.release(); await checkpoint(); await app.close(); }
  });
}
it('busy suppresses overlap and admits the next pass after completion', async () => {
  const app = await boot(); const blocked = gate();
  seam.rescanRunningImages.mockImplementationOnce(async () => { await blocked.promise; return 0; });
  try {
    await vi.advanceTimersByTimeAsync(4 * 3_600_000); expect(seam.rescanRunningImages).toHaveBeenCalledOnce();
    blocked.release(); await checkpoint(); await vi.advanceTimersByTimeAsync(3_600_000);
    expect(seam.rescanRunningImages).toHaveBeenCalledTimes(2);
  } finally { blocked.release(); await checkpoint(); await app.close(); }
});
for (const closeOwner of [false, true]) it(`failed rescan releases busy (closed=${closeOwner})`, async () => {
  const app = await boot(); const blocked = gate();
  seam.rescanRunningImages.mockImplementationOnce(async () => { await blocked.promise; throw new Error('injected rescan failure'); });
  try {
    await vi.advanceTimersByTimeAsync(3_600_000);
    if (closeOwner) await app.close();
    blocked.release(); await checkpoint();
    seam.rescanRunningImages.mockImplementationOnce(async (_db: unknown, deps: { onNewCritical: Critical }) => { deps.onNewCritical(service, result); return 1; });
    await vi.advanceTimersByTimeAsync(3_600_000); await checkpoint();
    expect(seam.rescanRunningImages).toHaveBeenCalledTimes(closeOwner ? 1 : 2);
    expect(seam.audit).toHaveBeenCalledTimes(closeOwner ? 0 : 1);
  } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('keeps a pre-close alert and suppresses a later callback from the same rescan', async () => {
  const app = await boot(); const blocked = gate();
  seam.rescanRunningImages.mockImplementationOnce(async (_db: unknown, deps: { onNewCritical: Critical }) => {
    deps.onNewCritical(service, result); await blocked.promise; deps.onNewCritical({ id: 8, name: 'late' }, result); return 2;
  });
  try {
    await vi.advanceTimersByTimeAsync(3_600_000); expect(seam.audit).toHaveBeenCalledOnce();
    await app.close(); blocked.release(); await checkpoint();
    expect(seam.audit).toHaveBeenCalledOnce(); expect(seam.summaryLine).toHaveBeenCalledOnce();
  } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('a replacement app receives only its own critical callback', async () => {
  const previous = await boot(); const blocked = gate();
  seam.rescanRunningImages.mockImplementationOnce(async (_db: unknown, deps: { onNewCritical: Critical }) => { await blocked.promise; deps.onNewCritical(service, result); return 1; });
  await vi.advanceTimersByTimeAsync(3_600_000); await previous.close();
  const current = await boot();
  seam.rescanRunningImages.mockImplementationOnce(async (_db: unknown, deps: { onNewCritical: Critical }) => { deps.onNewCritical(service, result); return 1; });
  try {
    await vi.advanceTimersByTimeAsync(3_600_000); blocked.release(); await checkpoint();
    expect(seam.audit).toHaveBeenCalledOnce(); expect(seam.audit.mock.calls[0]?.[0]).toBe(current.getDecorator('db'));
  } finally { blocked.release(); await checkpoint(); await current.close(); }
});
afterAll(() => console.log('FIX VERIFIED'));
