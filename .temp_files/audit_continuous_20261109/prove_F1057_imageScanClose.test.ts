import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
for (const closeOwner of [false, true]) {
  it(`${closeOwner ? 'closed' : 'live control'} owner after a gated critical-result callback`, async () => {
    const app = await boot(); const entered = gate(); const blocked = gate();
    seam.rescanRunningImages.mockImplementationOnce(async (_db: unknown, deps: { onNewCritical: Critical }) => {
      entered.release(); await blocked.promise; deps.onNewCritical(service, result); return 1;
    });
    try {
      await vi.advanceTimersByTimeAsync(3_600_000); await entered.promise;
      if (closeOwner) await app.close();
      blocked.release(); await checkpoint();
      console.log('EXPECTED:', closeOwner ? 0 : 1, 'ACTUAL:', seam.audit.mock.calls.length); if (closeOwner) console.log(seam.audit.mock.calls.length ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED'); expect(seam.audit).toHaveBeenCalledTimes(closeOwner ? 0 : 1);
      if (!closeOwner) expect(seam.audit).toHaveBeenCalledWith(app.getDecorator('db'), null, 'image_scan.critical', service.name, {
        serviceId: service.id, imageId: result.imageId, summary: 'synthetic summary', critical: 2,
      });
    } finally { blocked.release(); await checkpoint(); await app.close(); }
  });
}
