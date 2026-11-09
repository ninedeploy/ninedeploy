/**
 * R3: modules/pitr.ts — who may read and change point-in-time recovery, what
 * the bodies must look like, and the 202 admissions. lib/pitr.ts's Docker
 * work is mocked (test/lib/pitr.test.ts covers it); access runs for real
 * against a migrated SQLite with workspace seats.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, databases, pitrRecoveries, projects, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';

const lib = vi.hoisted(() => ({
  setCalls: [] as Array<Record<string, unknown>>,
  baseBackups: 0,
  recoverCalls: [] as Array<{ name: string; targetTime: Date | null }>,
}));
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/pitr.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/pitr.js')>('../../src/lib/pitr.js');
  return {
    ...actual,
    pitrStatus: vi.fn(async (d: { pitrEnabled: boolean; pitrRetentionDays: number }) => ({ enabled: d.pitrEnabled, retentionDays: d.pitrRetentionDays, recoverable: [] })),
    setPitr: vi.fn(async (_db: unknown, d: Record<string, unknown>, input: Record<string, unknown>) => {
      lib.setCalls.push(input);
      return { ...d, pitrEnabled: input.enabled, pitrRetentionDays: input.retentionDays ?? d.pitrRetentionDays };
    }),
    runPitrBaseBackup: vi.fn(async () => { lib.baseBackups++; return 'nd-x'; }),
    startPitrRecovery: vi.fn(async (_db: unknown, _s: unknown, input: { name: string; targetTime: Date | null }) => {
      lib.recoverCalls.push(input);
      return { recoveryId: 41, databaseId: 42 };
    }),
  };
});

import { pitrRoutes } from '../../src/modules/pitr.js';
import { asUser, buildTestApp } from '../helpers.js';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
let db: DB;
let close: () => void;
let dir: string;
let app: FastifyInstance;
const ids = { op: 0, admin: 0, viewer: 0, outsider: 0, db: 0, other: 0, loose: 0, looseOwner: 0 };

beforeEach(async () => {
  lib.setCalls = [];
  lib.baseBackups = 0;
  lib.recoverCalls = [];
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pitr-routes-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const mk = async (email: string, isInstanceOperator = false) => (await db.insert(users).values({ email, passwordHash: 'h', isInstanceOperator }).returning())[0]!.id;
  ids.op = await mk('op@x.test', true);
  ids.admin = await mk('admin@x.test');
  ids.viewer = await mk('viewer@x.test');
  ids.outsider = await mk('outsider@x.test');
  ids.looseOwner = await mk('loose@x.test');
  const [team] = await db.insert(workspaces).values({ name: 'Team', slug: 'team', ownerId: ids.op }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: team!.id, userId: ids.op, role: 'owner' },
    { workspaceId: team!.id, userId: ids.admin, role: 'admin' },
    { workspaceId: team!.id, userId: ids.viewer, role: 'viewer' },
  ]);
  const [project] = await db.insert(projects).values({ name: 'Shop', slug: 'shop', workspaceId: team!.id }).returning();
  const [loose] = await db.insert(projects).values({ name: 'Loose', slug: 'loose' }).returning();
  const mkDb = async (slug: string, over: Partial<typeof databases.$inferInsert> = {}) =>
    (await db.insert(databases).values({ name: slug, slug, engine: 'postgres', status: 'running', containerName: `nd-db-${slug}`, volumeName: `nd-db-${slug}-data`, passwordEncrypted: 'x', ...over }).returning())[0]!.id;
  ids.db = await mkDb('main', { projectId: project!.id, ownerUserId: ids.op, pitrEnabled: true });
  ids.other = await mkDb('other', { projectId: project!.id, ownerUserId: ids.op });
  // A project outside every workspace: its creator owns the database, but only an operator may add databases to it.
  ids.loose = await mkDb('loose', { projectId: loose!.id, ownerUserId: ids.looseOwner, pitrEnabled: true });
  app = await buildTestApp({ db });
  await app.register(pitrRoutes, { prefix: '/databases' });
});
afterEach(async () => {
  await app.close();
  close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
});

const as = (id: number, isOperator = false) => asUser({ id, isOperator });
const call = (method: 'GET' | 'PUT' | 'POST', url: string, user: number, payload?: unknown, isOperator = false) =>
  app.inject({ method, url, headers: as(user, isOperator), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

describe('reading', () => {
  it('anyone who sees the database reads the status and the history; others get 404', async () => {
    const res = await call('GET', `/databases/${ids.db}/pitr`, ids.viewer);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ databaseId: ids.db, enabled: true, retentionDays: 7 });
    expect((await call('GET', `/databases/${ids.db}/pitr`, ids.outsider)).statusCode).toBe(404);
    await db.insert(pitrRecoveries).values([
      { sourceDatabaseId: ids.db, databaseId: null, status: 'failed', error: 'Nothing archived yet.', targetTime: new Date('2026-11-05T09:00:00Z') },
      { sourceDatabaseId: ids.other, status: 'completed' },
    ]);
    const list = await call('GET', `/databases/${ids.db}/pitr/recoveries`, ids.viewer);
    expect(list.json()).toEqual([expect.objectContaining({ sourceDatabaseId: ids.db, status: 'failed', error: 'Nothing archived yet.', targetTime: '2026-11-05T09:00:00.000Z', completedAt: null })]);
    const id = list.json()[0].id;
    expect((await call('GET', `/databases/${ids.db}/pitr/recoveries/${id}`, ids.viewer)).json()).toMatchObject({ id, status: 'failed' });
    // Another database's recovery reads as missing: no cross-database id oracle.
    const foreign = (await db.select().from(pitrRecoveries)).find((r) => r.sourceDatabaseId === ids.other)!.id;
    expect((await call('GET', `/databases/${ids.db}/pitr/recoveries/${foreign}`, ids.viewer)).statusCode).toBe(404);
  });
});

describe('changing', () => {
  it('refuses a base backup while archive retention is active', async () => {
    const actual = await vi.importActual<typeof import('../../src/lib/pitr.js')>('../../src/lib/pitr.js');
    const row = (await db.query.databases.findFirst({ where: (await import('drizzle-orm')).eq(databases.id, ids.db) }))!;
    const d = { ...row, pitrBaseBackupAt: new Date() };
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const pruning = actual.pitrMaintenance(db, d, () => undefined, {
      ...actual.pitrDeps, archiver: async () => null,
      prune: async () => { entered(); await blocked; return { removedBases: [] }; },
    });
    try {
      await waiting;
      const result = await call('POST', `/databases/${ids.db}/pitr/base-backup`, ids.admin);
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({ error: { code: 'pitr_busy' } });
      expect(lib.baseBackups).toBe(0);
    } finally { release(); await pruning; }
  });

  it('takes database admin, a strict body, and returns the new status', async () => {
    expect((await call('PUT', `/databases/${ids.db}/pitr`, ids.viewer, { enabled: false })).statusCode).toBe(403);
    expect((await call('PUT', `/databases/${ids.db}/pitr`, ids.admin, { enabled: 'yes' })).statusCode).toBe(422);
    expect((await call('PUT', `/databases/${ids.db}/pitr`, ids.admin, { enabled: true, retentionDays: 36 })).statusCode).toBe(422);
    expect((await call('PUT', `/databases/${ids.db}/pitr`, ids.admin, { enabled: true, extra: 1 })).statusCode).toBe(422);
    const res = await call('PUT', `/databases/${ids.db}/pitr`, ids.admin, { enabled: true, retentionDays: 14 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ databaseId: ids.db, enabled: true, retentionDays: 14 });
    expect(lib.setCalls).toEqual([{ enabled: true, retentionDays: 14 }]);
  });
  it('admits a base backup with 202 only when PITR is on and the database runs', async () => {
    expect((await call('POST', `/databases/${ids.db}/pitr/base-backup`, ids.viewer)).statusCode).toBe(403);
    expect((await call('POST', `/databases/${ids.other}/pitr/base-backup`, ids.admin)).json()).toMatchObject({ error: { code: 'pitr_disabled' } });
    await db.update(databases).set({ status: 'stopped' }).where((await import('drizzle-orm')).eq(databases.id, ids.db));
    expect((await call('POST', `/databases/${ids.db}/pitr/base-backup`, ids.admin)).statusCode).toBe(409);
    await db.update(databases).set({ status: 'running', engine: 'mysql' }).where((await import('drizzle-orm')).eq(databases.id, ids.db));
    expect((await call('POST', `/databases/${ids.db}/pitr/base-backup`, ids.admin)).json()).toMatchObject({ error: { code: 'pitr_unavailable' } });
    await db.update(databases).set({ engine: 'postgres' }).where((await import('drizzle-orm')).eq(databases.id, ids.db));
    const res = await call('POST', `/databases/${ids.db}/pitr/base-backup`, ids.admin);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true });
    await vi.waitFor(() => expect(lib.baseBackups).toBe(1));
  });
});

describe('recovering', () => {
  it('admits a recovery into a new database with 202, to a time or to the latest point', async () => {
    expect((await call('POST', `/databases/${ids.db}/pitr/recover`, ids.viewer, { name: 'copy' })).statusCode).toBe(403);
    expect((await call('POST', `/databases/${ids.db}/pitr/recover`, ids.admin, { name: '' })).statusCode).toBe(422);
    expect((await call('POST', `/databases/${ids.db}/pitr/recover`, ids.admin, { name: 'copy', targetTime: 'yesterday' })).statusCode).toBe(422);
    expect((await call('POST', `/databases/${ids.db}/pitr/recover`, ids.admin, { name: 'copy', targetTime: '2026-11-05T09:03:30' })).statusCode).toBe(422);
    const res = await call('POST', `/databases/${ids.db}/pitr/recover`, ids.admin, { name: 'copy', targetTime: '2026-11-05T10:03:30+01:00' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ recoveryId: 41, databaseId: 42 });
    expect((await call('POST', `/databases/${ids.db}/pitr/recover`, ids.admin, { name: 'latest', targetTime: null })).statusCode).toBe(202);
    expect(lib.recoverCalls).toEqual([
      { name: 'copy', targetTime: new Date('2026-11-05T09:03:30Z') },
      { name: 'latest', targetTime: null },
    ]);
  });
  it('adds a database to a project outside every workspace only for an operator', async () => {
    const res = await call('POST', `/databases/${ids.loose}/pitr/recover`, ids.looseOwner, { name: 'copy' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/Only an operator/) } });
    expect((await call('POST', `/databases/${ids.loose}/pitr/recover`, ids.op, { name: 'copy' }, true)).statusCode).toBe(202);
  });
});
