import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginRoutes } from '../src/modules/plugins.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

/**
 * r286: forcing a marketplace refresh (an outbound fetch of the signed index
 * that also drops the shared cache) is operator-only, and `/:id/inspect`
 * reports what the kernel actually knows instead of invented telemetry.
 */
const catalogMocks = vi.hoisted(() => ({
  clearMarketplaceCache: vi.fn(),
  loadMarketplaceCatalog: vi.fn(async () => ({ catalog: [], live: false, keyId: null, fetchedAt: null })),
}));
vi.mock('../src/lib/marketplaceCatalog.js', () => catalogMocks);

async function appWith() {
  const app = await buildTestApp({ db: createFakeDb() });
  await app.register(pluginRoutes);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('r286: marketplace refresh is operator-only', () => {
  it('POST /marketplace/refresh refuses a non-operator before fetching anything', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/marketplace/refresh',
      headers: asUser({ id: 7, isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
    expect(catalogMocks.loadMarketplaceCatalog).not.toHaveBeenCalled();
  });

  it('POST /marketplace/refresh still works for an operator', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'POST', url: '/marketplace/refresh', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(catalogMocks.loadMarketplaceCatalog).toHaveBeenCalledWith(expect.anything(), { force: true });
  });

  it('GET /marketplace?refresh=true from a non-operator is served from the cache', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'GET',
      url: '/marketplace?refresh=true',
      headers: asUser({ id: 7, isOperator: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(catalogMocks.clearMarketplaceCache).not.toHaveBeenCalled();
    expect(catalogMocks.loadMarketplaceCatalog).toHaveBeenCalledWith(expect.anything(), { force: false });

    const op = await app.inject({ method: 'GET', url: '/marketplace?refresh=true', headers: asUser() });
    expect(op.statusCode).toBe(200);
    expect(catalogMocks.clearMarketplaceCache).toHaveBeenCalledOnce();
  });
});

describe('r286: plugin inspect reports no invented runtime telemetry', () => {
  it('a loaded plugin has null counters and no fabricated hooks or workers', async () => {
    const app = await appWith();
    await app.kernel.registerPlugin({ id: 'probe', name: 'Probe', version: '1.0.0', init: () => {} });
    const res = await app.inject({ method: 'GET', url: '/probe/inspect', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runtimeStats.eventsHandled).toBeNull();
    expect(body.runtimeStats.uptimeSeconds).toBeNull();
    expect(body.hooks).toEqual([]);
    expect(body.services).toEqual([]);
  });
});
