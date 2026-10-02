/**
 * Backup routes — coverage (G-17 drill, G-18 channels-adjacent).
 *
 * Focused smoke covering every branch in the lib: list / per-database
 * list / storage / create / restore / drill create / drill list /
 * instance-wide list / delete / download — with every external
 * engine boundary (backupDatabase, restoreDatabase, createBackupReadStream,
 * uploadBackup, fetchRemoteBackup, deleteRemoteBackup, runBackupDrill,
 * listBackupDrills) mocked so the test does not need a real docker
 * daemon or S3 bucket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupRoutes, databaseBackupRoutes } from '../../src/modules/backups.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));

const mocks = vi.hoisted(() => ({
  databaseSize: vi.fn(async () => 1024 * 1024 * 12),
  backupDatabase: vi.fn(async () => undefined),
  restoreDatabase: vi.fn(async () => undefined),
  createBackupReadStream: vi.fn(async () => Buffer.from('plaintext-dump')),
  uploadBackup: vi.fn(async () => undefined),
  deleteRemoteBackup: vi.fn(async () => undefined),
  fetchRemoteBackup: vi.fn(async () => undefined),
  runBackupDrill: vi.fn(async () => ({
    drillId: 99,
    status: 'ok',
    durationMs: 42,
    details: 'pg_restore --list succeeded',
    error: null,
  })),
  listBackupDrills: vi.fn(async () => [
    { id: 1, databaseId: 1, status: 'ok', durationMs: 12, error: null, ts: new Date('2026-01-01') },
  ]),
  audit: vi.fn(async () => undefined),
}));

vi.mock('../../src/engine/database.js', () => ({
  databaseSize: mocks.databaseSize,
  backupDatabase: mocks.backupDatabase,
  restoreDatabase: mocks.restoreDatabase,
  createBackupReadStream: mocks.createBackupReadStream,
}));
vi.mock('../../src/lib/backupRemote.js', () => ({
  uploadBackup: mocks.uploadBackup,
  deleteRemoteBackup: mocks.deleteRemoteBackup,
  fetchRemoteBackup: mocks.fetchRemoteBackup,
}));
vi.mock('../../src/lib/backupDrill.js', () => ({
  runBackupDrill: mocks.runBackupDrill,
  listBackupDrills: mocks.listBackupDrills,
}));
vi.mock('../../src/lib/audit.js', () => ({ audit: mocks.audit }));

// node:fs surface — the lib calls existsSync/statSync/unlinkSync on
// the on-disk backup path. We stub these so the test does not need
// real files; readFileSync is the only one that returns bytes
// (used by the volume-scope download branch).
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ size: 1024 })),
  unlinkSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: fsMock.existsSync,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
    // readFileSync passthrough so the volume-scope download test
    // reads a real on-disk file from the lib-cwd.
  };
});

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    else if (typeof fn === 'function') fn.mockClear?.();
  }
  for (const fn of Object.values(fsMock)) {
    if ('mockReset' in fn) fn.mockReset();
  }
  fsMock.existsSync.mockReturnValue(false);
  fsMock.statSync.mockReturnValue({ size: 1024 });
  mocks.databaseSize.mockResolvedValue(1024 * 1024 * 12);
  mocks.createBackupReadStream.mockResolvedValue(Buffer.from('plaintext-dump'));
  mocks.runBackupDrill.mockResolvedValue({
    drillId: 99, status: 'ok', durationMs: 42, details: 'pg_restore --list succeeded', error: null,
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

interface DbRow {
  id: number; slug: string; name: string; engine: string;
  ownerUserId: number; workspaceId: number | null;
  createdAt: Date; updatedAt: Date;
}
const dbRow = (over: Partial<DbRow> = {}): DbRow => ({
  id: 1, slug: 'app-db', name: 'app', engine: 'postgres',
  ownerUserId: 7, workspaceId: 100,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

interface BackupRow {
  id: number; databaseId: number | null; scope: string;
  volumeName: string | null; label: string | null;
  status: string; sizeBytes: number; path: string;
  remoteKey: string | null;
  createdAt: Date;
}
const backupRow = (over: Partial<BackupRow> = {}): BackupRow => ({
  id: 1, databaseId: 1, scope: 'db', volumeName: null, label: null,
  status: 'completed', sizeBytes: 1024, path: '/var/lib/ninedeploy/backups/app-2026.dump',
  remoteKey: 's3://bucket/app-2026.dump',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

async function buildApp(opts: Parameters<typeof buildTestApp>[0] = {}) {
  const app = await buildTestApp(opts);
  return app;
}

describe('database backup routes (per-database)', () => {
  it('GET /:id/storage returns the database size', async () => {
    const app = await buildApp({ db: createFakeDb({ findFirst: { databases: dbRow() } }) });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/storage', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sizeBytes: 1024 * 1024 * 12 });
    expect(mocks.databaseSize).toHaveBeenCalledOnce();
  });

  it('GET /:id/backups returns every backup for the database (newest first)', async () => {
    const app = await buildApp({
      db: createFakeDb({
        findFirst: { databases: dbRow() },
        findMany: { backups: [backupRow({ id: 2 }), backupRow({ id: 1 })] },
      }),
    });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/backups', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it('POST /:id/backups inserts a `running` row, runs the engine, then marks `completed`', async () => {
    fsMock.existsSync.mockReturnValue(true);
    const seenStates: string[] = [];
    const db = createFakeDb({
      findFirst: {
        databases: dbRow(),
        // The lib re-reads the row after the engine succeeds; return
        // the same shape with `status: 'completed'`.
        backups: backupRow({ id: 10, status: 'completed' }),
      },
      insert: { backups: () => [backupRow({ id: 10, status: 'running' })] },
      update: { backups: (s: { status?: string }) => { if (s.status) seenStates.push(s.status); return []; } },
    });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups', headers: asUser() });
    if (res.statusCode !== 200) {
      throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
    }
    expect(mocks.backupDatabase).toHaveBeenCalledOnce();
    expect(mocks.uploadBackup).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledOnce();
    // The lib updates the row to `completed` after the engine
    // succeeds — the setter was called with `status: 'completed'`.
    expect(seenStates).toContain('completed');
  });

  it('POST /:id/backups marks the row `failed` and surfaces a 400 on engine error', async () => {
    mocks.backupDatabase.mockRejectedValueOnce(new Error('pg_dump: out of memory'));
    const updatedStates: string[] = [];
    const db = createFakeDb({
      findFirst: { databases: dbRow(), backups: backupRow({ id: 11, status: 'running' }) },
      insert: { backups: () => [backupRow({ id: 11, status: 'running' })] },
      update: { backups: (s: { status?: string }) => { if (s.status) updatedStates.push(s.status); return []; } },
    });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups', headers: asUser() });
    if (res.statusCode !== 400) {
      throw new Error(`expected 400, got ${res.statusCode}: ${res.body}`);
    }
    expect(res.json()).toMatchObject({
      error: { message: expect.stringMatching(/Backup failed.*out of memory/) },
    });
    // The lib updates the row to `failed` before throwing.
    expect(updatedStates).toContain('failed');
  });

  it('POST /:id/backups/:bid/restore 404s when the backup is for a different database', async () => {
    const db = createFakeDb({
      findFirst: { databases: dbRow(), backups: backupRow({ id: 5, databaseId: 99 /* ≠ 1 */ }) },
    });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups/5/restore', headers: asUser() });
    if (res.statusCode !== 404) {
      throw new Error(`expected 404, got ${res.statusCode}: ${res.body}`);
    }
    // The cross-database guard short-circuits BEFORE
    // restoreDatabase is called — the call is what would actually
    // blow up the wrong database.
    expect(mocks.restoreDatabase).not.toHaveBeenCalled();
  });

  it('POST /:id/backups/:bid/restore uses the local path when the file exists', async () => {
    fsMock.existsSync.mockReturnValue(true);
    const db = createFakeDb({
      findFirst: { databases: dbRow(), backups: backupRow({ id: 5, path: '/local/dump' }) },
    });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups/5/restore', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mocks.restoreDatabase).toHaveBeenCalledOnce();
    // The temp-file branch is NOT taken when the local path exists.
    expect(mocks.fetchRemoteBackup).not.toHaveBeenCalled();
  });

  it('POST /:id/backups/:bid/restore fetches a remote temp when the local path is missing', async () => {
    fsMock.existsSync.mockReturnValue(false); // local file gone
    const db = createFakeDb({
      findFirst: { databases: dbRow(), backups: backupRow({ id: 5, path: '/orig/dump', remoteKey: 's3://b/orig.dump' }) },
    });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups/5/restore', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(mocks.fetchRemoteBackup).toHaveBeenCalledOnce();
    expect(mocks.restoreDatabase).toHaveBeenCalledOnce();
    // The temp file is unlinked after the restore (best-effort).
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  it('POST /:id/backups/:bid/restore 404s when the remote-only backup has no remoteKey', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const db = createFakeDb({
      findFirst: { databases: dbRow(), backups: backupRow({ id: 5, path: '/orig/dump', remoteKey: null }) },
    });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups/5/restore', headers: asUser() });
    if (res.statusCode !== 404) {
      throw new Error(`expected 404, got ${res.statusCode}: ${res.body}`);
    }
    expect(mocks.fetchRemoteBackup).not.toHaveBeenCalled();
  });

  it('POST /:id/backups/:bid/restore 400s when restoreDatabase throws', async () => {
    fsMock.existsSync.mockReturnValue(true);
    mocks.restoreDatabase.mockRejectedValueOnce(new Error('pg_restore: schema mismatch'));
    const db = createFakeDb({
      findFirst: { databases: dbRow(), backups: backupRow({ id: 5 }) },
    });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups/5/restore', headers: asUser() });
    if (res.statusCode !== 400) {
      throw new Error(`expected 400, got ${res.statusCode}: ${res.body}`);
    }
    expect(res.json()).toMatchObject({
      error: { message: expect.stringMatching(/Restore failed.*schema mismatch/) },
    });
  });

  it('POST /:id/backups/drill 400s when the body is missing backupId', async () => {
    const db = createFakeDb({ findFirst: { databases: dbRow() } });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups/drill', headers: asUser(), payload: {} });
    if (res.statusCode !== 400) {
      throw new Error(`expected 400, got ${res.statusCode}: ${res.body}`);
    }
    expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/backupId is required/) } });
  });

  it('POST /:id/backups/drill runs the engine and returns the drill result', async () => {
    const db = createFakeDb({ findFirst: { databases: dbRow(), backups: backupRow({ id: 7 }) } });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/backups/drill',
      headers: asUser(),
      payload: { backupId: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      drillId: 99,
      status: 'ok',
      durationMs: 42,
      details: 'pg_restore --list succeeded',
      error: null,
    });
  });

  it('POST /:id/backups/drill 400s when runBackupDrill throws', async () => {
    mocks.runBackupDrill.mockRejectedValueOnce(new Error('not a valid dump'));
    const db = createFakeDb({ findFirst: { databases: dbRow(), backups: backupRow({ id: 7 }) } });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/backups/drill',
      headers: asUser(),
      payload: { backupId: 7 },
    });
    if (res.statusCode !== 400) {
      throw new Error(`expected 400, got ${res.statusCode}: ${res.body}`);
    }
    expect(res.json()).toMatchObject({
      error: { message: expect.stringMatching(/Drill failed.*not a valid dump/) },
    });
  });

  it("r693: POST /:id/backups/drill 404s for another database's backup, before the drill runs", async () => {
    mocks.runBackupDrill.mockClear();
    const db = createFakeDb({ findFirst: { databases: dbRow(), backups: backupRow({ id: 7, databaseId: 99 /* ≠ 1 */ }) } });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups/drill', headers: asUser(), payload: { backupId: 7 } });
    expect(res.statusCode).toBe(404);
    // The same answer a missing id gets — no "does not belong to database N" oracle.
    expect(res.json().error.message).toBe('Backup not found');
    expect(mocks.runBackupDrill).not.toHaveBeenCalled();
  });

  it('GET /:id/drills lists the most recent 25 runs', async () => {
    const db = createFakeDb({ findFirst: { databases: dbRow() } });
    const app = await buildApp({ db });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/drills', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(mocks.listBackupDrills).toHaveBeenCalledOnce();
    // The lib passes the cap (25) to the helper as the 3rd arg.
    const cap = mocks.listBackupDrills.mock.calls[0]?.[2];
    expect(cap).toBe(25);
  });
});

