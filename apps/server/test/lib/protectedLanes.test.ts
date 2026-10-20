import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accessGrants,
  createDb,
  type DB,
  deployments,
  environments,
  runMigrations,
  services,
  serviceWorkspaces,
  users,
  workspaceMembers,
  workspaces,
} from '@ninedeploy/db';
import { enqueueUserDeploy } from '../../src/lib/deployQueue.js';
import {
  approvalStamp,
  assertMayLeaveLane,
  dropStaleApprovals,
  holdForApprovalIfNeeded,
  isLaneAdmin,
  laneRules,
  maySeeLaneSecrets,
} from '../../src/lib/protectedLanes.js';

/** 0.16.13 lib/protectedLanes.ts against a real migrated SQLite. */

let db: DB;
const ADMIN = { id: 2, isOperator: false };
const MEMBER = { id: 3, isOperator: false };
const GRANTEE = { id: 4, isOperator: false };
const OPERATOR = { id: 1, isOperator: true };
const svc = async (id: number) => (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, id) }))!;

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: 2, email: 'admin@example.com', passwordHash: 'x' },
    { id: 3, email: 'member@example.com', passwordHash: 'x' },
    { id: 4, email: 'grantee@example.com', passwordHash: 'x' },
  ]);
  await db.insert(workspaces).values({ id: 1, name: 'Acme', slug: 'acme', ownerId: 2 });
  await db.insert(workspaceMembers).values([
    { workspaceId: 1, userId: 2, role: 'admin' },
    { workspaceId: 1, userId: 3, role: 'member' },
  ]);
  await db.insert(environments).values([
    { id: 1, workspaceId: 1, name: 'production', slug: 'production', protected: true, requireApproval: true },
    { id: 2, workspaceId: 1, name: 'staging', slug: 'staging' },
  ]);
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 3, environmentId: 1 },
    { id: 6, name: 'stage', slug: 'stage', type: 'docker', branch: 'main', ownerUserId: 3, environmentId: 2 },
    { id: 7, name: 'loose', slug: 'loose', type: 'docker', branch: 'main', ownerUserId: 3 },
    { id: 8, name: 'web-pr', slug: 'web-pr', type: 'docker', branch: 'pr', ownerUserId: 3, previewParentServiceId: 5 },
  ] as never);
  await db.insert(serviceWorkspaces).values([5, 6, 7, 8].map((serviceId) => ({ serviceId, workspaceId: 1 })));
  await db.insert(accessGrants).values({ workspaceId: 1, userId: 4, environmentId: 1, targetKey: 'env:1', role: 'admin' });
});

describe('laneRules', () => {
  it("reads a lane's switches, a preview's through its parent, and null outside any lane", async () => {
    expect(await laneRules(db, await svc(5))).toEqual({ id: 1, workspaceId: 1, name: 'production', protected: true, requireApproval: true });
    expect((await laneRules(db, await svc(8)))?.id).toBe(1);
    expect(await laneRules(db, await svc(7))).toBeNull();
    expect(await laneRules(db, { environmentId: 99 })).toBeNull();
    expect(await laneRules(db, { environmentId: null, previewParentServiceId: 99 })).toBeNull();
  });
});

describe('isLaneAdmin', () => {
  it('counts operators, admin seats in the lane workspace and admin grants — not the creator', async () => {
    const web = await svc(5);
    expect(await isLaneAdmin(db, web, OPERATOR)).toBe(true);
    expect(await isLaneAdmin(db, web, ADMIN)).toBe(true);
    expect(await isLaneAdmin(db, web, GRANTEE)).toBe(true);
    expect(await isLaneAdmin(db, web, MEMBER)).toBe(false);
    // Outside any lane: admin on the service, and the creator owns it.
    expect(await isLaneAdmin(db, await svc(7), MEMBER)).toBe(true);
    expect(await isLaneAdmin(db, await svc(7), { id: 4, isOperator: false })).toBe(false);
  });
});

describe('maySeeLaneSecrets', () => {
  it('is true outside a protected lane and for its admins', async () => {
    expect(await maySeeLaneSecrets(db, await svc(6), MEMBER)).toBe(true);
    expect(await maySeeLaneSecrets(db, await svc(5), MEMBER)).toBe(false);
    expect(await maySeeLaneSecrets(db, await svc(8), MEMBER)).toBe(false);
    expect(await maySeeLaneSecrets(db, await svc(5), ADMIN)).toBe(true);
  });
});

