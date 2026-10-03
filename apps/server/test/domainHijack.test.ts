import { afterEach, describe, expect, it, vi } from 'vitest';
import { domainsRoutes } from '../src/modules/domains.js';
import { asUser, buildTestApp, createFakeDb, domainRow, svcRow } from './helpers.js';

/**
 * H-2 regression: hostname claims are ownership-scoped.
 *
 * Traefik ranks routers by rule length when no priority is set, so a second
 * router for the same host with a LONGER rule — `Host(x) && PathPrefix(/api)`
 * against a bare `Host(x)` — outranks the original and receives its traffic,
 * `Authorization` headers included. The unique index is on (hostname, path),
 * so before this fix a member could claim any other tenant's hostname (or the
 * panel's) simply by picking a different path.
 *
 * The rule is NOT "one hostname, one service": sharing a host across services
 * on different paths is legitimate. Every service already routing the host has
 * to be one the caller can manage.
 */

vi.mock('../src/engine/proxy.js', () => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  parseHeaders: () => [],
}));

vi.mock('../src/lib/cloudflare.js', () => ({
  getDnsRecordsConfig: vi.fn(async () => ({ enabled: false, token: null, content: null })),
  createDnsRecord: vi.fn(async () => 'rec-1'),
  deleteDnsRecord: vi.fn(async () => undefined),
  detectPublicIp: vi.fn(async () => '203.0.113.5'),
}));

const MEMBER = 7;
const OWNER = 42;

/**
 * Service 1 belongs to the caller; service 99 (the incumbent holder of the
 * hostname) belongs to `holderOwner`. The fake db ignores the `where` clause,
 * so the two lookups are distinguished by call order: the route resolves the
 * caller's service first, then the holder's inside the claim check.
 */
async function appWith(existing: Array<Record<string, unknown>>, holderOwner: number | null) {
  let call = 0;
  const app = await buildTestApp({
    db: createFakeDb({
      findFirst: {
        services: () => (call++ === 0 ? svcRow({ id: 1, ownerUserId: MEMBER }) : svcRow({ id: 99, ownerUserId: holderOwner })),
      },
      findMany: { domains: existing },
      insert: { domains: [domainRow({ id: 5 })] },
    }),
  });
  await app.register(domainsRoutes);
  return app;
}

const claim = (
  app: Awaited<ReturnType<typeof appWith>>,
  hostname: string,
  path = '/api',
  user = asUser({ id: MEMBER, isOperator: false }),
) => app.inject({ method: 'POST', url: '/1/domains', headers: user, payload: { hostname, path, ssl: true } });

afterEach(() => {
  delete process.env['NINEDEPLOY_DOMAIN'];
});

describe('H-2: hostname claims are ownership-scoped', () => {
  const foreign = [domainRow({ id: 9, serviceId: 99, hostname: 'victim.example.com', path: '/' })];

  it("a member cannot claim another tenant's hostname on a different path", async () => {
    const app = await appWith(foreign, OWNER);
    const res = await claim(app, 'victim.example.com');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('That hostname is already routed by another service');
  });

  it('the case of the hostname does not get you past the check', async () => {
    // DNS (and Traefik's Host matcher) are case-insensitive, so this is the
    // same route — it must not read as a different hostname.
    const app = await appWith(foreign, OWNER);
    expect((await claim(app, 'Victim.Example.COM')).statusCode).toBe(409);
  });

  it('a trailing root dot does not get you past the check either', async () => {
    const app = await appWith(foreign, OWNER);
    expect((await claim(app, 'victim.example.com.')).statusCode).toBe(409);
  });

  it("a foreign wildcard blocks claiming a host it covers, and vice versa", async () => {
    const wildcardHolder = [domainRow({ id: 9, serviceId: 99, hostname: '*.example.com', path: '/' })];
    expect((await claim(await appWith(wildcardHolder, OWNER), 'app.example.com')).statusCode).toBe(409);

    const exactHolder = [domainRow({ id: 9, serviceId: 99, hostname: 'app.example.com', path: '/' })];
    expect((await claim(await appWith(exactHolder, OWNER), '*.example.com')).statusCode).toBe(409);
  });

  it('an orphaned domain row (owner-less service) is treated as taken', async () => {
    // NULL-owner services are admin-only under resourceAccess, so a member
    // must not inherit their hostname.
    const app = await appWith(foreign, null);
    expect((await claim(app, 'victim.example.com')).statusCode).toBe(409);
  });

  it('sharing a hostname across the caller’s OWN services still works', async () => {
    // The legitimate path-routing pattern must survive the fix.
    const own = [domainRow({ id: 9, serviceId: 99, hostname: 'shared.example.com', path: '/' })];
    const app = await appWith(own, MEMBER);
    expect((await claim(app, 'shared.example.com')).statusCode).toBe(200);
  });

  it('an admin can claim any hostname', async () => {
    const app = await appWith(foreign, OWNER);
    const res = await claim(app, 'victim.example.com', '/api', asUser({ id: 1, isOperator: true }));
    expect(res.statusCode).toBe(200);
  });

  it('an unclaimed hostname is accepted and stored lower-cased', async () => {
    let inserted: Record<string, unknown> | null = null;
    let call = 0;
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: () => (call++ === 0 ? svcRow({ id: 1, ownerUserId: MEMBER }) : undefined) },
        findMany: { domains: [] },
        insert: {
          domains: (v: Record<string, unknown>) => {
            inserted = v;
            return [domainRow({ id: 5 })];
          },
        },
      }),
    });
    await app.register(domainsRoutes);
    const res = await claim(app, 'NEW.Example.com', '/');
    expect(res.statusCode).toBe(200);
    expect(inserted).toMatchObject({ hostname: 'new.example.com' });
  });
});

describe('H-2: the panel hostname is reserved', () => {
  it('refuses a hostname that collides with the configured panel domain', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    const app = await appWith([], null);
    const res = await claim(app, 'panel.example.com', '/v1');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('That hostname is reserved for the NineDeploy panel');
  });

  it('reserves it against admins too — moving the panel is a settings change', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    const app = await appWith([], null);
    const res = await claim(app, 'panel.example.com', '/v1', asUser({ id: 1, isOperator: true }));
    expect(res.statusCode).toBe(409);
  });

  it('refuses a wildcard that would swallow the panel hostname', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    const app = await appWith([], null);
    expect((await claim(app, '*.example.com', '/')).statusCode).toBe(409);
  });
});
