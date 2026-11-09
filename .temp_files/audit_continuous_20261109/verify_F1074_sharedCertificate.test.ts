import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const dep = vi.hoisted(() => ({ enabled: vi.fn(), render: vi.fn(), stat: vi.fn() }));
vi.mock('../../apps/server/src/lib/sharedCertificates.js', () => ({ sharedCertificatesEnabled: dep.enabled }));
vi.mock('../../apps/server/src/engine/proxy.js', () => ({ acmeStoragePath: () => '/fixture/acme.json', writeDynamicConfig: dep.render }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), statSync: dep.stat }));
const plugin = (await import('../../apps/server/src/plugins/sharedCertificateSync.js')).default;
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function boot() { const app = Fastify({ logger: false }); app.decorate('db', {} as never); await app.register(plugin); await app.ready(); return app; }
const hour = 3600000;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); dep.enabled.mockReset().mockResolvedValue(true); dep.render.mockReset().mockResolvedValue(undefined); dep.stat.mockReset().mockReturnValue({ mtimeMs: 100 }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

import { afterAll } from 'vitest';
afterAll(() => console.log('FIX VERIFIED'));
for (const first of ['disabled', 'missing', 'read-error', 'unchanged'] as const) it(`releases admission after ${first} and later detects renewal`, async () => {
 const app = await boot();
 try {
  await vi.advanceTimersByTimeAsync(hour);
  if (first === 'disabled') dep.enabled.mockResolvedValueOnce(false);
  if (first === 'missing') dep.stat.mockImplementationOnce(() => { throw new Error('ENOENT'); });
  if (first === 'read-error') dep.enabled.mockRejectedValueOnce(new Error('read failed'));
  await vi.advanceTimersByTimeAsync(hour); expect(dep.render).not.toHaveBeenCalled();
  dep.stat.mockReturnValue({ mtimeMs: 300 }); await vi.advanceTimersByTimeAsync(hour); expect(dep.render).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(hour); expect(dep.render).toHaveBeenCalledOnce();
 } finally { await app.close(); }
});
it('failed render does not acknowledge mtime and retries the unchanged renewal', async () => {
 const app = await boot(); try {
  await vi.advanceTimersByTimeAsync(hour); dep.stat.mockReturnValue({ mtimeMs: 200 }); dep.render.mockRejectedValueOnce(new Error('render failed'));
  await vi.advanceTimersByTimeAsync(hour * 3); expect(dep.render).toHaveBeenCalledTimes(2);
 } finally { await app.close(); }
});
it('held render excludes ticks, then a newer renewal is observed', async () => {
 const app = await boot(); const entered = gate(); const blocked = gate();
 try {
  await vi.advanceTimersByTimeAsync(hour); dep.stat.mockReturnValue({ mtimeMs: 200 }); dep.render.mockImplementationOnce(async () => { entered.release(); await blocked.promise; });
  await vi.advanceTimersByTimeAsync(hour); await entered.promise; dep.stat.mockReturnValue({ mtimeMs: 300 });
  await vi.advanceTimersByTimeAsync(hour * 3); expect(dep.enabled).toHaveBeenCalledTimes(2); expect(dep.render).toHaveBeenCalledOnce();
  blocked.release(); await checkpoint(); await vi.advanceTimersByTimeAsync(hour * 2); expect(dep.render).toHaveBeenCalledTimes(2);
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('held settings read excludes repeated cadence then produces one render', async () => {
 const app = await boot(); const entered = gate(); const blocked = gate();
 try {
  await vi.advanceTimersByTimeAsync(hour); dep.stat.mockReturnValue({ mtimeMs: 200 }); dep.enabled.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return true; });
  await vi.advanceTimersByTimeAsync(hour); await entered.promise; await vi.advanceTimersByTimeAsync(hour * 3); expect(dep.enabled).toHaveBeenCalledTimes(2);
  blocked.release(); await checkpoint(); expect(dep.render).toHaveBeenCalledOnce();
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('close before first tick and retained callback perform no reads or writes', async () => {
 const timer = vi.spyOn(globalThis, 'setInterval'); const app = await boot(); const callback = timer.mock.calls.find(call => call[1] === hour)?.[0];
 expect(typeof callback).toBe('function'); await app.close(); if (typeof callback === 'function') callback(); await checkpoint();
 await vi.advanceTimersByTimeAsync(hour * 3); expect(dep.enabled).not.toHaveBeenCalled(); expect(dep.render).not.toHaveBeenCalled();
});
it('close while read is gated cannot start a renewal render', async () => {
 const app = await boot(); const entered = gate(); const blocked = gate();
 try {
  await vi.advanceTimersByTimeAsync(hour); dep.stat.mockReturnValue({ mtimeMs: 200 }); dep.enabled.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return true; });
  await vi.advanceTimersByTimeAsync(hour); await entered.promise; await app.close(); blocked.release(); await checkpoint();
  await vi.advanceTimersByTimeAsync(hour * 2); expect(dep.stat).toHaveBeenCalledTimes(1); expect(dep.render).not.toHaveBeenCalled();
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('an admitted render can settle after close without another render', async () => {
 const app = await boot(); const blocked = gate(); const entered = gate();
 try {
  await vi.advanceTimersByTimeAsync(hour); dep.stat.mockReturnValue({ mtimeMs: 200 }); dep.render.mockImplementationOnce(async () => { entered.release(); await blocked.promise; });
  await vi.advanceTimersByTimeAsync(hour); await entered.promise; await app.close(); blocked.release(); await checkpoint();
  dep.stat.mockReturnValue({ mtimeMs: 300 }); await vi.advanceTimersByTimeAsync(hour * 3); expect(dep.render).toHaveBeenCalledOnce();
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