describe('assertMayLeaveLane', () => {
  it('guards leaving a protected or gated lane only', async () => {
    await expect(assertMayLeaveLane(db, await svc(5), MEMBER, 1)).resolves.toBeUndefined();
    await expect(assertMayLeaveLane(db, await svc(5), MEMBER, 2)).rejects.toMatchObject({ statusCode: 403, code: 'protected_lane' });
    await expect(assertMayLeaveLane(db, await svc(5), ADMIN, null)).resolves.toBeUndefined();
    await expect(assertMayLeaveLane(db, await svc(6), MEMBER, 1)).resolves.toBeUndefined();
    await expect(assertMayLeaveLane(db, await svc(7), MEMBER, 1)).resolves.toBeUndefined();
    await db.update(environments).set({ protected: false });
    await expect(assertMayLeaveLane(db, await svc(5), MEMBER, null)).rejects.toMatchObject({ code: 'protected_lane' });
  });
});

describe('approvalStamp and enqueueUserDeploy', () => {
  it("approves an admin's own deploy at insert, never a member's or a deploy hook's", async () => {
    expect(await approvalStamp(db, await svc(5), ADMIN)).toEqual({ reviewedBy: 2, reviewedAt: expect.any(Date) });
    expect(await approvalStamp(db, await svc(5), MEMBER)).toEqual({});
    expect(await approvalStamp(db, await svc(6), ADMIN)).toEqual({});

    const byAdmin = await enqueueUserDeploy(db, ADMIN, await svc(5), { message: 'manual' });
    const byMember = await enqueueUserDeploy(db, MEMBER, await svc(5), { message: 'manual' });
    const byHook = await enqueueUserDeploy(db, ADMIN, await svc(5), { message: 'Deploy hook' }, { selfApproval: false });
    const preview = await enqueueUserDeploy(db, ADMIN, await svc(8), { message: 'manual' });
    const rows = await db.query.deployments.findMany();
    const by = (id: number) => rows.find((r) => r.id === id)!;
    expect(by(byAdmin)).toMatchObject({ status: 'queued', reviewedBy: 2 });
    expect(by(byMember)).toMatchObject({ status: 'queued', reviewedBy: null, reviewedAt: null });
    expect(by(byHook).reviewedBy).toBeNull();
    expect(by(preview).reviewedBy).toBe(2);
  });
});

describe('holdForApprovalIfNeeded and dropStaleApprovals', () => {
  it('holds only an unreviewed queued row in a gated lane', async () => {
    await db.insert(deployments).values([
      { id: 1, serviceId: 5, status: 'queued', trigger: 'webhook' },
      { id: 2, serviceId: 5, status: 'queued', trigger: 'user', reviewedBy: 2, reviewedAt: new Date() },
      { id: 3, serviceId: 6, status: 'queued', trigger: 'webhook' },
      { id: 4, serviceId: 5, status: 'building', trigger: 'webhook' },
    ]);
    const row = (id: number, s: { environmentId: number | null; previewParentServiceId?: number | null }, reviewedAt: Date | null = null) => ({
      id,
      environmentId: s.environmentId,
      previewParentServiceId: s.previewParentServiceId ?? null,
      reviewedAt,
    });
    expect(await holdForApprovalIfNeeded(db, row(1, { environmentId: 1 }))).toBe(true);
    expect(await holdForApprovalIfNeeded(db, row(2, { environmentId: 1 }, new Date()))).toBe(false);
    expect(await holdForApprovalIfNeeded(db, row(3, { environmentId: 2 }))).toBe(false);
    expect(await holdForApprovalIfNeeded(db, row(4, { environmentId: 1 }))).toBe(false); // not queued any more
    expect(await holdForApprovalIfNeeded(db, row(5, { environmentId: null }))).toBe(false);
    const statuses = Object.fromEntries((await db.query.deployments.findMany()).map((d) => [d.id, d.status]));
    expect(statuses).toEqual({ 1: 'awaiting_approval', 2: 'queued', 3: 'queued', 4: 'building' });
  });

  it("ends a service's older waiting deploys only", async () => {
    await db.insert(deployments).values([
      { id: 1, serviceId: 5, status: 'awaiting_approval', trigger: 'webhook' },
      { id: 2, serviceId: 6, status: 'awaiting_approval', trigger: 'webhook' },
      { id: 3, serviceId: 5, status: 'queued', trigger: 'webhook' },
      { id: 4, serviceId: 5, status: 'awaiting_approval', trigger: 'webhook' },
    ]);
    expect(await dropStaleApprovals(db, 5, 3)).toEqual([1]);
    const statuses = Object.fromEntries((await db.query.deployments.findMany()).map((d) => [d.id, d.status]));
    expect(statuses).toEqual({ 1: 'cancelled', 2: 'awaiting_approval', 3: 'queued', 4: 'awaiting_approval' });
  });
});
