import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, services, uptimeDaily, users } from '@ninedeploy/db';

/**
 * 0.16.8 `/v1/monitors`, `/v1/status-pages` and the public `/v1/status/:slug`
 * and `/status/:slug` against a real migrated SQLite: operators manage,
 * members read only the monitors of services they can see, and a public page
 * shows names and history — never a target — only once published.
 */

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
const probe = vi.hoisted(() => ({
  probeMonitor: vi.fn(async (..._a: unknown[]) => ({ ok: false, responseMs: null, statusCode: 503, error: 'status 503 (expected 200-399)', certExpiresAt: null })),
}));
vi.mock('../src/lib/uptime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/uptime.js')>()),
  probeMonitor: probe.probeMonitor,
}));

const { monitorRoutes, statusPageRoutes, publicStatusRoutes, publicStatusHtmlRoutes } = await import('../src/modules/uptime.js');
const { clearStatusPageCache } = await import('../src/lib/statusPage.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
let app: Awaited<ReturnType<typeof buildTestApp>>;
const OP = asUser({ id: 1, isOperator: true });
const MEMBER = asUser({ id: 2, isOperator: false });

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: 2, email: 'member@example.com', passwordHash: 'x' },
  ]);
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2 },
    { id: 6, name: 'secret', slug: 'secret', type: 'docker', branch: 'main', ownerUserId: 1 },
  ] as never);
  app = await buildTestApp({ db });
  await app.register(monitorRoutes, { prefix: '/v1/monitors' });
  await app.register(statusPageRoutes, { prefix: '/v1/status-pages' });
  await app.register(publicStatusRoutes, { prefix: '/v1/status' });
  await app.register(publicStatusHtmlRoutes);
  clearStatusPageCache();
});
afterEach(async () => {
  await app.close();
});

