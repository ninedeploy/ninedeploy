import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, domains, runMigrations, services, users } from '@ninedeploy/db';

/**
 * 0.16.1 domain redirect rules through `PATCH /services/:id/domains/:domainId`
 * on a real migrated SQLite: stored as given, cleared with [] or null, read
 * back by the list, and refused when Traefik's Go RE2 could not run them.
 */

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
const proxyMocks = vi.hoisted(() => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock('../src/engine/proxy.js', () => ({ ...proxyMocks, parseHeaders: () => [] }));

const { domainsRoutes } = await import('../src/modules/domains.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
const CAPTURE_1 = '\u0024{1}';

beforeEach(async () => {
  vi.clearAllMocks();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
});

async function setup() {
  const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', image: 'nginx', branch: 'main', ownerUserId: 1 } as never).returning();
  const [dom] = await db.insert(domains).values({ serviceId: svc!.id, hostname: 'example.com', status: 'active' }).returning();
  const app = await buildTestApp({ db });
  await app.register(domainsRoutes, { prefix: '/services' });
  const patch = (body: unknown) =>
    app.inject({ method: 'PATCH', url: `/services/${svc!.id}/domains/${dom!.id}`, headers: asUser(), payload: body as object });
  const row = async () => (await db.query.domains.findFirst({ where: eq(domains.id, dom!.id) }))!;
  return { app, svcId: svc!.id, patch, row };
}

describe('domain redirect rules', () => {
  it('stores the rules, rewrites routing, lists them, and clears them', async () => {
    const { app, svcId, patch, row } = await setup();
    const rules = [
      { regex: '^https://example\\.com/blog/(.*)', replacement: `https://blog.example.com/${CAPTURE_1}`, permanent: true },
      { regex: '^https://example\\.com/old$', replacement: 'https://example.com/new' },
    ];
    const res = await patch({ redirects: rules });
    expect(res.statusCode, res.body).toBe(200);
    expect((await row()).redirects).toEqual([rules[0], { ...rules[1], permanent: false }]);
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();

    const list = (await app.inject({ method: 'GET', url: `/services/${svcId}/domains`, headers: asUser() })).json() as Array<{ redirects: unknown[] }>;
    expect(list[0]!.redirects).toHaveLength(2);

    expect((await patch({ redirects: [] })).statusCode).toBe(200);
    expect((await row()).redirects).toBeNull();
    await patch({ redirects: rules });
    expect((await patch({ redirects: null })).statusCode).toBe(200);
    expect((await row()).redirects).toBeNull();
    await app.close();
  });

  it('a pre-0.16.1 domain lists no rules, and other patches leave rules alone', async () => {
    const { app, svcId, patch, row } = await setup();
    const list = (await app.inject({ method: 'GET', url: `/services/${svcId}/domains`, headers: asUser() })).json() as Array<{ redirects: unknown[] }>;
    expect(list[0]!.redirects).toEqual([]);
    await patch({ redirects: [{ regex: '^x$', replacement: 'https://y/' }] });
    await patch({ ssl: false });
    expect((await row()).redirects).toHaveLength(1);
    await app.close();
  });

  const refused: Array<[string, unknown, RegExp]> = [
    ['a lookahead', [{ regex: '^https://a/(?!keep)', replacement: 'https://b/' }], /lookahead/],
    ['a backreference', [{ regex: '(a)\\1', replacement: 'https://b/' }], /backreferences/],
    ['an invalid regex', [{ regex: '[a-', replacement: 'https://b/' }], /not a valid regular expression/],
    ['a multi-line target', [{ regex: '^a$', replacement: 'https://b/\nSet-Cookie: x' }], /one line/],
    ['more than ten rules', Array.from({ length: 11 }, () => ({ regex: '^a$', replacement: 'https://b/' })), /10/],
  ];
  for (const [what, redirects, message] of refused) {
    it(`refuses ${what} and keeps the stored rules`, async () => {
      const { app, patch, row } = await setup();
      const res = await patch({ redirects });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(message);
      expect((await row()).redirects).toBeNull();
      expect(proxyMocks.writeDynamicConfig).not.toHaveBeenCalled();
      await app.close();
    });
  }
});
