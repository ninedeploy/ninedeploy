/**
 * 0.12 — GET/PUT /v1/databases/:id/backup-policy against a real migrated
 * SQLite (the upsert, the cascade and the destination FK are SQL behaviour a
 * fake db cannot show).
 */
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupDestinations,
  createDb,
  type DB,
  databaseBackupPolicies,
  databases,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from '@ninedeploy/db';

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);

const { databaseBackupPolicyRoutes } = await import('../src/modules/backupPolicy.js');
const { backupPolicyEvents } = await import('../src/lib/backupPolicy.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dbId: number;
let destId: number;
const ADMIN = 2;
const VIEWER = 3;
const OUTSIDER = 4;

beforeEach(async () => {
  auditMock.audit.mockClear();
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([1, ADMIN, VIEWER, OUTSIDER].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x' })));
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: 1 }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, userId: ADMIN, role: 'admin' },
    { workspaceId: ws!.id, userId: VIEWER, role: 'viewer' },
  ]);
  const [project] = await db.insert(projects).values({ name: 'P', slug: 'p', workspaceId: ws!.id }).returning();
  const [row] = await db
    .insert(databases)
    .values({ name: 'pg', slug: 'pg', engine: 'postgres', status: 'running', passwordEncrypted: 'v1:x', projectId: project!.id })
    .returning();
  dbId = row!.id;
  const [dest] = await db
    .insert(backupDestinations)
    .values({ name: 'R2', endpoint: 'https://r2.invalid', bucket: 'b', accessKeyId: 'k', secretKeyEncrypted: 'v1:s' })
    .returning();
  destId = dest!.id;
});

afterEach(() => close());

async function app() {
  const a = await buildTestApp({ db });
  await a.register(databaseBackupPolicyRoutes);
  return a;
}

const member = (id: number) => asUser({ id, isOperator: false, role: 'member' });

describe('GET /:id/backup-policy', () => {
  it('reports the built-in schedule for a database without a policy (upgrade default)', async () => {
    const res = await (await app()).inject({ method: 'GET', url: `/${dbId}/backup-policy`, headers: member(VIEWER) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ databaseId: dbId, configured: false, enabled: true, cron: null, retainCount: 7, destinationId: null, localOnly: false });
  });

  it('hides another tenant’s database (404)', async () => {
    const res = await (await app()).inject({ method: 'GET', url: `/${dbId}/backup-policy`, headers: member(OUTSIDER) });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /:id/backup-policy', () => {
  const body = { cron: '0 */6 * * *', retainCount: 14 };

  it('creates, then replaces, the policy — audited and re-armed', async () => {
    const changed = vi.fn();
    backupPolicyEvents.on('changed', changed);
    try {
      const a = await app();
      const first = await a.inject({ method: 'PUT', url: `/${dbId}/backup-policy`, headers: member(ADMIN), payload: body });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ configured: true, enabled: true, cron: '0 */6 * * *', retainCount: 14, retainRemoteCount: null, localOnly: false });
      expect(first.json().nextRunAt).toEqual(expect.any(String));

      const second = await a.inject({
        method: 'PUT', url: `/${dbId}/backup-policy`, headers: member(ADMIN),
        payload: { enabled: false, cron: '0 3 * * 0', retainCount: 30, localOnly: true },
      });
      expect(second.json()).toMatchObject({ enabled: false, cron: '0 3 * * 0', retainCount: 30, localOnly: true, nextRunAt: null });
      expect(await db.select().from(databaseBackupPolicies)).toHaveLength(1);
      expect(changed).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledWith(dbId);
      expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), ADMIN, 'backup.policy.update', expect.stringContaining('pg: 0 */6 * * *, keep 14'), { databaseId: dbId });
    } finally {
      backupPolicyEvents.off('changed', changed);
    }
  });

  it('needs admin on the database, like taking a backup', async () => {
    const res = await (await app()).inject({ method: 'PUT', url: `/${dbId}/backup-policy`, headers: member(VIEWER), payload: body });
    expect(res.statusCode).toBe(403);
    expect(await db.select().from(databaseBackupPolicies)).toHaveLength(0);
    expect(auditMock.audit).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...body, cron: '* * * * * *' }, /cron/i],
    [{ ...body, cron: 'daily' }, /cron/i],
    [{ ...body, retainCount: 0 }, /retainCount/],
    [{ ...body, retainCount: 366 }, /retainCount/],
    [{ ...body, retainRemoteCount: 0 }, /retainRemoteCount/],
    [{ ...body, localOnly: true, destinationId: 1 }, /mutually exclusive/],
    [{ retainCount: 7 }, /cron/],
  ])('refuses invalid input %j with a 400', async (payload, message) => {
    const res = await (await app()).inject({ method: 'PUT', url: `/${dbId}/backup-policy`, headers: member(ADMIN), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(message);
    expect(await db.select().from(databaseBackupPolicies)).toHaveLength(0);
  });

  it('a specific destination is an operator choice; the operator may set it and an admin may keep it', async () => {
    const a = await app();
    const denied = await a.inject({ method: 'PUT', url: `/${dbId}/backup-policy`, headers: member(ADMIN), payload: { ...body, destinationId: destId } });
    expect(denied.statusCode).toBe(403);

    const unknown = await a.inject({ method: 'PUT', url: `/${dbId}/backup-policy`, headers: asUser(1), payload: { ...body, destinationId: destId + 50 } });
    expect(unknown.statusCode).toBe(400);

    const set = await a.inject({ method: 'PUT', url: `/${dbId}/backup-policy`, headers: asUser(1), payload: { ...body, destinationId: destId, retainRemoteCount: 60 } });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ destinationId: destId, retainRemoteCount: 60 });

    // Re-saving with the operator's destination unchanged is fine for the admin.
    const kept = await a.inject({ method: 'PUT', url: `/${dbId}/backup-policy`, headers: member(ADMIN), payload: { ...body, retainCount: 3, destinationId: destId } });
    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toMatchObject({ retainCount: 3, destinationId: destId });
  });

  it('deleting the destination drops the policy back to the active one; deleting the database removes the policy', async () => {
    const a = await app();
    await a.inject({ method: 'PUT', url: `/${dbId}/backup-policy`, headers: asUser(1), payload: { ...body, destinationId: destId } });
    await db.delete(backupDestinations).where(eq(backupDestinations.id, destId));
    const after = await a.inject({ method: 'GET', url: `/${dbId}/backup-policy`, headers: asUser(1) });
    expect(after.json()).toMatchObject({ configured: true, destinationId: null, localOnly: false });

    await db.delete(databases).where(eq(databases.id, dbId));
    expect(await db.select().from(databaseBackupPolicies)).toHaveLength(0);
  });
});
