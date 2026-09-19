import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { backupRoutes, databaseBackupRoutes } from '../src/modules/backups.js';
import { asUser, backupRow, buildTestApp, createFakeDb, dbRow } from './helpers.js';

const engineMocks = vi.hoisted(() => ({
  backupDatabase: vi.fn(async () => undefined),
  databaseSize: vi.fn(async () => 1024),
  restoreDatabase: vi.fn(async () => undefined),
  // Downloads decrypt the at-rest envelope as a stream.
  createBackupReadStream: vi.fn(async () => {
    const { Readable } = await import('node:stream');
    return Readable.from(Buffer.from('plain-dump-bytes'));
  }),
}));
vi.mock('../src/engine/database.js', () => engineMocks);

const remoteMocks = vi.hoisted(() => ({
  uploadBackup: vi.fn(async () => undefined),
  fetchRemoteBackup: vi.fn(async (_db: unknown, _key: string, p: string) => p),
  deleteRemoteBackup: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/backupRemote.js', () => remoteMocks);

const fsMocks = vi.hoisted(() => ({
  exists: false,
  existsSync: vi.fn(() => fsMocks.exists),
  statSync: vi.fn(() => ({ size: 4321 })),
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, existsSync: fsMocks.existsSync, statSync: fsMocks.statSync };
});

const tmpFiles: string[] = [];
let dumpFile = '';

beforeEach(() => {
  vi.clearAllMocks();
  dumpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-bk-')), 'db.dump');
  tmpFiles.push(dumpFile);
  fs.writeFileSync(dumpFile, 'dump-bytes');
});

afterAll(() => {
  for (const f of tmpFiles) fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

describe('database backup routes', () => {
  it('reports storage size for a database', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { databases: dbRow({ id: 1 }) } }),
    });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/storage', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sizeBytes: 1024 });
  });

  it('returns 404 for storage on a missing database', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'GET', url: '/99/storage', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('lists backups for a database', async () => {
    // The route now resolves the database through the access choke-point
    // before listing, so it must exist in the fixture — see authzRegression M-1.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1 }) },
        findMany: { backups: [backupRow({ id: 2, databaseId: 1, status: 'completed', volumeName: null })] },
      }),
    });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/backups', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: 2,
        databaseId: 1,
        scope: 'db',
        volumeName: null,
        status: 'completed',
        sizeBytes: 100,
        label: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('creates a backup and marks it completed', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1, slug: 'pg' }), backups: backupRow({ id: 3, status: 'completed', sizeBytes: 4321 }) },
        insert: { backups: [backupRow({ id: 3, status: 'running' })] },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = true;
    const res = await app.inject({ method: 'POST', url: '/1/backups', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 3, status: 'completed' });
    expect(engineMocks.backupDatabase).toHaveBeenCalled();
  });

  it('records size zero when the dump file is missing', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1, slug: 'pg' }), backups: backupRow({ id: 3, status: 'completed', sizeBytes: 0 }) },
        insert: { backups: [backupRow({ id: 3, status: 'running' })] },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = false;
    const res = await app.inject({ method: 'POST', url: '/1/backups', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 3, sizeBytes: 0 });
  });

  it('marks the backup failed when the dump errors', async () => {
    engineMocks.backupDatabase.mockRejectedValueOnce(new Error('pg_dump failed'));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1, slug: 'pg' }) },
        insert: { backups: [backupRow({ id: 3, status: 'running' })] },
      }),
    });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Backup failed: pg_dump failed');
  });

  it('formats non-Error dump failures', async () => {
    engineMocks.backupDatabase.mockRejectedValueOnce('raw failure');
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1, slug: 'pg' }) },
        insert: { backups: [backupRow({ id: 3, status: 'running' })] },
      }),
    });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Backup failed: raw failure');
  });

  it('returns 404 when backing up a missing database', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/99/backups', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('restores a backup', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1 }), backups: backupRow({ id: 4, path: '/tmp/x.dump' }) },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = true;
    const res = await app.inject({ method: 'POST', url: '/1/backups/4/restore', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engineMocks.restoreDatabase).toHaveBeenCalled();
  });

  it('fetches a remote-only backup before restoring', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          databases: dbRow({ id: 1 }),
          backups: backupRow({ id: 4, path: '/tmp/gone.dump', remoteKey: 'nd/gone.dump' }),
        },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = false;
    const res = await app.inject({ method: 'POST', url: '/1/backups/4/restore', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(remoteMocks.fetchRemoteBackup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ remoteKey: 'nd/gone.dump' }), expect.stringContaining('gone.dump'));
    expect(engineMocks.restoreDatabase).toHaveBeenCalled();
  });

  it('404s for a remote-less backup whose local file is gone', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1 }), backups: backupRow({ id: 4, path: '/tmp/gone.dump' }) },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = false;
    const res = await app.inject({ method: 'POST', url: '/1/backups/4/restore', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('uploads completed backups off-site', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1, slug: 'pg' }), backups: backupRow({ id: 4, status: 'completed', sizeBytes: 4321 }) },
        insert: { backups: [backupRow({ id: 4, status: 'running' })] },
        update: { backups: [backupRow({ id: 4, status: 'completed' })] },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = true;
    const res = await app.inject({ method: 'POST', url: '/1/backups', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(remoteMocks.uploadBackup).toHaveBeenCalled();
  });

  it('returns 404 when the backup row is missing', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { databases: dbRow({ id: 1 }) } }),
    });
    await app.register(databaseBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/backups/4/restore', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the backup file is missing', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1 }), backups: backupRow({ id: 4, path: '/tmp/x.dump' }) },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = false;
    const res = await app.inject({ method: 'POST', url: '/1/backups/4/restore', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when the restore fails', async () => {
    engineMocks.restoreDatabase.mockRejectedValueOnce(new Error('corrupt dump'));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1 }), backups: backupRow({ id: 4, path: '/tmp/x.dump' }) },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = true;
    const res = await app.inject({ method: 'POST', url: '/1/backups/4/restore', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Restore failed: corrupt dump');
  });

  it('formats non-Error restore failures', async () => {
    engineMocks.restoreDatabase.mockRejectedValueOnce('restore boom');
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { databases: dbRow({ id: 1 }), backups: backupRow({ id: 4, path: '/tmp/x.dump' }) },
      }),
    });
    await app.register(databaseBackupRoutes);
    fsMocks.exists = true;
    const res = await app.inject({ method: 'POST', url: '/1/backups/4/restore', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Restore failed: restore boom');
  });
});

