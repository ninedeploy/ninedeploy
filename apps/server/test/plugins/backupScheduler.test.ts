import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { backups, } from '@ninedeploy/db';

const engineMock = vi.hoisted(() => ({
  backupDatabase: vi.fn(async () => undefined),
}));

vi.mock('../../src/engine/database.js', () => engineMock);
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/audit.js', () => auditMock);

const tmp = path.join(os.tmpdir(), `ninedeploy-backups-${process.pid}-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

vi.stubEnv('NINEDEPLOY_DATA_DIR', tmp);

const { default: backupSchedulerPlugin, firstTickDelay } = await import('../../src/plugins/backupScheduler.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_PER_DB = 7;

interface DbRow {
  id: number;
  slug: string;
  name: string;
  status: string;
}

function makeDb(opts: {
  dbs: DbRow[];
  backupRows?: Array<{ id: number; databaseId: number; path: string; createdAt: Date }>;
  selectImpl?: () => Promise<unknown>;
}) {
  const select = vi.fn(() => ({ from: vi.fn(opts.selectImpl ?? (async () => opts.dbs)) }));
  const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1 }]) })) }));
  const del = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  const findMany = vi.fn(async () => opts.backupRows ?? []);
  return {
    db: {
      select,
      insert,
      delete: del,
      query: { backups: { findMany } },
    } as never,
    insert,
    del,
    findMany,
  };
}

async function buildApp(db: ReturnType<typeof makeDb>['db']) {
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  await app.register(backupSchedulerPlugin);
  return app;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  engineMock.backupDatabase.mockReset();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('r170: firstTickDelay', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  it('runs a day after the newest scheduled backup, not a day after boot', () => {
    // Last scheduled backup 20h ago → the next is due in 4h, even though the
    // panel only just restarted.
    expect(firstTickDelay(now - 20 * 3_600_000, null, now)).toBe(4 * 3_600_000);
  });
  it('catches up (after a short grace) when a backup is overdue', () => {
    expect(firstTickDelay(now - 3 * DAY_MS, null, now)).toBe(5 * 60 * 1000);
  });
  it('anchors on the oldest running database when nothing was ever backed up', () => {
    expect(firstTickDelay(null, now - 30 * 3_600_000, now)).toBe(5 * 60 * 1000);
    expect(firstTickDelay(null, null, now)).toBe(DAY_MS);
  });
});

it('keeps metadata for remote recovery points after local retention', async () => {
  vi.useFakeTimers();
  const file = path.join(tmp, 'remote-retained.dump');
  writeFileSync(file, 'old dump');
  const rows = Array.from({ length: KEEP_PER_DB + 1 }, (_, i) => ({
    id: i + 1, databaseId: 1, scope: 'scheduled', status: 'completed',
    path: i === KEEP_PER_DB ? file : path.join(tmp, `recent-${i}.dump`),
    remoteKey: `database/backup-${i}`, createdAt: new Date(Date.now() - i * DAY_MS),
  }));
  const { db, del } = makeDb({ dbs: [{ id: 1, slug: 'a', name: 'A', status: 'running' }], backupRows: rows });
  const app = await buildApp(db);
  try {
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(existsSync(file)).toBe(false);
    expect(del).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

describe('backup scheduler plugin', () => {
  it('preserves successful recovery points when newer scheduled attempts failed', async () => {
    vi.useFakeTimers();
    const successfulPath = path.join(tmp, 'last-good.dump');
    writeFileSync(successfulPath, 'recoverable');
    const rows = Array.from({ length: KEEP_PER_DB }, (_, i) => ({
      id: i + 2, databaseId: 1, scope: 'scheduled', status: 'failed',
      path: path.join(tmp, `failed-${i}.dump`), createdAt: new Date(),
    }));
    rows.push({ id: 1, databaseId: 1, scope: 'scheduled', status: 'completed',
      path: successfulPath, createdAt: new Date(0) });
    const { db, del } = makeDb({
      dbs: [{ id: 1, slug: 'a', name: 'A', status: 'running' }], backupRows: rows,
    });
    engineMock.backupDatabase.mockRejectedValueOnce(new Error('dump failed'));
    const app = await buildApp(db);
    try {
      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(existsSync(successfulPath)).toBe(true);
      expect(del).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('backs up running databases, records size, and prunes stale backups', async () => {
    vi.useFakeTimers();
    const stalePath = path.join(tmp, 'stale.dump');
    writeFileSync(stalePath, 'old');
    const missingPath = path.join(tmp, 'missing.dump');

    const rows = [];
    for (let i = 0; i < KEEP_PER_DB + 2; i++) {
      // rows[7] and rows[8] fall past the KEEP_PER_DB window; rows[7] exists on
      // disk (gets unlinked), rows[8] does not.
      rows.push({ id: i + 1, databaseId: 1, scope: 'scheduled', status: 'completed', path: i === 7 ? stalePath : missingPath, createdAt: new Date() });
    }
    // A MANUAL backup is never pruned by the scheduler — even far past the
    // retention window it must survive.
    const manualPath = path.join(tmp, 'manual.dump');
    writeFileSync(manualPath, 'manual');
    rows.push({ id: 99, databaseId: 1, scope: 'db', status: 'completed', path: manualPath, createdAt: new Date(0) });

    const { db, insert, del, findMany } = makeDb({
      dbs: [
        { id: 1, slug: 'main-db', name: 'Main', status: 'running' },
        { id: 2, slug: 'stopped-db', name: 'Stopped', status: 'stopped' },
      ],
      backupRows: rows,
    });
    const app = Fastify({ logger: false });
    const logSpy = vi.spyOn(app.log, 'info');
    app.decorate('db', db);
    await app.register(backupSchedulerPlugin);

    // backupDatabase creates the dump file for db 1 so sizeBytes > 0, and
    // invokes the scheduler's log sink so the plugin's log helper runs.
    engineMock.backupDatabase.mockImplementation(async (_d: unknown, file: string, log?: (line: string) => void) => {
      writeFileSync(file, 'dump-data');
      log?.('dumping database');
    });

    await vi.advanceTimersByTimeAsync(DAY_MS);

    // Only the running database is backed up.
    expect(engineMock.backupDatabase).toHaveBeenCalledTimes(1);
    const [, file] = engineMock.backupDatabase.mock.calls[0] as [unknown, string];
    expect(file).toContain(path.join(tmp, 'backups', 'main-db-'));
    expect(file.endsWith('.dump')).toBe(true);

    expect(insert).toHaveBeenCalledWith(backups);
    const valuesFn = (insert.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values;
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: 1, scope: 'scheduled', status: 'completed', sizeBytes: expect.any(Number) }),
    );
    // sizeBytes reflects the file written by the mocked backup.
    const inserted = valuesFn.mock.calls[0]![0] as { sizeBytes: number };
    expect(inserted.sizeBytes).toBe(Buffer.byteLength('dump-data'));

    // Prune: two stale SCHEDULED rows past KEEP_PER_DB; one file exists (unlinked), one does not.
    expect(findMany).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(backups);
    expect(existsSync(stalePath)).toBe(false); // unlinked
    const whereCalls = del.mock.results.reduce(
      (n, r) => n + (r.value as { where: ReturnType<typeof vi.fn> }).where.mock.calls.length,
      0,
    );
    expect(whereCalls).toBe(2); // one delete per stale scheduled row
    // The manual backup (scope 'db') was NOT pruned.
    expect(existsSync(manualPath)).toBe(true);
    expect(logSpy).toHaveBeenCalledWith('backup scheduler armed (daily)');
    await app.close();
  });

  it('logs per-database failures but keeps going', async () => {
    vi.useFakeTimers();
    const { db } = makeDb({
      dbs: [
        { id: 1, slug: 'a', name: 'A', status: 'running' },
        { id: 2, slug: 'b', name: 'B', status: 'running' },
      ],
    });
    engineMock.backupDatabase.mockRejectedValueOnce(new Error('pg_dump failed'));
    const app = await buildApp(db);
    const errorSpy = vi.spyOn(app.log, 'error');

    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(engineMock.backupDatabase).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'pg_dump failed' }) },
      `scheduled backup failed for A`,
    );    await app.close();
  });

  // F96: the per-database retention read/delete ran outside every per-db
  // guard, so one SQLITE_BUSY while pruning database A escaped to the
  // tick-level catch and silently skipped the backups of every later database.
  it('F96: a retention error for one database does not skip the backups of the next', async () => {
    vi.useFakeTimers();
    const { db, findMany } = makeDb({
      dbs: [
        { id: 1, slug: 'a', name: 'A', status: 'running' },
        { id: 2, slug: 'b', name: 'B', status: 'running' },
      ],
    });
    // Call 1 = boot history read, 2 = watchdog read, 3 = A's prune read.
    let calls = 0;
    findMany.mockImplementation(async () => {
      if (++calls === 3) throw new Error('SQLITE_BUSY: database is locked');
      return [];
    });
    const app = await buildApp(db);
    const errorSpy = vi.spyOn(app.log, 'error');

    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(engineMock.backupDatabase).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'SQLITE_BUSY: database is locked' }) },
      'scheduled backup retention failed for A',
    );
    expect(errorSpy).not.toHaveBeenCalledWith(expect.anything(), 'backup scheduler tick failed');
    await app.close();
  });

  // F97: an upload throw AFTER the dump and its `completed` row were committed
  // fell into the dump-failure arm — a second `failed` row owning the same file
  // (failed-row retention later unlinked a retained recovery point) and a
  // `backup.schedule_failed` audit instead of `backup.create`. Real trigger: a
  // destination secret sealed under a key version missing from the key ring.
  it('F97: an upload failure after a committed dump is not recorded as a failed backup', async () => {
    vi.useFakeTimers();
    auditMock.audit.mockClear();
    const { db, insert } = makeDb({ dbs: [{ id: 1, slug: 'a', name: 'A', status: 'running' }] });
    (db as unknown as { query: Record<string, unknown> }).query.backupDestinations = {
      findMany: vi.fn(async () => [
        { id: 1, active: true, endpoint: 'https://s3.invalid', region: 'x', bucket: 'b', prefix: 'p',
          accessKeyId: 'k', secretKeyEncrypted: 'v99:aaaa:bbbb:cccc' },
      ]),
    };
    engineMock.backupDatabase.mockImplementation(async (_d: unknown, file: string) => {
      writeFileSync(file, 'dump-data');
    });
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(DAY_MS);

    // Exactly one row: the completed one — no `failed` row sharing its file.
    expect(insert).toHaveBeenCalledTimes(1);
    const valuesFn = (insert.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values;
    expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), null, 'backup.create', 'A', { scope: 'scheduled' });
    expect(auditMock.audit).not.toHaveBeenCalledWith(expect.anything(), null, 'backup.schedule_failed', expect.anything());
    // Since F288 `uploadBackup` itself swallows the undecryptable-secret error,
    // so the scheduler's own catch is defence in depth and may not log here.
    await app.close();
  });

  // r528: audit() is the notification fan-out — a successful scheduled
  // backup wrote none, so `backup.completed` never fired for daily backups.
  it('r528: audits each successful scheduled backup like the manual route does', async () => {
    vi.useFakeTimers();
    auditMock.audit.mockClear();
    const { db } = makeDb({
      dbs: [
        { id: 1, slug: 'a', name: 'A', status: 'running' },
        { id: 2, slug: 'b', name: 'B', status: 'running' },
      ],
    });
    engineMock.backupDatabase.mockRejectedValueOnce(new Error('pg_dump failed'));
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(DAY_MS);

    // Same action + entity as POST /databases/:id/backups (the audit bridge
    // maps it onto `backup.completed`); system-initiated, so no actor.
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), null, 'backup.create', 'B', { scope: 'scheduled' });
    // The failed database is reported as a failure, never as completed.
    expect(auditMock.audit).not.toHaveBeenCalledWith(expect.anything(), null, 'backup.create', 'A', expect.anything());
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), null, 'backup.schedule_failed', expect.stringContaining('A:'));
    await app.close();
  });

  it('logs when the whole tick fails', async () => {
    vi.useFakeTimers();
    const { db } = makeDb({
      dbs: [],
      selectImpl: async () => {
        throw new Error('db locked');
      },
    });
    const app = await buildApp(db);
    const errorSpy = vi.spyOn(app.log, 'error');

    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(errorSpy).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'db locked' }) },
      'backup scheduler tick failed',
    );
    await app.close();
  });

  it('does nothing when no database is running', async () => {
    vi.useFakeTimers();
    const { db, insert } = makeDb({
      dbs: [
        { id: 1, slug: 'x', name: 'X', status: 'creating' },
        { id: 2, slug: 'y', name: 'Y', status: 'stopped' },
      ],
    });
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(engineMock.backupDatabase).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('reschedules the daily tick while running', async () => {
    vi.useFakeTimers();
    const { db } = makeDb({ dbs: [] });
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(engineMock.backupDatabase).not.toHaveBeenCalled();
    expect(app.db).toBeDefined();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    // A second tick ran (db.select: once at boot for the r170 schedule
    // anchor, then once per tick).
    expect((db.select as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it('stops rescheduling after close', async () => {
    vi.useFakeTimers();
    let resolveSelect: (rows: DbRow[]) => void = () => undefined;
    const pending = new Promise<DbRow[]>((r) => {
      resolveSelect = r;
    });
    // The boot-time schedule read (r170) answers at once; the tick's select hangs.
    let selects = 0;
    const { db } = makeDb({ dbs: [], selectImpl: () => (selects++ === 0 ? Promise.resolve([]) : pending) });

    const app = await buildApp(db);
    vi.advanceTimersByTime(DAY_MS); // tick starts, suspends on pending select
    await app.close(); // running = false
    resolveSelect([]);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(engineMock.backupDatabase).not.toHaveBeenCalled();
  });

  it('skips the remote upload when the insert returns no row', async () => {
    vi.useFakeTimers();
    // insert().returning() resolves to [] — uploadBackup must not be called.
    const select = vi.fn(() => ({ from: vi.fn(async () => [{ id: 1, slug: 'a', name: 'A', status: 'running' }]) }));
    const insert = vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    }));
    const del = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    const db = { select, insert, delete: del, query: { backups: { findMany: vi.fn(async () => []) } } } as never;
    const app = await buildApp(db);
    engineMock.backupDatabase.mockImplementation(async () => undefined);

    await vi.advanceTimersByTimeAsync(DAY_MS);
    // The tick completed without throwing despite the empty returning.
    expect(engineMock.backupDatabase).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
