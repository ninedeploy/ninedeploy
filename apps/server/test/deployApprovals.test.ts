import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  type DB,
  deployments,
  environments,
  envVars,
  runMigrations,
  serviceFiles,
  services,
  serviceWorkspaces,
  users,
  workspaceMembers,
  workspaces,
} from '@ninedeploy/db';

/**
 * 0.16.13 protected lanes and deploy approvals, against a real migrated
 * SQLite: the lane switches, the approve / reject / withdraw routes, the
 * approvals list, and what a protected lane keeps from a member (variable
 * values, logs, mounted files, clones, moving the service out).
 */

const audit = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('../src/lib/audit.js', () => ({ audit }));

const { deploysRoutes } = await import('../src/modules/deploys.js');
const { environmentRoutes } = await import('../src/modules/environments.js');
const { envRoutes } = await import('../src/modules/env.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { serviceFileRoutes } = await import('../src/modules/serviceFiles.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
let app: Awaited<ReturnType<typeof buildTestApp>>;
/** Admin seat in workspace 1. */
const ADMIN = asUser({ id: 2, isOperator: false });
/** Member seat in workspace 1, and the creator of `web` — creator is not lane admin. */
const MEMBER = asUser({ id: 3, isOperator: false });
const OPERATOR = asUser({ id: 1, isOperator: true });

const dep = async (id: number) => (await db.query.deployments.findFirst({ where: (d, { eq }) => eq(d.id, id) }))!;
const lane = async (patch: Partial<typeof environments.$inferInsert>) => {
  await db.update(environments).set(patch);
};

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: 2, email: 'admin@example.com', passwordHash: 'x', name: 'Ada' },
    { id: 3, email: 'member@example.com', passwordHash: 'x' },
  ]);
  await db.insert(workspaces).values({ id: 1, name: 'Acme', slug: 'acme', ownerId: 2 });
  await db.insert(workspaceMembers).values([
    { workspaceId: 1, userId: 2, role: 'admin' },
    { workspaceId: 1, userId: 3, role: 'member' },
  ]);
  await db.insert(environments).values({ id: 1, workspaceId: 1, name: 'production', slug: 'production' });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 3, environmentId: 1, runtimeId: 'web-9' },
    { id: 6, name: 'tool', slug: 'tool', type: 'docker', branch: 'main', ownerUserId: 3 },
    { id: 7, name: 'web-pr-1', slug: 'web-pr-1', type: 'docker', branch: 'pr', ownerUserId: 3, previewParentServiceId: 5, isEphemeralPreview: true },
  ] as never);
  await db.insert(serviceWorkspaces).values([
    { serviceId: 5, workspaceId: 1 },
    { serviceId: 6, workspaceId: 1 },
    { serviceId: 7, workspaceId: 1 },
  ]);
  await db.insert(envVars).values([
    { serviceId: 5, scope: 'service', scopeKey: 5, key: 'DATABASE_URL', valueEncrypted: encrypt('postgres://prod'), isSecret: false },
    { serviceId: 5, scope: 'service', scopeKey: 5, key: 'API_KEY', valueEncrypted: encrypt('k'), isSecret: true },
  ]);
  app = await buildTestApp({ db });
  await app.register(environmentRoutes, { prefix: '/v1/environments' });
  await app.register(servicesRoutes, { prefix: '/v1/services' });
  await app.register(deploysRoutes, { prefix: '/v1/services' });
  await app.register(envRoutes, { prefix: '/v1/services' });
  await app.register(serviceFileRoutes, { prefix: '/v1/services' });
  audit.mockClear();
});
afterEach(async () => {
  await app.close();
});

