import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, runMigrations, services, users } from '@ninedeploy/db';

/**
 * Deploy hooks against a real migrated SQLite: a member turns one on, rotates
 * or removes it; the public POST needs only the token, queues a deploy as the
 * member who made it (re-checked on every call), coalesces with a running
 * build, and never carries more operator authority than its creator had.
 */

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);
vi.mock('../src/lib/panelOrigin.js', () => ({ panelOrigin: vi.fn(async () => 'https://panel.example.com') }));

const { publicDeployHookRoutes, serviceDeployHookRoutes } = await import('../src/modules/deployHooks.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
const OWNER = 7;
const member = asUser({ id: OWNER, isOperator: false });
const tokenOf = (url: string) => /\/v1\/deploy-hooks\/([A-Za-z0-9_-]{32})$/.exec(url)![1]!;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: OWNER, email: 'owner@example.com', passwordHash: 'x' },
    { id: 9, email: 'other@example.com', passwordHash: 'x' },
  ]);
});

async function setup(values: Record<string, unknown> = {}) {
  const [svc] = await db
    .insert(services)
    .values({ name: 'api', slug: 'api', type: 'docker', image: 'nginx', branch: 'main', ownerUserId: OWNER, ...values } as never)
    .returning();
  const app = await buildTestApp({ db });
  await app.register(serviceDeployHookRoutes, { prefix: '/services' });
  await app.register(publicDeployHookRoutes, { prefix: '/deploy-hooks' });
  const call = (token: string) => app.inject({ method: 'POST', url: `/deploy-hooks/${token}` });
  const queued = async () => db.select().from(deployments).where(eq(deployments.serviceId, svc!.id));
  return { app, id: svc!.id, call, queued };
}

describe('deploy hook management', () => {
  it('is off until a member turns it on; rotating replaces the URL; off removes it', async () => {
    const { app, id, call } = await setup();
    expect((await app.inject({ method: 'GET', url: `/services/${id}/deploy-hook`, headers: member })).json()).toEqual({ enabled: false, url: null });

    const on = (await app.inject({ method: 'POST', url: `/services/${id}/deploy-hook`, headers: member })).json() as { enabled: boolean; url: string };
    expect(on.enabled).toBe(true);
    expect(on.url).toMatch(/^https:\/\/panel\.example\.com\/v1\/deploy-hooks\/[A-Za-z0-9_-]{32}$/);
    expect(auditMock.audit).toHaveBeenCalledWith(db, OWNER, 'service.deploy_hook.enable', 'api', { serviceId: id });
    expect((await app.inject({ method: 'GET', url: `/services/${id}/deploy-hook`, headers: member })).json()).toEqual(on);

    const rotated = (await app.inject({ method: 'POST', url: `/services/${id}/deploy-hook`, headers: member })).json() as { url: string };
    expect(rotated.url).not.toBe(on.url);
    expect(auditMock.audit).toHaveBeenCalledWith(db, OWNER, 'service.deploy_hook.rotate', 'api', { serviceId: id });
    expect((await call(tokenOf(on.url))).statusCode).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: `/services/${id}/deploy-hook`, headers: member })).json()).toEqual({ enabled: false, url: null });
    expect((await call(tokenOf(rotated.url))).statusCode).toBe(404);
    const row = await db.query.services.findFirst({ where: eq(services.id, id) });
    expect(row).toMatchObject({ deployHookToken: null, deployHookUserId: null, deployHookOperator: false });
    await app.close();
  });

  it('needs a member seat on the service', async () => {
    const { app, id } = await setup();
    const outsider = asUser({ id: 9, isOperator: false });
    expect((await app.inject({ method: 'GET', url: `/services/${id}/deploy-hook`, headers: outsider })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/services/${id}/deploy-hook`, headers: outsider })).statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /deploy-hooks/:token', () => {
  it('queues a deploy as the member who made the hook, and returns a running build instead of stacking', async () => {
    const { app, id, call, queued } = await setup();
    const { url } = (await app.inject({ method: 'POST', url: `/services/${id}/deploy-hook`, headers: member })).json() as { url: string };
    const res = await call(tokenOf(url));
    expect(res.statusCode).toBe(202);
    const { deploymentId } = res.json() as { deploymentId: number };
    expect(await queued()).toEqual([expect.objectContaining({ id: deploymentId, status: 'queued', message: 'Deploy hook' })]);
    expect(auditMock.audit).toHaveBeenCalledWith(db, OWNER, 'deploy.trigger', `api #${deploymentId}`, { serviceId: id, deploymentId, via: 'deploy_hook' });

    await db.update(deployments).set({ status: 'building' }).where(eq(deployments.id, deploymentId));
    const again = await call(tokenOf(url));
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ deploymentId, alreadyInProgress: true });
    expect(await queued()).toHaveLength(1);
    await app.close();
  });

  it('a malformed or unknown token, and a hook whose creator was deleted, are all a plain 404', async () => {
    const { app, id, call } = await setup();
    expect((await call('short')).statusCode).toBe(404);
    expect((await call('a'.repeat(32))).statusCode).toBe(404);
    const { url } = (await app.inject({ method: 'POST', url: `/services/${id}/deploy-hook`, headers: member })).json() as { url: string };
    // The member's account goes: the hook stops working instead of blocking the delete.
    await db.update(services).set({ ownerUserId: 1 }).where(eq(services.id, id));
    await db.delete(users).where(eq(users.id, OWNER));
    expect((await db.query.services.findFirst({ where: eq(services.id, id) }))?.deployHookUserId).toBeNull();
    expect((await call(tokenOf(url))).statusCode).toBe(404);
    await app.close();
  });

  it('a member who lost the service leaves a hook that is refused', async () => {
    const { app, id, call, queued } = await setup();
    const { url } = (await app.inject({ method: 'POST', url: `/services/${id}/deploy-hook`, headers: member })).json() as { url: string };
    await db.update(services).set({ ownerUserId: 1 }).where(eq(services.id, id));
    const res = await call(tokenOf(url));
    expect([403, 404]).toContain(res.statusCode);
    expect(await queued()).toEqual([]);
    await app.close();
  });

  it('never deploys with more operator authority than the creating request had', async () => {
    // A compose stack needs an operator to deploy (host privilege).
    const { app, id, call, queued } = await setup({ name: 'stack', slug: 'stack', type: 'compose', image: null, composeContent: 'services:\n  a:\n    image: nginx\n', ownerUserId: 1 });
    const viaScopedToken = asUser({ id: 1, isOperator: false });
    // Creating it as a narrowed operator is itself refused where a deploy would be.
    expect((await app.inject({ method: 'POST', url: `/services/${id}/deploy-hook`, headers: viaScopedToken })).statusCode).toBe(403);
    // Made as a full operator, then stored as if narrowed: the call is refused.
    const { url } = (await app.inject({ method: 'POST', url: `/services/${id}/deploy-hook`, headers: asUser() })).json() as { url: string };
    expect((await call(tokenOf(url))).statusCode).toBe(202);
    await db.update(services).set({ deployHookOperator: false }).where(eq(services.id, id));
    const refused = await call(tokenOf(url));
    expect(refused.statusCode).toBe(403);
    expect(await queued()).toHaveLength(1);
    await app.close();
  });
});
