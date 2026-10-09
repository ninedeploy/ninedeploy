/**
 * 0.12 upgrade compatibility for migration 0067 (`database_backup_policies`).
 *
 * A self-updating panel applies 0067 to a populated database. The migration
 * only creates a table, and a database without a policy row must keep the
 * pre-0.12 schedule exactly: the daily run, 7 completed scheduled dumps kept,
 * the remote copy on the active destination. This test:
 *   1. applies every migration BEFORE 0067 to a scratch SQLite,
 *   2. inserts a database and its scheduled backups the way 0.11 did (raw SQL
 *      against the 0.11 columns),
 *   3. applies 0067,
 *   4. boots the real scheduler on that database and checks it still runs the
 *      built-in daily/7 rules for the old row.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import Fastify from 'fastify';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB } from '@ninedeploy/db';

const engineMock = vi.hoisted(() => ({ backupDatabase: vi.fn(async (_d: unknown, file: string) => {
  const { writeFileSync: write } = await import('node:fs');
  write(file, 'new-dump');
}) }));
vi.mock('../src/engine/database.js', () => engineMock);
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);
const remoteMock = vi.hoisted(() => ({
  uploadBackup: vi.fn(async () => undefined),
  deleteRemoteBackupForRetention: vi.fn(async (): Promise<'deleted' | 'unknown-destination'> => 'deleted'),
}));
vi.mock('../src/lib/backupRemote.js', () => remoteMock);
import { migrationsThrough } from './fixtures/migrationsThrough.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-0067-'));
mkdirSync(path.join(scratch, 'backups'), { recursive: true });
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);

const { default: backupSchedulerPlugin } = await import('../src/plugins/backupScheduler.js');
const { loadBackupPolicies, serializeBackupPolicy } = await import('../src/lib/backupPolicy.js');

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TAG = '0067_database_backup_policies';
const DAY_S = 24 * 60 * 60;

afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function folderBefore0067(): string {
  const dir = path.join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  expect(at).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/** A 0.11 database with one running managed database and 8 daily dumps. */
async function populated011(): Promise<{ db: DB; client: Client; files: string[] }> {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderBefore0067() });
  const tables = (await client!.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='database_backup_policies'`)).rows;
  expect(tables).toHaveLength(0);
  const now = Math.floor(Date.now() / 1000);
  await client!.execute({
    sql: `INSERT INTO databases (id, name, slug, engine, status, password_encrypted, created_at, updated_at)
          VALUES (1, 'legacy', 'legacy', 'postgres', 'running', 'v1:x', ?, ?)`,
    args: [now - 30 * DAY_S, now - 30 * DAY_S],
  });
  await client!.execute(
    `INSERT INTO backup_destinations (id, name, endpoint, bucket, access_key_id, secret_key_encrypted, active)
     VALUES (1, 'active', 'https://s3.invalid', 'b', 'k', 'v1:s', 1)`,
  );
  const files: string[] = [];
  for (let i = 0; i < 8; i++) {
    const file = path.join(scratch, 'backups', `legacy-${i}.dump`);
    writeFileSync(file, `dump ${i}`);
    files.push(file);
    await client!.execute({
      sql: `INSERT INTO backups (database_id, scope, status, path, size_bytes, created_at) VALUES (1, 'scheduled', 'completed', ?, 6, ?)`,
      args: [file, now - (i + 1) * DAY_S],
    });
  }
  return { db, client: client!, files };
}

describe('migration 0067 upgrade compatibility', () => {
  it('is purely additive: one new table, every 0.11 row untouched', async () => {
    const { db, client } = await populated011();
    const before = (await client.execute('SELECT * FROM databases')).rows;
    const backupsBefore = (await client.execute('SELECT * FROM backups ORDER BY id')).rows;

    // Through 0067 only: 0072 later adds nullable columns to both tables.
    await migrate(db, { migrationsFolder: migrationsThrough(TAG, scratch) });

    expect((await client.execute('SELECT * FROM databases')).rows).toEqual(before);
    expect((await client.execute('SELECT * FROM backups ORDER BY id')).rows).toEqual(backupsBefore);
    expect((await client.execute('SELECT COUNT(*) AS n FROM database_backup_policies')).rows[0]!['n']).toBe(0);
    // The SQL is a single CREATE TABLE — no rebuild of an existing table.
    const sqlText = readFileSync(path.join(migrationsFolder, `${TAG}.sql`), 'utf8');
    expect(sqlText).toMatch(/^CREATE TABLE `database_backup_policies`/);
    expect(sqlText).not.toMatch(/__new_|DROP |ALTER TABLE|INSERT INTO|^\s*UPDATE |DELETE FROM/im);
  });

  it('an old database with no policy row stays on the built-in daily/7 schedule', async () => {
    const { db, files } = await populated011();
    await migrate(db, { migrationsFolder });

    const policies = await loadBackupPolicies(db);
    expect(policies.size).toBe(0);
    expect(serializeBackupPolicy(1, policies.get(1))).toMatchObject({ configured: false, retainCount: 7, cron: null, destinationId: null, localOnly: false });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(backupSchedulerPlugin);
    try {
      // Newest scheduled dump is a day old → the built-in tick is due after the
      // 5-minute startup grace, exactly as in 0.11 (r170).
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      // The tick's SQLite I/O completes on the real event loop.
      for (let i = 0; i < 500; i++) {
        if ((await countScheduled(db)) === 7 && engineMock.backupDatabase.mock.calls.length === 1) break;
        await new Promise((r) => setImmediate(r));
      }
      expect(engineMock.backupDatabase).toHaveBeenCalledTimes(1);
      expect((engineMock.backupDatabase.mock.calls[0] as unknown as [{ id: number }])[0].id).toBe(1);
      // Uploaded through the active destination — no policy destination argument.
      expect(remoteMock.uploadBackup).toHaveBeenCalledTimes(1);
      expect((remoteMock.uploadBackup.mock.calls[0] as unknown[]).length).toBe(4);
      // 8 old + 1 new completed scheduled dumps, 7 kept: the two oldest go.
      expect(await countScheduled(db)).toBe(7);
      expect(existsSync(files[7]!)).toBe(false);
      expect(existsSync(files[6]!)).toBe(false);
      expect(existsSync(files[5]!)).toBe(true);
      expect(existsSync(files[0]!)).toBe(true);
      // Still no policy row: nothing was written on the operator's behalf.
      expect((await loadBackupPolicies(db)).size).toBe(0);
    } finally {
      await app.close();
    }
  });
});

async function countScheduled(db: DB): Promise<number> {
  const rows = await db.query.backups.findMany();
  return rows.filter((r) => r.scope === 'scheduled' && r.status === 'completed').length;
}