describe('PATCH /v1/environments/:id switches', () => {
  it('are off by default, need admin, and are audited when they change', async () => {
    const list = (await app.inject({ url: '/v1/environments', headers: MEMBER })).json();
    expect(list[0]).toMatchObject({ protected: false, requireApproval: false });

    const refused = await app.inject({ method: 'PATCH', url: '/v1/environments/1', headers: MEMBER, payload: { protected: true } });
    expect(refused.statusCode).toBe(403);
    // A rename alone stays a member's.
    expect((await app.inject({ method: 'PATCH', url: '/v1/environments/1', headers: MEMBER, payload: { name: 'prod' } })).statusCode).toBe(200);

    const on = await app.inject({
      method: 'PATCH',
      url: '/v1/environments/1',
      headers: ADMIN,
      payload: { protected: true, requireApproval: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ name: 'prod', protected: true, requireApproval: true });
    const actions = audit.mock.calls.map((c) => c[2]);
    expect(actions).toEqual(expect.arrayContaining(['environment.protect', 'environment.approval_on']));

    audit.mockClear();
    await app.inject({ method: 'PATCH', url: '/v1/environments/1', headers: ADMIN, payload: { protected: true, requireApproval: false } });
    const again = audit.mock.calls.map((c) => c[2]);
    expect(again).toContain('environment.approval_off');
    expect(again).not.toContain('environment.protect');
    await app.inject({ method: 'PATCH', url: '/v1/environments/1', headers: ADMIN, payload: { protected: false } });
    expect(audit.mock.calls.map((c) => c[2])).toContain('environment.unprotect');
  });
});

describe('approving and rejecting', () => {
  beforeEach(async () => {
    await lane({ requireApproval: true });
    await db.insert(deployments).values([
      { id: 40, serviceId: 5, status: 'awaiting_approval', trigger: 'webhook', commitSha: 'abc1234' },
      { id: 41, serviceId: 5, status: 'running', trigger: 'user' },
    ]);
  });

  it('lets a lane admin approve; the creator of the service may not', async () => {
    const byCreator = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/approve', headers: MEMBER });
    expect(byCreator.statusCode).toBe(403);
    expect(byCreator.json().error.message).toBe('Only a workspace admin may approve or reject a deploy into this lane');

    const res = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/approve', headers: ADMIN });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'queued' });
    const row = await dep(40);
    expect(row).toMatchObject({ status: 'queued', reviewedBy: 2 });
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(audit).toHaveBeenCalledWith(expect.anything(), 2, 'deploy.approve', 'web #40', { serviceId: 5 });

    const list = (await app.inject({ url: '/v1/services/5/deploys', headers: MEMBER })).json();
    expect(list.find((d: { id: number }) => d.id === 40)).toMatchObject({ reviewedBy: 'Ada', reviewedAt: expect.any(String) });
    expect(list.find((d: { id: number }) => d.id === 41)).toMatchObject({ reviewedBy: null, reviewedAt: null });

    const twice = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/approve', headers: ADMIN });
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.code).toBe('not_awaiting_approval');
  });

  it('rejects into cancelled, and an operator may decide too', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/reject', headers: OPERATOR });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'cancelled' });
    expect(await dep(40)).toMatchObject({ status: 'cancelled', reviewedBy: 1 });
    expect((await dep(40)).finishedAt).toBeInstanceOf(Date);
    expect(audit).toHaveBeenCalledWith(expect.anything(), 1, 'deploy.reject', 'web #40', { serviceId: 5 });
  });

  it('answers 404 for a deploy of another service and 400 for one that is not waiting', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/services/6/deploys/40/approve', headers: OPERATOR })).statusCode).toBe(404);
    const notWaiting = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/41/reject', headers: ADMIN });
    expect(notWaiting.json().error.code).toBe('not_awaiting_approval');
  });

  it('still decides after the lane switch is turned off, by the service admin when it has no lane', async () => {
    await lane({ requireApproval: false });
    expect((await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/approve', headers: ADMIN })).statusCode).toBe(200);
    await db.insert(deployments).values({ id: 42, serviceId: 6, status: 'awaiting_approval', trigger: 'user' });
    // No lane: `admin` on the service decides, and the creator is its owner.
    expect((await app.inject({ method: 'POST', url: '/v1/services/6/deploys/42/approve', headers: MEMBER })).statusCode).toBe(200);
  });

  it('lets anyone who may cancel withdraw a waiting deploy, and refuses to delete one', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/v1/services/5/deploys/40', headers: ADMIN });
    expect(del.statusCode).toBe(400);
    expect(del.json().error.message).toContain('waiting for approval');
    const res = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/cancel', headers: MEMBER });
    expect(res.statusCode, res.body).toBe(200);
    expect((await dep(40)).status).toBe('cancelled');
  });

  it('lists the waiting deploys a caller can see, saying who may decide', async () => {
    await db.insert(deployments).values({ id: 43, serviceId: 6, status: 'awaiting_approval', trigger: 'user' });
    const asMember = (await app.inject({ url: '/v1/services/approvals', headers: MEMBER })).json();
    expect(asMember.count).toBe(2);
    expect(asMember.items.map((i: { id: number; mayReview: boolean }) => [i.id, i.mayReview])).toEqual([
      [40, false],
      [43, true],
    ]);
    expect(asMember.items[0]).toMatchObject({ serviceName: 'web', status: 'awaiting_approval', commitSha: 'abc1234' });
    const asAdmin = (await app.inject({ url: '/v1/services/approvals', headers: ADMIN })).json();
    expect(asAdmin.items.every((i: { mayReview: boolean }) => i.mayReview)).toBe(true);
    await db.insert(users).values({ id: 9, email: 'stranger@example.com', passwordHash: 'x' });
    expect((await app.inject({ url: '/v1/services/approvals', headers: asUser({ id: 9, isOperator: false }) })).json()).toEqual({ items: [], count: 0 });
  });
});

