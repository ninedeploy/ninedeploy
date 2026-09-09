import { describe, expect, it } from 'vitest';
import { missedBackupsFrom } from '../../src/plugins/backupScheduler.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

interface DbRow {
  id: number;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
}
interface BackupRow {
  databaseId: number;
  scope: string;
  status: string;
  createdAt: Date;
}

const dbRow = (over: Partial<DbRow> = {}): DbRow => ({
  id: 1,
  name: 'pg-app',
  slug: 'pg-app',
  status: 'running',
  createdAt: new Date(NOW - 30 * DAY),
  ...over,
});
const backupRow = (over: Partial<BackupRow> = {}): BackupRow => ({
  databaseId: 1,
  scope: 'scheduled',
  status: 'completed',
  createdAt: new Date(NOW - 6 * 60 * 60 * 1000),
  ...over,
});

const check = (dbs: DbRow[], scheduled: BackupRow[]) =>
  missedBackupsFrom(dbs, scheduled, { missedAfterMs: 2 * DAY, now: NOW });

describe('missedBackupsFrom', () => {
  it('flags a running database whose newest scheduled backup is older than the window', async () => {
    const missed = check([dbRow()], [backupRow({ createdAt: new Date(NOW - 3 * DAY) })]);
    expect(missed).toEqual([{ id: 1, name: 'pg-app', days: 3 }]);
  });

  it('does not flag a database backed up within the window', async () => {
    const missed = await check([dbRow()], [backupRow({ createdAt: new Date(NOW - 6 * 60 * 60 * 1000) })]);
    expect(missed).toEqual([]);
  });

  it('flags a database that has never been backed up once it is old enough', async () => {
    const missed = await check([dbRow({ createdAt: new Date(NOW - 5 * DAY) })], []);
    expect(missed).toEqual([{ id: 1, name: 'pg-app', days: 5 }]);
  });

  it('does not flag a newborn database that has no backup yet', async () => {
    const missed = await check([dbRow({ createdAt: new Date(NOW - 60 * 60 * 1000) })], []);
    expect(missed).toEqual([]);
  });

  it('flags on age even when the newest scheduled row is a failure', async () => {
    // A fresh `failed` row is the per-run audit's job; an OLD row of any
    // status means the pipeline has not touched this database in days.
    const missed = await check([dbRow()], [backupRow({ status: 'failed', createdAt: new Date(NOW - 3 * DAY) })]);
    expect(missed).toEqual([{ id: 1, name: 'pg-app', days: 3 }]);
  });

  it('uses the NEWEST scheduled row, not an older successful one', async () => {
    const missed = await check([dbRow()], [
      backupRow({ status: 'failed', createdAt: new Date(NOW - 6 * 60 * 60 * 1000) }),
      backupRow({ status: 'completed', createdAt: new Date(NOW - 5 * DAY) }),
    ]);
    expect(missed).toEqual([]);
  });

  it('ignores databases that are not running', async () => {
    const missed = await check(
      [dbRow({ status: 'stopped' }), dbRow({ status: 'idle' })],
      [backupRow({ createdAt: new Date(NOW - 10 * DAY) })],
    );
    expect(missed).toEqual([]);
  });

  it('handles multiple databases independently', async () => {
    const dbs = [dbRow(), dbRow({ id: 2, name: 'redis', slug: 'redis', createdAt: new Date(NOW - 30 * DAY) })];
    const missed = await check(
      dbs,
      [
        backupRow({ databaseId: 1, createdAt: new Date(NOW - 6 * 60 * 60 * 1000) }),
        backupRow({ databaseId: 2, createdAt: new Date(NOW - 4 * DAY) }),
      ],
    );
    expect(missed).toEqual([{ id: 2, name: 'redis', days: 4 }]);
  });
});
