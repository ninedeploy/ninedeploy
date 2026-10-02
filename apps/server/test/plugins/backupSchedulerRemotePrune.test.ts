/**
 * r542 — remote-backed scheduled DB backups get keep-newest-N retention.
 *
 * The scheduler used to skip every stale row with a `remoteKey`: the S3 object
 * and the row were kept forever. Now the remote object is deleted first (via
 * the destination the row records) and the row only once that succeeded; a
 * failure keeps the row for the next sweep, and the number of S3 deletes per
 * tick is capped so the first sweep after an upgrade cannot fire the whole
 * accumulated backlog at once.
 */
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const engineMock = vi.hoisted(() => ({ backupDatabase: vi.fn(async () => undefined) }));
vi.mock('../../src/engine/database.js', () => engineMock);

const remoteMock = vi.hoisted(() => ({
  uploadBackup: vi.fn(async () => undefined),
  deleteRemoteBackupForRetention: vi.fn(async (): Promise<'deleted' | 'unknown-destination'> => 'deleted'),
}));
vi.mock('../../src/lib/backupRemote.js', () => remoteMock);

const tmp = path.join(os.tmpdir(), `ninedeploy-backups-remote-${process.pid}-${Date.now()}`);
mkdirSync(tmp, { recursive: true });
vi.stubEnv('NINEDEPLOY_DATA_DIR', tmp);

const { default: backupSchedulerPlugin } = await import('../../src/plugins/backupScheduler.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_PER_DB = 7;

/** `count` completed scheduled rows for one database, newest first, all remote-backed. */
function remoteRows(databaseId: number, count: number, idBase = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: idBase + i + 1,
    databaseId,
    scope: 'scheduled',
    status: 'completed',
    path: path.join(tmp, `missing-${databaseId}-${i}.dump`),
    remoteKey: `nd/db-${databaseId}-${i}.dump`,
    destinationId: 1,
    createdAt: new Date(Date.now() - i * DAY_MS),
  }));
}

function makeDb(dbIds: number[]) {
  const deletedIds: number[] = [];
  let current = 0;
  const select = vi.fn(() => ({
    from: vi.fn(async () => dbIds.map((id) => ({ id, slug: `d${id}`, name: `D${id}`, status: 'running', createdAt: new Date(0) }))),
  }));
  const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 999 }]) })) }));
  // The prune deletes rows one by one after their remote delete; the fake
  // records which row each delete was for through `current`.
  const del = vi.fn(() => ({
    where: vi.fn(async () => {
      deletedIds.push(current);
    }),
  }));
  const findMany = vi.fn(async (): Promise<unknown[]> => []);
  return { select, insert, del, findMany, deletedIds, setCurrent: (id: number) => (current = id) };
}

async function run(dbIds: number[], rowsFor: (databaseId: number) => Array<{ id: number }>) {
  const fake = makeDb(dbIds);
  let call = 0;
  // Boot read + the watchdog read return []; each per-database prune read
  // returns that database's rows (called in `dbIds` order).
  fake.findMany.mockImplementation(async () => {
    call++;
    if (call <= 2) return [];
    return rowsFor(dbIds[call - 3]!);
  });
  remoteMock.deleteRemoteBackupForRetention.mockImplementation(async (_db, row) => {
    fake.setCurrent((row as { id: number }).id);
    return 'deleted';
  });
  const db = { select: fake.select, insert: fake.insert, delete: fake.del, query: { backups: { findMany: fake.findMany } } };
  const app = Fastify({ logger: false });
  app.decorate('db', db as never);
  await app.register(backupSchedulerPlugin);
  return { app, fake };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('r542: scheduled backup retention covers remote-backed rows', () => {
  it('deletes the remote object, then the row, for every remote row past KEEP_PER_DB', async () => {
    vi.useFakeTimers();
    const rows = remoteRows(1, KEEP_PER_DB + 2);
    const { app, fake } = await run([1], () => rows);
    try {
      await vi.advanceTimersByTimeAsync(DAY_MS);
      const pruned = rows.slice(KEEP_PER_DB);
      expect(remoteMock.deleteRemoteBackupForRetention).toHaveBeenCalledTimes(2);
      for (const r of pruned) {
        expect(remoteMock.deleteRemoteBackupForRetention).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ id: r.id, remoteKey: r.remoteKey, destinationId: 1 }),
        );
      }
      expect(fake.deletedIds.sort()).toEqual(pruned.map((r) => r.id).sort());
    } finally {
      await app.close();
    }
  });

  it('keeps the row when the remote delete fails, and when the destination is unknown', async () => {
    vi.useFakeTimers();
    const rows = remoteRows(1, KEEP_PER_DB + 2);
    const { app, fake } = await run([1], () => rows);
    remoteMock.deleteRemoteBackupForRetention
      .mockImplementationOnce(async () => {
        throw new Error('S3 delete failed (503)');
      })
      .mockImplementationOnce(async () => 'unknown-destination');
    const warn = vi.spyOn(app.log, 'warn');
    try {
      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(remoteMock.deleteRemoteBackupForRetention).toHaveBeenCalledTimes(2);
      expect(fake.del).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ backupId: rows[KEEP_PER_DB]!.id }),
        expect.stringContaining('remote delete failed'),
      );
    } finally {
      await app.close();
    }
  });

  it('caps the remote deletes per tick so an upgrade backlog is worked down over several ticks', async () => {
    vi.useFakeTimers();
    // 300 accumulated remote rows past retention on one database.
    const rows = remoteRows(1, KEEP_PER_DB + 300);
    const { app, fake } = await run([1], () => rows);
    const info = vi.spyOn(app.log, 'info');
    try {
      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(remoteMock.deleteRemoteBackupForRetention).toHaveBeenCalledTimes(100);
      expect(fake.deletedIds).toHaveLength(100);
      expect(info).toHaveBeenCalledWith({ deferred: 200 }, expect.stringContaining('budget reached'));
    } finally {
      await app.close();
    }
  });
});