describe('a protected lane', () => {
  beforeEach(async () => {
    await lane({ protected: true });
  });

  it('hides variable values from a member, not from an admin', async () => {
    const asMember = (await app.inject({ url: '/v1/services/5/env', headers: MEMBER })).json();
    expect(asMember).toEqual([
      { id: 2, key: 'API_KEY', value: '', isSecret: true, hidden: true },
      { id: 1, key: 'DATABASE_URL', value: '', isSecret: false, hidden: true },
    ]);
    const asAdmin = (await app.inject({ url: '/v1/services/5/env', headers: ADMIN })).json();
    expect(asAdmin.find((v: { key: string }) => v.key === 'DATABASE_URL')).toEqual({ id: 1, key: 'DATABASE_URL', value: 'postgres://prod', isSecret: false });
    // A member still writes; the answer does not echo the stored value back.
    const write = await app.inject({ method: 'PATCH', url: '/v1/services/5/env/1', headers: MEMBER, payload: { key: 'DATABASE_URL', value: 'postgres://new' } });
    expect(write.statusCode, write.body).toBe(200);
    expect(write.json()).toMatchObject({ value: '', hidden: true });
    const created = await app.inject({ method: 'POST', url: '/v1/services/5/env', headers: MEMBER, payload: { key: 'NEW', value: 'v' } });
    expect(created.json()).toMatchObject({ key: 'NEW', value: '', hidden: true });
    // Outside the lane nothing changes.
    await db.insert(envVars).values({ serviceId: 6, scope: 'service', scopeKey: 6, key: 'X', valueEncrypted: encrypt('1'), isSecret: false });
    expect((await app.inject({ url: '/v1/services/6/env', headers: MEMBER })).json()).toEqual([{ id: 4, key: 'X', value: '1', isSecret: false }]);
  });

  it("covers a PR preview through its parent's lane", async () => {
    await db.insert(envVars).values({ serviceId: 7, scope: 'service', scopeKey: 7, key: 'P', valueEncrypted: encrypt('p'), isSecret: false });
    expect((await app.inject({ url: '/v1/services/7/env', headers: MEMBER })).json()[0]).toMatchObject({ value: '', hidden: true });
    const logs = await app.inject({ url: '/v1/services/7/deploys/99/logs/download', headers: MEMBER });
    expect(logs.statusCode).toBe(404); // no such deploy — the binding check runs first
  });

  it('refuses the export, logs, files and clone to the creator who is only a member', async () => {
    await db.insert(deployments).values({ id: 50, serviceId: 5, status: 'running', trigger: 'user' });
    await db.insert(serviceFiles).values({ serviceId: 5, containerPath: '/app/key.pem', contentEncrypted: encrypt('pem'), size: 3 } as never);
    const refusals = [
      await app.inject({ url: '/v1/services/5/env/export', headers: MEMBER }),
      await app.inject({ url: '/v1/services/5/deploys/50/logs/download', headers: MEMBER }),
      await app.inject({ url: '/v1/services/5/logs', headers: MEMBER }),
      await app.inject({ url: '/v1/services/5/files/1', headers: MEMBER }),
      await app.inject({ method: 'POST', url: '/v1/services/5/clone', headers: MEMBER, payload: {} }),
    ];
    for (const r of refusals) {
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error.code).toBe('protected_lane');
    }
    expect(refusals[0]!.json().error.message).toBe('"production" is a protected lane: its variable values are for workspace admins only');
    // The admin passes the lane check (the export answers; the file reads back).
    expect((await app.inject({ url: '/v1/services/5/env/export', headers: ADMIN })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/services/5/files/1', headers: ADMIN })).json().content).toBe('pem');
  });

  it('keeps a member from moving the service out of the lane, not into one', async () => {
    const out = await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: MEMBER, payload: { environmentId: null } });
    expect(out.statusCode).toBe(403);
    expect(out.json().error).toMatchObject({ code: 'protected_lane', message: 'Only a workspace admin may move a service out of the "production" lane' });
    const into = await app.inject({ method: 'PATCH', url: '/v1/services/6', headers: MEMBER, payload: { environmentId: 1 } });
    expect(into.statusCode, into.body).toBe(200);
    const byAdmin = await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: ADMIN, payload: { environmentId: null } });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
  });
});
