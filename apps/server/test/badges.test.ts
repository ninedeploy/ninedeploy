import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, runMigrations, services, users } from '@ninedeploy/db';

/**
 * 0.16.1 deploy status badges against a real migrated SQLite: a member turns
 * one on, rotates or removes it; the public SVG needs only the token, says
 * only the deploy state, and an old or unknown token is a 404 badge.
 */

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/panelOrigin.js', () => ({ panelOrigin: vi.fn(async () => 'https://panel.example.com') }));

const { badgeLabel, badgeState, publicBadgeRoutes, renderBadge, serviceBadgeRoutes } = await import('../src/modules/badges.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
const OWNER = 7;

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: OWNER, email: 'owner@example.com', passwordHash: 'x' },
  ]);
});

async function setup(values: Record<string, unknown> = {}) {
  const [svc] = await db
    .insert(services)
    .values({ name: 'secret-project-name', slug: 'web', type: 'docker', image: 'nginx', branch: 'main', ownerUserId: OWNER, ...values } as never)
    .returning();
  const app = await buildTestApp({ db });
  await app.register(serviceBadgeRoutes, { prefix: '/services' });
  await app.register(publicBadgeRoutes, { prefix: '/badges' });
  return { app, id: svc!.id };
}
const member = asUser({ id: OWNER, isOperator: false });
const tokenOf = (url: string) => /\/v1\/badges\/([A-Za-z0-9_-]+)\.svg$/.exec(url)![1]!;

describe('badge state', () => {
  it('an in-flight or failed newest deployment decides; otherwise the service status', () => {
    expect(badgeState('running', 'building')).toBe('deploying');
    expect(badgeState('running', 'queued')).toBe('deploying');
    expect(badgeState('running', 'failed')).toBe('failed');
    expect(badgeState('running', 'running')).toBe('running');
    expect(badgeState('running', 'superseded')).toBe('running');
    expect(badgeState('error', null)).toBe('failed');
    expect(badgeState('stopped', 'running')).toBe('stopped');
    expect(badgeState('idle', null)).toBe('not deployed');
  });

  it('a label is plain text of at most 32 characters, or "deploy"', () => {
    expect(badgeLabel('prod api')).toBe('prod api');
    expect(badgeLabel('<script>')).toBe('deploy');
    expect(badgeLabel('x'.repeat(33))).toBe('deploy');
    expect(badgeLabel(['a'])).toBe('deploy');
    expect(badgeLabel(undefined)).toBe('deploy');
  });

  it('renders escaped text', () => {
    const svg = renderBadge('a&b', 'running', '#000');
    expect(svg).toContain('a&#38;b: running');
    expect(svg).not.toContain('a&b');
  });
});

describe('badge routes', () => {
  it('off by default; a member turns it on and the public SVG shows the state, nothing else', async () => {
    const { app, id } = await setup({ status: 'running' });
    expect((await app.inject({ method: 'GET', url: `/services/${id}/badge`, headers: member })).json()).toEqual({ enabled: false, url: null });

    const on = (await app.inject({ method: 'POST', url: `/services/${id}/badge`, headers: member })).json() as { enabled: boolean; url: string };
    expect(on.enabled).toBe(true);
    expect(on.url).toMatch(/^https:\/\/panel\.example\.com\/v1\/badges\/[A-Za-z0-9_-]{32}\.svg$/);
    expect((await app.inject({ method: 'GET', url: `/services/${id}/badge`, headers: member })).json()).toEqual(on);

    const svg = await app.inject({ method: 'GET', url: `/badges/${tokenOf(on.url)}.svg` });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(svg.headers['cache-control']).toMatch(/no-cache/);
    expect(svg.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(svg.body).toContain('deploy: running');
    expect(svg.body).not.toContain('secret-project-name');
    expect(svg.body).not.toMatch(/<script/i);

    const labelled = await app.inject({ method: 'GET', url: `/badges/${tokenOf(on.url)}.svg?label=prod` });
    expect(labelled.body).toContain('prod: running');
    await app.close();
  });

  it('follows the newest deployment', async () => {
    const { app, id } = await setup({ status: 'running' });
    const url = ((await app.inject({ method: 'POST', url: `/services/${id}/badge`, headers: member })).json() as { url: string }).url;
    await db.insert(deployments).values({ serviceId: id, status: 'running' });
    await db.insert(deployments).values({ serviceId: id, status: 'failed' });
    expect((await app.inject({ method: 'GET', url: `/badges/${tokenOf(url)}.svg` })).body).toContain('deploy: failed');
    await db.insert(deployments).values({ serviceId: id, status: 'building' });
    expect((await app.inject({ method: 'GET', url: `/badges/${tokenOf(url)}.svg` })).body).toContain('deploy: deploying');
    await app.close();
  });

  it('rotating retires the old URL; turning it off retires the URL', async () => {
    const { app, id } = await setup();
    const first = ((await app.inject({ method: 'POST', url: `/services/${id}/badge`, headers: member })).json() as { url: string }).url;
    const second = ((await app.inject({ method: 'POST', url: `/services/${id}/badge`, headers: member })).json() as { url: string }).url;
    expect(second).not.toBe(first);
    const old = await app.inject({ method: 'GET', url: `/badges/${tokenOf(first)}.svg` });
    expect(old.statusCode).toBe(404);
    expect(old.body).toContain('deploy: not found');
    expect((await app.inject({ method: 'GET', url: `/badges/${tokenOf(second)}.svg` })).statusCode).toBe(200);

    expect((await app.inject({ method: 'DELETE', url: `/services/${id}/badge`, headers: member })).json()).toEqual({ enabled: false, url: null });
    expect((await app.inject({ method: 'GET', url: `/badges/${tokenOf(second)}.svg` })).statusCode).toBe(404);
    expect((await db.query.services.findFirst({ where: eq(services.id, id) }))?.badgeToken).toBeNull();
    await app.close();
  });

  it('a malformed token is a 404 badge without a lookup', async () => {
    const { app } = await setup();
    for (const t of ['x', "'; drop table services; --", 'a'.repeat(33)]) {
      const res = await app.inject({ method: 'GET', url: `/badges/${encodeURIComponent(t)}.svg` });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });

  it('the token never appears in the service API', async () => {
    const { app, id } = await setup();
    await app.register(servicesRoutes, { prefix: '/api' });
    const url = ((await app.inject({ method: 'POST', url: `/services/${id}/badge`, headers: member })).json() as { url: string }).url;
    const detail = await app.inject({ method: 'GET', url: `/api/${id}`, headers: asUser() });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(tokenOf(url));
    await app.close();
  });
});