describe('backup routes', () => {
  it('lists all backups with database names', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          backups: [
            backupRow({ id: 1, databaseId: 1 }),
            backupRow({ id: 2, databaseId: 99 }),
            backupRow({ id: 3, databaseId: null }),
          ],
        },
        select: { databases: [dbRow({ id: 1, name: 'pg' })] },
      }),
    });
    await app.register(backupRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0].databaseName).toBe('pg');
    expect(rows[1].databaseName).toBe(null);
    expect(rows[2].databaseName).toBe(null);
  });

  it('deletes a backup and its file', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { backups: backupRow({ id: 1, path: dumpFile, remoteKey: 'nd/x.dump' }) } }),
    });
    await app.register(backupRoutes);
    fsMocks.exists = true;
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(fs.readdirSync(path.dirname(dumpFile))).toEqual([]);
    // The remote object is removed too.
    expect(remoteMocks.deleteRemoteBackup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ remoteKey: 'nd/x.dump' }));
  });

  it('deletes a backup row even when the file is gone', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { backups: backupRow({ id: 1, path: '/tmp/x.dump' }) } }),
    });
    await app.register(backupRoutes);
    fsMocks.exists = false;
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('deletes a backup row when the row is missing', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(backupRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/99', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('downloads a backup file', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { backups: backupRow({ id: 1, path: dumpFile }) } }),
    });
    await app.register(backupRoutes);
    fsMocks.exists = true;
    const res = await app.inject({ method: 'GET', url: '/1/download', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment; filename="db.dump"');
    // The user receives the PLAINTEXT dump, not the encrypted envelope.
    expect(res.body).toBe('plain-dump-bytes');
    expect(engineMocks.createBackupReadStream).toHaveBeenCalledWith(dumpFile);
  });

  it('returns 404 when downloading a missing backup', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(backupRoutes);
    const res = await app.inject({ method: 'GET', url: '/99/download', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the backup file is missing', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { backups: backupRow({ id: 1 }) } }),
    });
    await app.register(backupRoutes);
    fsMocks.exists = false;
    const res = await app.inject({ method: 'GET', url: '/1/download', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });
});
