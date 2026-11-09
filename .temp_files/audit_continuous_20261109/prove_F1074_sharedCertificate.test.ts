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
it('control: baseline and unchanged storage do not render; a renewal renders once', async () => {
 const app = await boot(); try { await vi.advanceTimersByTimeAsync(hour * 2); expect(dep.render).not.toHaveBeenCalled(); dep.stat.mockReturnValue({ mtimeMs: 200 }); await vi.advanceTimersByTimeAsync(hour * 2); expect(dep.render).toHaveBeenCalledOnce(); } finally { await app.close(); }
});
it('one pending settings read excludes a second tick from rendering the same renewal', async () => {
 const app = await boot(); const blocked = gate();
 try {
  await vi.advanceTimersByTimeAsync(hour); dep.stat.mockReturnValue({ mtimeMs: 200 });
  dep.enabled.mockImplementation(async () => { await blocked.promise; return true; });
  await vi.advanceTimersByTimeAsync(hour * 2);
  const admitted = dep.enabled.mock.calls.length - 1;
  blocked.release(); await checkpoint();
  console.log('EXPECTED: 1 settings admission / 1 render; ACTUAL:', admitted, dep.render.mock.calls.length);
  if (admitted !== 1 || dep.render.mock.calls.length !== 1) console.log('PROBLEM CONFIRMED'); else console.log('PROBLEM NOT REPRODUCED');
  expect({ admitted, renders: dep.render.mock.calls.length }).toEqual({ admitted: 1, renders: 1 });
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('closing while settings read is pending prevents new render admission', async () => {
 const app = await boot(); const blocked = gate();
 try {
  await vi.advanceTimersByTimeAsync(hour); dep.stat.mockReturnValue({ mtimeMs: 200 });
  dep.enabled.mockImplementationOnce(async () => { await blocked.promise; return true; });
  await vi.advanceTimersByTimeAsync(hour); await app.close(); blocked.release(); await checkpoint();
  console.log('EXPECTED: 0 renders after close; ACTUAL:', dep.render.mock.calls.length);
  console.log(dep.render.mock.calls.length ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
  expect(dep.render).not.toHaveBeenCalled();
 } finally { blocked.release(); await checkpoint(); await app.close(); }
});
