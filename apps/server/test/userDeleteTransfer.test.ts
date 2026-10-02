/**
 * r540 — deleting a user must not delete the workspaces they own.
 *
 * `workspaces.owner_id` is ON DELETE CASCADE, so `DELETE /v1/users/:id` on a
 * workspace owner used to take the whole workspace with it: projects,
 * environments, labels, invitations and every OTHER member's seat. Runs
 * against a real migrated SQLite file: the bug is the foreign-key cascade
 * itself, which a fake db cannot reproduce.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  createDb,
  type DB,
  projects,
  services,
  serviceWorkspaces,
  users,
  workspaceMembers,
  workspaces,
} from '@ninedeploy/db';
import { userRoutes } from '../src/modules/users.js';
import { asUser, buildTestApp } from './helpers.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dir: string;
let app: FastifyInstance;
let operatorId: number;
let ownerId: number;
let colleagueId: number;
let workspaceId: number;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-userdel-'));
  const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await created.ready;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [op] = await db.insert(users).values({ email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true }).returning();
  const [owner] = await db.insert(users).values({ email: 'owner@example.com', passwordHash: 'x' }).returning();
  const [colleague] = await db.insert(users).values({ email: 'colleague@example.com', passwordHash: 'x' }).returning();
  operatorId = op!.id;
  ownerId = owner!.id;
  colleagueId = colleague!.id;
  const [ws] = await db.insert(workspaces).values({ name: 'Team', slug: 'team', ownerId }).returning();
  workspaceId = ws!.id;
  await db.insert(workspaceMembers).values([
    { workspaceId, userId: ownerId, role: 'owner' },
    { workspaceId, userId: colleagueId, role: 'member' },
  ]);
  await db.insert(projects).values({ workspaceId, name: 'Shop', slug: 'shop' });
  app = await buildTestApp({ db });
  await app.register(userRoutes);
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

const headersFor = (id: number) => ({ ...asUser(), 'x-test-user': String(id) });

describe('r540: deleting a workspace owner', () => {
  it('transfers the workspace to the acting operator instead of cascading it away', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/${ownerId}`, headers: headersFor(operatorId) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, transferredWorkspaces: [workspaceId], transferredTo: operatorId });

    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    expect(ws?.ownerId).toBe(operatorId);
    // The other member's seat and the workspace's projects survive.
    expect(await db.select().from(projects).where(eq(projects.workspaceId, workspaceId))).toHaveLength(1);
    const seats = await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    expect(seats.map((s) => [s.userId, s.role]).sort()).toEqual(
      [
        [colleagueId, 'member'],
        [operatorId, 'owner'],
      ].sort(),
    );
    expect(await db.query.users.findFirst({ where: eq(users.id, ownerId) })).toBeUndefined();

    const trail = await db.select().from(auditLog).where(eq(auditLog.action, 'workspace.owner_transfer'));
    expect(trail).toHaveLength(1);
    expect(trail[0]!.meta).toMatchObject({ workspaceId, fromUserId: ownerId, toUserId: operatorId, reason: 'user.delete' });
  });

  it('hands the workspace to an explicit transferTo user, promoting their existing seat', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/${ownerId}?transferTo=${colleagueId}`,
      headers: headersFor(operatorId),
    });
    expect(res.statusCode).toBe(200);
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    expect(ws?.ownerId).toBe(colleagueId);
    const seat = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, colleagueId)),
    });
    expect(seat?.role).toBe('owner');
    // The operator was not slipped in as a member.
    const opSeat = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, operatorId)),
    });
    expect(opSeat).toBeUndefined();
  });

  it('accepts transferTo in a JSON body too', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/${ownerId}`,
      headers: headersFor(operatorId),
      payload: { transferTo: colleagueId },
    });
    expect(res.statusCode).toBe(200);
    expect((await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }))?.ownerId).toBe(colleagueId);
  });

  it('refuses an unknown, deactivated or self transferTo — and deletes nothing', async () => {
    await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, colleagueId));
    for (const [target, message] of [
      ['999', /transferTo user not found/],
      [String(colleagueId), /deactivated/],
      [String(ownerId), /cannot be the user being deleted/],
      ['abc', /transferTo must be a user id/],
    ] as const) {
      const res = await app.inject({ method: 'DELETE', url: `/${ownerId}?transferTo=${target}`, headers: headersFor(operatorId) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(message);
    }
    expect(await db.query.users.findFirst({ where: eq(users.id, ownerId) })).toBeDefined();
    expect((await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }))?.ownerId).toBe(ownerId);
  });

  it('re-homes a service the deleted MEMBER owned to the workspace owner (r097 parity)', async () => {
    const [svc] = await db.insert(services).values({ name: 'api', slug: 'api', ownerUserId: colleagueId }).returning();
    await db.insert(serviceWorkspaces).values({ serviceId: svc!.id, workspaceId });
    const res = await app.inject({ method: 'DELETE', url: `/${colleagueId}`, headers: headersFor(operatorId) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ transferredWorkspaces: [] });
    const after = await db.query.services.findFirst({ where: eq(services.id, svc!.id) });
    expect(after?.ownerUserId).toBe(ownerId);
  });

  it('lists the workspaces each user owns (the People view names them in the delete confirm)', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: headersFor(operatorId) });
    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json() as Array<{ id: number; ownedWorkspaces: unknown }>).map((u) => [u.id, u.ownedWorkspaces]));
    expect(byId.get(ownerId)).toEqual([{ id: workspaceId, name: 'Team' }]);
    expect(byId.get(colleagueId)).toEqual([]);
  });
});