const create = async (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/monitors', headers: OP, payload: body });

describe('/v1/monitors', () => {
  it('an operator creates, lists, patches and deletes; a member cannot write', async () => {
    const res = await create({ name: 'Web', kind: 'http', target: 'https://web.example.com/health', serviceId: 5 });
    expect(res.statusCode, res.body).toBe(201);
    const m = res.json();
    expect(m).toMatchObject({ name: 'Web', serviceId: 5, status: 'pending', enabled: true, intervalSeconds: 60, uptime: { h24: null, d7: null, d30: null } });
    expect((await app.inject({ method: 'POST', url: '/v1/monitors', headers: MEMBER, payload: { name: 'x', kind: 'tcp', target: 'a:1' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/v1/monitors/${m.id}`, headers: MEMBER, payload: { enabled: false } })).statusCode).toBe(403);

    const paused = await app.inject({ method: 'PATCH', url: `/v1/monitors/${m.id}`, headers: OP, payload: { enabled: false } });
    expect(paused.json()).toMatchObject({ enabled: false, status: 'paused' });
    const resumed = await app.inject({ method: 'PATCH', url: `/v1/monitors/${m.id}`, headers: OP, payload: { enabled: true } });
    expect(resumed.json()).toMatchObject({ enabled: true, status: 'pending' });
    const retarget = await app.inject({ method: 'PATCH', url: `/v1/monitors/${m.id}`, headers: OP, payload: { name: 'Web 2', target: 'https://web.example.com/ready' } });
    expect(retarget.json()).toMatchObject({ name: 'Web 2', status: 'pending', lastCheckedAt: null });

    expect((await app.inject({ method: 'DELETE', url: `/v1/monitors/${m.id}`, headers: OP })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'DELETE', url: `/v1/monitors/${m.id}`, headers: OP })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/v1/monitors/${m.id}`, headers: OP, payload: { enabled: false } })).statusCode).toBe(404);
  });

  it('a disabled monitor starts paused; an unknown service is refused', async () => {
    expect((await create({ name: 'Off', kind: 'tcp', target: 'db:5432', enabled: false })).json()).toMatchObject({ status: 'paused' });
    const res = await create({ name: 'x', kind: 'tcp', target: 'db:5432', serviceId: 999 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('service_not_found');
  });

  it('a patch is checked against the merged monitor', async () => {
    const m = (await create({ name: 'DB', kind: 'tcp', target: 'db:5432' })).json();
    const bad = async (payload: Record<string, unknown>) => (await app.inject({ method: 'PATCH', url: `/v1/monitors/${m.id}`, headers: OP, payload })).json().error.message;
    expect(await bad({ target: 'https://x.example' })).toMatch(/host:port/);
    expect(await bad({ keyword: 'ok' })).toMatch(/applies to HTTP checks/);
    expect(await bad({ serviceId: 999 })).toBe('Service not found');
    const h = (await create({ name: 'H', kind: 'http', target: 'https://x.example', keyword: 'ok' })).json();
    const head = await app.inject({ method: 'PATCH', url: `/v1/monitors/${h.id}`, headers: OP, payload: { method: 'HEAD' } });
    expect(head.json().error.message).toMatch(/HEAD request has no body/);
    const tcp = await app.inject({ method: 'PATCH', url: `/v1/monitors/${h.id}`, headers: OP, payload: { kind: 'tcp', target: 'x.example:443', keyword: null } });
    expect(tcp.json()).toMatchObject({ kind: 'tcp', keyword: null });
  });

  it('a member sees only the monitors of services they can see; others are 404', async () => {
    const mine = (await create({ name: 'Mine', kind: 'tcp', target: 'web:80', serviceId: 5 })).json();
    const theirs = (await create({ name: 'Theirs', kind: 'tcp', target: 'secret:80', serviceId: 6 })).json();
    const opOnly = (await create({ name: 'Host', kind: 'tcp', target: '10.0.0.1:22' })).json();
    expect((await app.inject({ method: 'GET', url: '/v1/monitors', headers: MEMBER })).json().map((m: { name: string }) => m.name)).toEqual(['Mine']);
    expect((await app.inject({ method: 'GET', url: '/v1/monitors', headers: OP })).json()).toHaveLength(3);
    expect((await app.inject({ method: 'GET', url: '/v1/monitors?serviceId=6', headers: OP })).json().map((m: { name: string }) => m.name)).toEqual(['Theirs']);
    expect((await app.inject({ method: 'GET', url: `/v1/monitors/${mine.id}`, headers: MEMBER })).statusCode).toBe(200);
    for (const id of [theirs.id, opOnly.id, 999]) {
      expect((await app.inject({ method: 'GET', url: `/v1/monitors/${id}`, headers: MEMBER })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/v1/monitors/${id}/checks`, headers: MEMBER })).statusCode).toBe(404);
    }
  });

  it('checking now records the result, and the checks list reads it back', async () => {
    const m = (await create({ name: 'Web', kind: 'http', target: 'https://web.example.com/', serviceId: 5, failuresBeforeDown: 1 })).json();
    const res = await app.inject({ method: 'POST', url: `/v1/monitors/${m.id}/check`, headers: OP });
    expect(res.json()).toMatchObject({ check: { ok: false, statusCode: 503 }, monitor: { status: 'down', lastError: 'status 503 (expected 200-399)', uptime: { h24: 0 } } });
    expect((await app.inject({ method: 'POST', url: '/v1/monitors/999/check', headers: OP })).statusCode).toBe(404);
    const checks = await app.inject({ method: 'GET', url: `/v1/monitors/${m.id}/checks?hours=500`, headers: MEMBER });
    expect(checks.json()).toMatchObject([{ ok: false, statusCode: 503, error: 'status 503 (expected 200-399)' }]);
  });
});

describe('/v1/status-pages and the public page', () => {
  it('is operator only; a slug is unique and its monitors must exist', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/status-pages', headers: MEMBER })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/v1/status-pages', headers: OP, payload: { slug: 'acme', title: 'Acme' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: 'acme', published: false, monitorIds: [], path: '/status/acme' });
    const dup = await app.inject({ method: 'POST', url: '/v1/status-pages', headers: OP, payload: { slug: 'acme', title: 'Again' } });
    expect(dup.statusCode).toBe(409);
    const other = (await app.inject({ method: 'POST', url: '/v1/status-pages', headers: OP, payload: { slug: 'other', title: 'Other' } })).json();
    expect((await app.inject({ method: 'PATCH', url: `/v1/status-pages/${other.id}`, headers: OP, payload: { slug: 'acme' } })).statusCode).toBe(409);
    const missing = await app.inject({ method: 'POST', url: '/v1/status-pages', headers: OP, payload: { slug: 'x', title: 'x', monitorIds: [42] } });
    expect(missing.json().error).toMatchObject({ code: 'monitor_not_found', message: 'Monitor not found: 42' });
    expect((await app.inject({ method: 'GET', url: `/v1/status-pages/${other.id}`, headers: OP })).json().slug).toBe('other');
    expect((await app.inject({ method: 'GET', url: '/v1/status-pages/999', headers: OP })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/v1/status-pages/999', headers: OP, payload: { title: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/status-pages', headers: OP })).json()).toHaveLength(2);
    expect((await app.inject({ method: 'DELETE', url: `/v1/status-pages/${other.id}`, headers: OP })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'DELETE', url: `/v1/status-pages/${other.id}`, headers: OP })).statusCode).toBe(404);
  });

  it('a published page shows names, states and history — never a target — and 404s otherwise', async () => {
    const web = (await create({ name: 'Website', kind: 'http', target: 'https://internal-web.example.com/health', serviceId: 5, failuresBeforeDown: 1 })).json();
    const db2 = (await create({ name: 'Database', kind: 'tcp', target: '10.0.0.9:5432' })).json();
    await app.inject({ method: 'POST', url: `/v1/monitors/${web.id}/check`, headers: OP }); // down
    probe.probeMonitor.mockResolvedValueOnce({ ok: true, responseMs: 12, statusCode: null, error: null, certExpiresAt: null });
    await app.inject({ method: 'POST', url: `/v1/monitors/${db2.id}/check`, headers: OP }); // up
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db.insert(uptimeDaily).values({ monitorId: db2.id, day: yesterday, checks: 10, failures: 0, responseMsSum: 120 });
    const page = (
      await app.inject({
        method: 'POST',
        url: '/v1/status-pages',
        headers: OP,
        payload: { slug: 'acme', title: 'Acme <status>', notice: 'Maintenance at 22:00', monitorIds: [db2.id, web.id] },
      })
    ).json();
    // Unpublished: 404 to everyone, JSON and HTML alike.
    expect((await app.inject({ method: 'GET', url: '/v1/status/acme' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/status/acme' })).statusCode).toBe(404);
    const pub = await app.inject({ method: 'PATCH', url: `/v1/status-pages/${page.id}`, headers: OP, payload: { published: true } });
    expect(pub.statusCode, pub.body).toBe(200);

    const json = await app.inject({ method: 'GET', url: '/v1/status/acme' });
    expect(json.statusCode).toBe(200);
    expect(json.headers['cache-control']).toBe('public, max-age=30');
    const body = json.json();
    expect(body).toMatchObject({ title: 'Acme <status>', notice: 'Maintenance at 22:00', overall: 'degraded' });
    expect(body.monitors.map((m: { name: string; status: string }) => [m.name, m.status])).toEqual([
      ['Database', 'up'],
      ['Website', 'down'],
    ]);
    expect(body.monitors[0]).toMatchObject({ uptime90d: 100, avgResponseMs: 12 }); // 10 seeded checks at 12 ms, and the one just made
    expect(body.monitors[0].days).toHaveLength(90);
    expect(body.monitors[0].days.at(-1)).toEqual({ day: today, uptime: 100 });
    expect(JSON.stringify(body)).not.toMatch(/internal-web|10\.0\.0\.9|5432/);

    const html = await app.inject({ method: 'GET', url: '/status/acme' });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.body).toContain('Acme &lt;status&gt;');
    expect(html.body).toContain('Some systems are down');
    expect(html.body).not.toContain('<script');
    expect(html.body).not.toMatch(/internal-web|10\.0\.0\.9/);

    // Hiding response times, and a bad slug, are both handled.
    await app.inject({ method: 'PATCH', url: `/v1/status-pages/${page.id}`, headers: OP, payload: { showResponseTimes: false } });
    expect((await app.inject({ method: 'GET', url: '/v1/status/acme' })).json().monitors[0].avgResponseMs).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/v1/status/Not_A_Slug' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/status/Not_A_Slug' })).statusCode).toBe(404);
  });
});
