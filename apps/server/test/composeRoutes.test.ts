/** G2.1 a domain per compose service: the route, the rendered upstream, and the per-service variables. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const { domainComposeRouteRoutes } = await import('../src/modules/composeRoutes.js');
const { composeRouteEnv, inlineComposeServices } = await import('../src/lib/composeRoutes.js');
const { renderDynamicConfig } = await import('../src/engine/proxy.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

const STACK = 'services:\n  web:\n    image: nginx\n  admin-ui:\n    image: adminer\n  db:\n    image: postgres\n';

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'shop', slug: 'shop', type: 'compose', branch: 'main', ownerUserId: 1, composeContent: STACK, composeService: 'web', runtimeId: 'ndcmp-shop-web-1', port: 80, status: 'running' },
    { id: 6, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx', runtimeId: 'api-1', port: 80, status: 'running' },
  ] as never);
  await db.insert(domains).values([
    { id: 11, serviceId: 5, hostname: 'shop.example.com', path: '/', ssl: true, status: 'active' },
    { id: 12, serviceId: 5, hostname: 'admin.shop.example.com', path: '/', ssl: true, status: 'active' },
    { id: 13, serviceId: 6, hostname: 'api.example.com', path: '/', ssl: true, status: 'active' },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

async function app() {
  const a = await buildTestApp({ db });
  await a.register(domainComposeRouteRoutes, { prefix: '/domains' });
  return a;
}
const put = async (a: Awaited<ReturnType<typeof app>>, id: number, route: unknown) =>
  a.inject({ method: 'PUT', url: `/domains/${id}/compose-route`, headers: asUser(1), payload: { route } as object });

describe('compose routes', () => {
  it('routes one domain of a stack to another service and port, and only to services the file declares', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/domains/12/compose-route', headers: asUser(1) })).json()).toEqual({ domainId: 12, route: null, services: ['web', 'admin-ui', 'db'] });
    expect((await put(a, 12, { service: 'admin-ui', port: 8080 })).json()).toMatchObject({ route: { service: 'admin-ui', port: 8080 } });
    const unknown = await put(a, 12, { service: 'cache', port: 6379 });
    expect(unknown.statusCode).toBe(400);
    expect(JSON.stringify(unknown.json())).toContain('it has: web, admin-ui, db');
    expect((await put(a, 13, { service: 'web', port: 80 })).statusCode).toBe(400);
    await a.close();

    const yaml = await renderDynamicConfig(db, { serverId: null });
    expect(yaml).toContain('    svc_shop_12:\n      loadBalancer:\n        servers:\n          - url: "http://ndcmp-shop-admin-ui-1:8080"');
    expect(yaml).toContain('    svc_shop_11:\n      loadBalancer:\n        servers:\n          - url: "http://ndcmp-shop-web-1:80"');
  });

  it('never routes to a container name another stack owns, in either direction', async () => {
    const a = await app();
    // A stack "shop-x" exists: "x-web" of "shop" would be its "web" container.
    await db.insert(services).values({ id: 7, name: 'shop-x', slug: 'shop-x', type: 'compose', branch: 'main', ownerUserId: 1, composeContent: STACK, composeService: 'web', runtimeId: 'ndcmp-shop-x-web-1', port: 80, status: 'running' } as never);
    await db.update(services).set({ composeContent: `${STACK}  x-web:\n    image: nginx\n` }).where((await import('drizzle-orm')).eq(services.id, 5));
    const refused = await put(a, 12, { service: 'x-web', port: 80 });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.json())).toContain('compose_route_ambiguous');
    await a.close();
    // A route saved before the other stack appeared falls back to the main service when rendered.
    const { setComposeRoute } = await import('../src/lib/composeRoutes.js');
    await setComposeRoute(db, 12, { service: 'x-web', port: 80 });
    const yaml = await renderDynamicConfig(db, { serverId: null });
    expect(yaml).not.toContain('ndcmp-shop-x-web-1:80"\n    svc_shop_12');
    expect(yaml).toContain('    svc_shop_12:\n      loadBalancer:\n        servers:\n          - url: "http://ndcmp-shop-web-1:80"');
  });

  it('treats a shorter stack slug as ambiguous too', async () => {
    const { composeRouteCollides } = await import('../src/lib/composeRoutes.js');
    // In `shop-x`, `web` is `ndcmp-shop-x-web-1`, which `shop` names its `x-web`.
    expect(composeRouteCollides('shop-x', 'web', ['shop', 'shop-x'])).toBe(true);
    expect(composeRouteCollides('shop', 'x-web', ['shop', 'shop-x'])).toBe(true);
    expect(composeRouteCollides('shop', 'admin-ui', ['shop', 'shop-x'])).toBe(false);
    expect(composeRouteCollides('shop', 'x-web', ['shop', 'shopx'])).toBe(false);
  });

  it('names a routed service in the environment, keeping values the service sets', async () => {
    const a = await app();
    await put(a, 12, { service: 'admin-ui', port: 8080 });
    await a.close();
    expect(await composeRouteEnv(db, 5, {})).toEqual({ SERVICE_FQDN_ADMIN_UI: 'admin.shop.example.com', SERVICE_URL_ADMIN_UI: 'https://admin.shop.example.com' });
    expect(await composeRouteEnv(db, 5, { SERVICE_URL_ADMIN_UI: 'https://custom' })).toEqual({ SERVICE_FQDN_ADMIN_UI: 'admin.shop.example.com' });
    expect(inlineComposeServices('not: [yaml')).toBeNull();
  });
});
