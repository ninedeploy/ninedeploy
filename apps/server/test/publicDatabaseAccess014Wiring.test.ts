/**
 * 0.14 T3 wiring guard (DESIGN §6 M1, M2, M6, M15): public database access is
 * only real if every mount point is connected, so each one fails here when
 * its wiring is removed:
 *   - the three routes are registered by the module api.ts mounts;
 *   - the plugin runs the boot reconcile, arms the 5-minute watchdog, and
 *     subscribes to the eventBus for certificate changes (and unwinds both);
 *   - DELETE /databases/:id calls the sidecar removal hook BEFORE the row
 *     transaction (spy), so the FK cascade never orphans a running proxy.
 * Hermetic: no Docker, no real app boot.
 */
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  reconcile: vi.fn(async () => ({ started: 0, failed: 0, orphansRemoved: 0 })),
  rerender: vi.fn(async () => 0),
  removeSidecar: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/publicDatabaseAccess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/publicDatabaseAccess.js')>()),
  reconcilePublicAccess: hooks.reconcile,
  rerenderTlsSidecars: hooks.rerender,
  removePublicAccessSidecar: hooks.removeSidecar,
}));

vi.mock('../src/engine/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/database.js')>()),
  stopDatabase: vi.fn(async () => undefined),
  stopDatabaseStudio: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/pgbouncer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pgbouncer.js')>()),
  disablePgbouncer: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { databasePublicAccessRoutes } = await import('../src/modules/databasePublicAccess.js');
const { databasesRoutes } = await import('../src/modules/databases.js');
const plugin = await import('../src/plugins/publicDatabaseAccess.js');
const { eventBus } = await import('../src/lib/events.js');
const { asUser, buildTestApp, createFakeDb, dbRow } = await import('./helpers.js');

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  hooks.reconcile.mockClear();
  hooks.rerender.mockClear();
  hooks.removeSidecar.mockClear();
});

describe('routes (M1)', () => {
  it('registers GET, PUT and DELETE /:id/public-access', async () => {
    const app = Fastify();
    const seen: string[] = [];
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) if (m !== 'HEAD') seen.push(`${m} ${r.url}`);
    });
    const noop = async () => undefined;
    app.decorate('authenticate', noop);
    app.decorate('requireOperator', noop);
    await app.register(databasePublicAccessRoutes, { prefix: '/v1/databases' });
    await app.ready();
    expect(seen.sort()).toEqual([
      'DELETE /v1/databases/:id/public-access',
      'GET /v1/databases/:id/public-access',
      'PUT /v1/databases/:id/public-access',
    ]);
    await app.close();
  });

  it('PUT and DELETE carry the operator gate', async () => {
    const src = strip(readFileSync(new URL('../src/modules/databasePublicAccess.ts', import.meta.url), 'utf8'));
    expect(src).toMatch(/app\.put\('\/:id\/public-access', \{ preHandler: app\.requireOperator \}/);
    expect(src).toMatch(/app\.delete\('\/:id\/public-access', \{ preHandler: app\.requireOperator \}/);
  });
});

describe('plugin (M2, M15)', () => {
  async function boot() {
    const app = Fastify();
    app.decorate('db', createFakeDb());
    await app.register(plugin.default);
    return app;
  }

  it('reconciles at boot, arms a 5-minute watchdog and clears it on close', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const app = await boot();
    await app.ready();
    await vi.waitFor(() => expect(hooks.reconcile).toHaveBeenCalledTimes(1));
    const call = setSpy.mock.calls.find(([, ms]) => ms === plugin.PUBLIC_DB_WATCHDOG_MS);
    expect(call, 'watchdog interval').toBeDefined();
    expect(plugin.PUBLIC_DB_WATCHDOG_MS).toBe(5 * 60 * 1000);
    // The armed callback is the watchdog: firing it reconciles again.
    (call![0] as () => void)();
    await vi.waitFor(() => expect(hooks.reconcile).toHaveBeenCalledTimes(2));
    const timer = setSpy.mock.results[setSpy.mock.calls.indexOf(call!)]!.value;
    await app.close();
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it('never stacks reconcile passes', async () => {
    let release!: () => void;
    hooks.reconcile.mockImplementationOnce(() => new Promise((r) => { release = () => r({ started: 0, failed: 0, orphansRemoved: 0 }); }));
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const app = await boot();
    await app.ready();
    const tick = setSpy.mock.calls.find(([, ms]) => ms === plugin.PUBLIC_DB_WATCHDOG_MS)![0] as () => void;
    tick();
    tick();
    expect(hooks.reconcile).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => {
      tick();
      expect(hooks.reconcile).toHaveBeenCalledTimes(2);
    });
    await app.close();
  });

  it('a failing reconcile is logged, never thrown', async () => {
    hooks.reconcile.mockRejectedValueOnce(new Error('docker down'));
    const app = await boot();
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it('re-renders TLS sidecars on every certificate change, and unsubscribes on close', async () => {
    const app = await boot();
    await app.ready();
    for (const action of plugin.CERTIFICATE_ACTIONS) {
      eventBus.publish(action, 'cert', 1);
    }
    eventBus.publish('traefik.custom_config.save', 'custom.yml', 1);
    eventBus.publish('database.public_access.enable', 'pg', 1);
    await vi.waitFor(() => expect(hooks.rerender).toHaveBeenCalledTimes(3));
    expect([...plugin.CERTIFICATE_ACTIONS].sort()).toEqual([
      'traefik.certificate.delete',
      'traefik.certificate.replace',
      'traefik.certificate.upload',
    ]);
    hooks.rerender.mockRejectedValueOnce(new Error('disk full'));
    eventBus.publish('traefik.certificate.upload', 'cert', 1);
    await vi.waitFor(() => expect(hooks.rerender).toHaveBeenCalledTimes(4));
    await app.close();
    eventBus.publish('traefik.certificate.delete', 'cert', 1);
    expect(hooks.rerender).toHaveBeenCalledTimes(4);
  });

  it('an instance without a db decorator does nothing', async () => {
    const app = Fastify();
    await app.register(plugin.default);
    await app.ready();
    eventBus.publish('traefik.certificate.upload', 'cert', 1);
    expect(hooks.reconcile).not.toHaveBeenCalled();
    expect(hooks.rerender).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('database delete hook (M6)', () => {
  it('DELETE /databases/:id removes the sidecar before the row transaction', async () => {
    const row = dbRow({ id: 7, slug: 'pg', name: 'pg', attachments: [] });
    const order: string[] = [];
    const db = createFakeDb({ findFirst: { databases: () => row } });
    const tx = db.transaction.bind(db);
    (db as unknown as { transaction: typeof tx }).transaction = (async (fn: Parameters<typeof tx>[0]) => {
      order.push('transaction');
      return tx(fn);
    }) as typeof tx;
    hooks.removeSidecar.mockImplementationOnce(async () => {
      order.push('sidecar');
    });
    const app = await buildTestApp({ db });
    await app.register(databasesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/7', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(hooks.removeSidecar).toHaveBeenCalledTimes(1);
    expect(hooks.removeSidecar).toHaveBeenCalledWith(db, expect.objectContaining({ id: 7, slug: 'pg' }), expect.any(Function));
    expect(order).toEqual(['sidecar', 'transaction']);
  });
});
