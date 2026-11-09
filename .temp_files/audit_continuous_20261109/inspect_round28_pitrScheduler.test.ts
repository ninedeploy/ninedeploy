import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({
  failInterruptedPitrRecoveries: vi.fn(async () => 0), pitrDatabases: vi.fn(), pitrMaintenance: vi.fn(),
}));
vi.mock('../../apps/server/src/lib/pitr.js', () => seam);
const plugin = (await import('../../apps/server/src/plugins/pitrScheduler.js')).default;
const dbs = [{ id: 1, slug: 'one' }, { id: 2, slug: 'two' }];
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
async function boot() {
  const app = Fastify({ logger: false }); app.decorate('db', {} as never);
  await app.register(plugin); await app.ready(); return app;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  vi.clearAllMocks(); seam.pitrDatabases.mockReset().mockResolvedValue(dbs); seam.pitrMaintenance.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it('control: initial and subsequent passes run both databases', async () => {
  const app = await boot();
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(seam.pitrMaintenance.mock.calls.map(call => call[1].id)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(seam.pitrMaintenance.mock.calls.map(call => call[1].id)).toEqual([1, 2, 1, 2]);
  } finally { await app.close(); }
});
it('closing during a blocked listing dispatches no maintenance', async () => {
  const app = await boot(); const listing = gate<typeof dbs>(); seam.pitrDatabases.mockReturnValueOnce(listing.promise);
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000); expect(seam.pitrDatabases).toHaveBeenCalledOnce();
    await app.close(); listing.release(dbs); await checkpoint();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(seam.pitrMaintenance).not.toHaveBeenCalled(); expect(seam.pitrDatabases).toHaveBeenCalledOnce();
  } finally { listing.release(dbs); await app.close(); }
});
it('close during first database upkeep prevents advancing to the second', async () => {
  const app = await boot(); const maintenance = gate<void>(); seam.pitrMaintenance.mockReturnValueOnce(maintenance.promise);
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000); expect(seam.pitrMaintenance).toHaveBeenCalledOnce();
    await app.close(); maintenance.release(); await checkpoint();
    expect(seam.pitrMaintenance.mock.calls.map(call => call[1].id)).toEqual([1]);
  } finally { maintenance.release(); await app.close(); }
});
it('busy listing prevents overlapping ticks and resumes after release', async () => {
  const app = await boot(); const listing = gate<typeof dbs>(); seam.pitrDatabases.mockReturnValueOnce(listing.promise);
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.advanceTimersByTimeAsync(50 * 60_000); expect(seam.pitrDatabases).toHaveBeenCalledOnce();
    listing.release(dbs); await checkpoint();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(seam.pitrDatabases).toHaveBeenCalledTimes(2); expect(seam.pitrMaintenance).toHaveBeenCalledTimes(4);
  } finally { listing.release(dbs); await app.close(); }
});
it('a failed listing clears busy for the next tick', async () => {
  const app = await boot(); seam.pitrDatabases.mockRejectedValueOnce(new Error('injected list failure'));
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000); expect(seam.pitrMaintenance).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50 * 60_000); expect(seam.pitrMaintenance).toHaveBeenCalledTimes(2);
  } finally { await app.close(); }
});
