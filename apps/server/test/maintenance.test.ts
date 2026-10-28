/** G2.2 maintenance mode and custom error pages on a migrated SQLite: routes, the pages Traefik fetches, and the rendered routing. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from 'js-yaml';
import { domains, services, settings, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);
const reach = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock('../src/lib/panelUpstream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/panelUpstream.js')>()),
  wakeUnreachableReason: vi.fn(async () => reach.reason),
}));
const rerender = vi.hoisted(() => ({ writeDynamicConfig: vi.fn(async () => undefined) }));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: rerender.writeDynamicConfig,
}));

const { maintenancePageRoutes, serviceMaintenanceRoutes } = await import('../src/modules/maintenance.js');
const { renderDynamicConfig } = await import('../src/engine/proxy.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  vi.clearAllMocks();
  reach.reason = null;
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(services).values({ id: 5, name: 'shop', slug: 'shop', type: 'docker', branch: 'main', ownerUserId: 1, runtimeId: 'shop-1', port: 3000, status: 'running' } as never);
  await db.insert(domains).values([
    { id: 1, serviceId: 5, hostname: 'shop.example.com', path: '/', ssl: true, status: 'active' },
    { id: 2, serviceId: 5, hostname: '*.stores.example.com', path: '/', ssl: true, status: 'active' },
  ] as never);
  await db.insert(settings).values({ key: 'panel_domain', value: 'panel.example.com' as never, updatedAt: new Date() });
});
afterEach(() => closeMigratedDb(db));

async function app() {
  const a = await buildTestApp({ db });
  await a.register(serviceMaintenanceRoutes, { prefix: '/services' });
  await a.register(maintenancePageRoutes);
  return a;
}

describe('maintenance mode', () => {
  it('turns on with its page and bypass list, re-renders, and serves the page only on the service hosts', async () => {
    const a = await app();
    const on = await a.inject({
      method: 'PUT',
      url: '/services/5/maintenance',
      headers: asUser(1),
      payload: { maintenance: { title: 'Upgrading <db>', message: 'Back at 10:00', retryAfterSeconds: 120, bypass: ['203.0.113.7', '2001:db8::/32'] } },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ maintenance: { title: 'Upgrading <db>', bypass: ['203.0.113.7', '2001:db8::/32'] }, since: expect.any(String) });
    expect(rerender.writeDynamicConfig).toHaveBeenCalled();
    expect(auditMock.audit).toHaveBeenCalledWith(db, 1, 'service.maintenance.on', 'shop #5', { serviceId: 5, bypass: 2 });

    const page = await a.inject({ method: 'GET', url: '/_nd/maintenance/5/cart?x=1', headers: { host: 'shop.example.com', accept: 'text/html' } });
    expect(page.statusCode).toBe(503);
    expect(page.headers['retry-after']).toBe('120');
    expect(page.body).toContain('Upgrading &#60;db&#62;');
    const wild = await a.inject({ method: 'POST', url: '/_nd/maintenance/5', headers: { host: 'eu.stores.example.com' }, payload: 'x' });
    expect(wild.statusCode).toBe(503);
    expect(wild.body).toContain('Back at 10:00');
    // Not one of the service's hosts, or the panel's own: nothing.
    expect((await a.inject({ method: 'GET', url: '/_nd/maintenance/5', headers: { host: 'other.example.com' } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/_nd/maintenance/5', headers: { host: 'panel.example.com' } })).statusCode).toBe(404);

    const off = await a.inject({ method: 'PUT', url: '/services/5/maintenance', headers: asUser(1), payload: { maintenance: null } });
    expect(off.json()).toEqual({ maintenance: null, since: null });
    await a.close();
  });

  it('refuses bad bypass entries, node services and an unreachable panel', async () => {
    const a = await app();
    const put = (maintenance: unknown) => a.inject({ method: 'PUT', url: '/services/5/maintenance', headers: asUser(1), payload: { maintenance } as object });
    expect((await put({ bypass: ['10.0.0.0/33'] })).statusCode).toBe(400);
    expect((await put({ bypass: ['evil`) || Host(`x'] })).statusCode).toBe(400);
    reach.reason = 'Traefik cannot reach the panel';
    const refused = await put({});
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.json())).toContain('maintenance_unreachable');
    await a.close();
  });
});

describe('custom error pages', () => {
  it('stores pages per status and serves them with that status; a missing one gets the default', async () => {
    const a = await app();
    const set = await a.inject({ method: 'PUT', url: '/services/5/error-pages', headers: asUser(1), payload: { pages: { '502': '<h1>Oops</h1>' } } });
    expect(set.json()).toEqual({ pages: { '502': '<h1>Oops</h1>' } });
    const custom = await a.inject({ method: 'GET', url: '/_nd/errors/5/502', headers: { host: 'shop.example.com' } });
    expect(custom.statusCode).toBe(502);
    expect(custom.body).toBe('<h1>Oops</h1>');
    const fallback = await a.inject({ method: 'GET', url: '/_nd/errors/5/504', headers: { host: 'shop.example.com' } });
    expect(fallback.statusCode).toBe(504);
    expect(fallback.body).toContain('Gateway timeout');
    expect((await a.inject({ method: 'GET', url: '/_nd/errors/5/500', headers: { host: 'shop.example.com' } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/_nd/errors/5/502', headers: { host: 'panel.example.com' } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'PUT', url: '/services/5/error-pages', headers: asUser(1), payload: { pages: { '502': 'x'.repeat(70_000) } } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: '/services/5/error-pages', headers: asUser(1), payload: { pages: {} } })).json()).toEqual({ pages: {} });
    await a.close();
  });
});

describe('rendered routing', () => {
  type Doc = { http: { routers: Record<string, { rule: string; service: string; middlewares?: string[] }>; middlewares: Record<string, Record<string, unknown>> } };

  it('sends a service in maintenance to the panel, with a ClientIP twin to the app for the bypass list', async () => {
    const a = await app();
    await a.inject({ method: 'PUT', url: '/services/5/maintenance', headers: asUser(1), payload: { maintenance: { bypass: ['203.0.113.7'] } } });
    await a.close();
    const doc = load(await renderDynamicConfig(db, { serverId: null })) as Doc;
    expect(doc.http.routers['shop_1']).toMatchObject({ service: 'svc_ninedeploy_wake', middlewares: ['mw_ninedeploy_maint_5'] });
    expect(doc.http.routers['shop_1_bypass']).toMatchObject({ rule: '(Host(`shop.example.com`)) && (ClientIP(`203.0.113.7`))', service: 'svc_shop_1' });
    expect(doc.http.middlewares['mw_ninedeploy_maint_5']).toEqual({ addPrefix: { prefix: '/_nd/maintenance/5' } });
  });

  it('keeps routing a stopped service in maintenance, and adds the errors middleware for custom pages', async () => {
    await db.update(services).set({ status: 'stopped' }).where((await import('drizzle-orm')).eq(services.id, 5));
    expect((load(await renderDynamicConfig(db, { serverId: null })) as Doc | undefined)?.http?.routers?.['shop_1']).toBeUndefined();
    const a = await app();
    await a.inject({ method: 'PUT', url: '/services/5/maintenance', headers: asUser(1), payload: { maintenance: {} } });
    expect((load(await renderDynamicConfig(db, { serverId: null })) as Doc).http.routers['shop_1']?.service).toBe('svc_ninedeploy_wake');

    await a.inject({ method: 'PUT', url: '/services/5/maintenance', headers: asUser(1), payload: { maintenance: null } });
    await db.update(services).set({ status: 'running' }).where((await import('drizzle-orm')).eq(services.id, 5));
    await a.inject({ method: 'PUT', url: '/services/5/error-pages', headers: asUser(1), payload: { pages: { '502': '<p>x</p>', '503': '<p>y</p>' } } });
    await a.close();
    const doc = load(await renderDynamicConfig(db, { serverId: null })) as Doc;
    expect(doc.http.routers['shop_1']).toMatchObject({ service: 'svc_shop_1', middlewares: ['mw_ninedeploy_errors_5'] });
    expect(doc.http.middlewares['mw_ninedeploy_errors_5']).toEqual({ errors: { status: ['502', '503'], service: 'svc_ninedeploy_wake', query: '/_nd/errors/5/{status}' } });
  });
});