describe('global backup routes', () => {
  it('GET / lists every backup and adds the parent database name', async () => {
    const app = await buildApp({
      db: createFakeDb({
        findMany: { backups: [backupRow({ id: 1, databaseId: 1 }), backupRow({ id: 2, databaseId: 2 })] },
        select: { databases: [dbRow({ id: 1, name: 'one' }), dbRow({ id: 2, name: 'two' })] },
      }),
    });
    await app.register(backupRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ isOperator: true }) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ databaseName: 'one' });
    expect(body[1]).toMatchObject({ databaseName: 'two' });
  });

  it('GET / handles a backup with no associated database (volume scope)', async () => {
    // The lib falls back to `null` for the `databaseName` field
    // when the row has no `databaseId` — this is the volume-scope
    // path. A member's `visibleDatabaseIds` would filter these out
    // entirely, so we exercise it as an operator.
    const app = await buildApp({
      db: createFakeDb({
        findMany: { backups: [backupRow({ id: 1, databaseId: null, scope: 'volumes' })] },
        select: { databases: [] },
      }),
    });
    await app.register(backupRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ isOperator: true }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ databaseName: null, scope: 'volumes' });
  });

  it('DELETE /:bid unlinks the local file + remote object then removes the row', async () => {
    fsMock.existsSync.mockReturnValue(true);
    const db = createFakeDb({
      findFirst: { backups: backupRow({ id: 7, path: '/var/lib/ninedeploy/backups/d.dump' }) },
    });
    const app = await buildApp({ db });
    await app.register(backupRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/7', headers: asUser({ isOperator: true }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
    expect(mocks.deleteRemoteBackup).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledOnce();
  });

  it('GET /:bid/download 404s when the file is missing on disk', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const app = await buildApp({
      db: createFakeDb({ findFirst: { backups: backupRow({ id: 7 }) } }),
    });
    await app.register(backupRoutes);
    const res = await app.inject({ method: 'GET', url: '/7/download', headers: asUser({ isOperator: true }) });
    if (res.statusCode !== 404) {
      throw new Error(`expected 404, got ${res.statusCode}: ${res.body}`);
    }
  });

  it('GET /:bid/download streams the plaintext dump for a db-scope backup', async () => {
    fsMock.existsSync.mockReturnValue(true);
    const app = await buildApp({
      db: createFakeDb({ findFirst: { backups: backupRow({ id: 7, scope: 'db' }) } }),
    });
    await app.register(backupRoutes);
    const res = await app.inject({ method: 'GET', url: '/7/download', headers: asUser({ isOperator: true }) });
    expect(res.statusCode).toBe(200);
    expect(mocks.createBackupReadStream).toHaveBeenCalledOnce();
    // The route advertised octet-stream + attachment headers.
    expect(res.headers['content-type']).toContain('octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment;');
  });

  it('GET /:bid/download returns the raw tar.gz for a volumes-scope backup', async () => {
    fsMock.existsSync.mockReturnValue(true);
    // Write a real temp file on disk so the lib's
    // `readFileSync(b.path)` succeeds without a giant mock.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = path.join(tmpdirSafe(), `volumes-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmp, Buffer.from([0x1f, 0x8b, 0x08]));
    try {
      const db = createFakeDb({
        findFirst: { backups: backupRow({ id: 7, scope: 'volumes', path: tmp }) },
      });
      const app = await buildApp({ db });
      await app.register(backupRoutes);
      const res = await app.inject({ method: 'GET', url: '/7/download', headers: asUser({ isOperator: true }) });
      expect(res.statusCode).toBe(200);
      expect(mocks.createBackupReadStream).not.toHaveBeenCalled();
      expect(res.headers['content-type']).toContain('gzip');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('DELETE /:bid 403s for a non-operator on a volumes-scope backup (operator-only)', async () => {
    // The `databaseId == null` branch of `assertMayManageBackup`
    // throws `forbidden` for any non-operator — volume-scope
    // backups have no parent database to derive a workspace
    // role from, so only operators can manage them.
    const db = createFakeDb({
      findFirst: { backups: backupRow({ id: 8, databaseId: null, scope: 'volumes' }) },
    });
    const app = await buildApp({ db });
    await app.register(backupRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/8',
      headers: asUser({ id: 7, isOperator: false }),
    });
    if (res.statusCode !== 403) {
      throw new Error(`expected 403, got ${res.statusCode}: ${res.body}`);
    }
    expect(res.json()).toMatchObject({
      error: { message: expect.stringMatching(/Operator access required for this backup/) },
    });
  });

  it('DELETE /:bid tolerates a missing row (the `if (!row) return` early exit)', async () => {
    // The `if (!row) return` branch lets the caller's later
    // check (`.where(id) → returning() === undefined`) raise
    // `notFound`, instead of pre-empting with 403. The contract
    // pinned here is "non-operator + row gone = 200 from the
    // assert side, 404 from the delete side" — we test the
    // assert's tolerant exit by ensuring the request doesn't
    // 403 just because the row is gone.
    const db = createFakeDb({ findFirst: { backups: undefined } });
    const app = await buildApp({ db });
    await app.register(backupRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/99',
      headers: asUser({ id: 7, isOperator: false }),
    });
    // The `if (b) unlinkSync` is a guard; with no row, the
    // route still returns 200 (the db delete is unconditional).
    expect(res.statusCode).toBe(200);
  });
});

function tmpdirSafe(): string {
  // Resolve the host tmp dir without pulling in the os module
  // (the test file already imports node:fs via vi.mock, which
  // forbids the `os` module — keep this self-contained).
  return process.env['TMP'] ?? process.env['TEMP'] ?? process.cwd();
}
