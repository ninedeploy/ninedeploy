import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Enter the recovery path directly: Drizzle's batch migrator "fails" with the
// signature of a schema patched outside the journal.
vi.mock('drizzle-orm/libsql/migrator', () => ({
  migrate: vi.fn(async () => {
    throw new Error('SQLITE_ERROR: table `t` already exists');
  }),
}));

import { createDb } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';

/**
 * r546 — the "already exists" recovery path applies each migration
 * all-or-nothing. It used to replay statements one by one in autocommit, so an
 * error that was not "already exists" halfway through left the earlier
 * statements applied and the migration unrecorded — the next boot replayed it
 * on top of its own leftovers. Real SQLite files: the recovery path runs on
 * every production boot that needs it.
 */
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'nd-migrate-atomic-'));
afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

let seq = 0;

/** A drizzle migrations folder holding the given migrations, in order. */
function makeMigrations(migrations: Array<{ tag: string; statements: string[] }>): string {
  const dir = path.join(tmpRoot, `m${seq++}`);
  mkdirSync(path.join(dir, 'meta'), { recursive: true });
  writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: migrations.map((m, i) => ({ idx: i, version: '7', when: 1_700_000_000_000 + i, tag: m.tag, breakpoints: true })),
    }),
  );
  for (const m of migrations) {
    writeFileSync(path.join(dir, `${m.tag}.sql`), m.statements.join('\n--> statement-breakpoint\n'));
  }
  return dir;
}

async function tempDb() {
  const file = path.join(tmpRoot, `db${seq++}.db`).split(path.sep).join('/');
  const created = createDb({ url: `file:${file}` });
  await created.ready;
  return created;
}

async function tables(db: Awaited<ReturnType<typeof tempDb>>['db']): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name`),
  );
  return rows.map((r) => r.name);
}

async function journal(db: Awaited<ReturnType<typeof tempDb>>['db']): Promise<number[]> {
  const rows = await db.all<{ created_at: number }>(sql.raw('SELECT created_at FROM `__drizzle_migrations` ORDER BY created_at'));
  return rows.map((r) => Number(r.created_at));
}

describe('r546: atomic recovery replay', () => {
  it('still skips objects that already exist and journals the migration', async () => {
    const { db } = await tempDb();
    await db.run(sql.raw('CREATE TABLE t (a int)')); // patched in outside the journal
    const dir = makeMigrations([{ tag: '0000_a', statements: ['CREATE TABLE t (a int)', 'ALTER TABLE t ADD b int', 'CREATE TABLE u (c int)'] }]);

    await expect(runMigrations(db, dir)).resolves.toBe(dir);
    expect(await tables(db)).toEqual(['t', 'u']);
    expect((await db.all<{ name: string }>(sql.raw('PRAGMA table_info(t)'))).map((c) => c.name)).toEqual(['a', 'b']);
    expect(await journal(db)).toEqual([1_700_000_000_000]);
  });

  it('rolls a failing migration back whole instead of leaving it half-applied', async () => {
    const { db } = await tempDb();
    await db.run(sql.raw('CREATE TABLE t (a int)'));
    const dir = makeMigrations([
      {
        tag: '0000_broken',
        // t is skipped (exists), u is created, then a genuine error.
        statements: ['CREATE TABLE t (a int)', 'CREATE TABLE u (c int)', 'INSERT INTO missing_table VALUES (1)'],
      },
    ]);

    const err = await runMigrations(db, dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/0000_broken failed at statement 2 \(INSERT INTO missing_table/);
    expect((err as Error).message).toMatch(/no such table: missing_table/);
    expect((err as Error).message).toMatch(/rolled back/);
    // Old behaviour: `u` existed and the migration was unrecorded.
    expect(await tables(db)).toEqual(['t']);
    expect(await journal(db)).toEqual([]);
  });

  it('keeps earlier migrations of the same run applied and journalled', async () => {
    const { db } = await tempDb();
    await db.run(sql.raw('CREATE TABLE t (a int)'));
    const dir = makeMigrations([
      { tag: '0000_ok', statements: ['CREATE TABLE t (a int)', 'CREATE TABLE u (c int)'] },
      { tag: '0001_broken', statements: ['CREATE TABLE v (d int)', 'NOT SQL AT ALL'] },
    ]);

    await expect(runMigrations(db, dir)).rejects.toThrow(/0001_broken failed/);
    expect(await tables(db)).toEqual(['t', 'u']);
    expect(await journal(db)).toEqual([1_700_000_000_000]);

    // The next start, with the migration fixed, picks up exactly where it stopped.
    const fixed = makeMigrations([
      { tag: '0000_ok', statements: ['CREATE TABLE t (a int)', 'CREATE TABLE u (c int)'] },
      { tag: '0001_broken', statements: ['CREATE TABLE v (d int)'] },
    ]);
    await expect(runMigrations(db, fixed)).resolves.toBe(fixed);
    expect(await tables(db)).toEqual(['t', 'u', 'v']);
    expect(await journal(db)).toEqual([1_700_000_000_000, 1_700_000_000_001]);
  });

  it('names the migration and never skips when the error does not say which statement failed', async () => {
    const { db } = await tempDb();
    const dir = makeMigrations([{ tag: '0000_x', statements: ['CREATE TABLE t (a int)'] }]);
    const client = (db as unknown as { $client: { migrate: (...a: unknown[]) => Promise<unknown> } }).$client;
    const real = client.migrate.bind(client);
    try {
      // A thrown primitive: no statement index, no Error message.
      client.migrate = vi.fn(async () => {
        throw 'connection reset';
      });
      await expect(runMigrations(db, dir)).rejects.toThrow(/Database migration 0000_x failed: connection reset\. It was rolled back/);
      // An "already exists" that points past the migration's own statements
      // (the journal row) is not skippable either.
      client.migrate = vi.fn(async () => {
        throw Object.assign(new Error('index already exists'), { statementIndex: 1 });
      });
      await expect(runMigrations(db, dir)).rejects.toThrow(/0000_x failed: index already exists/);
    } finally {
      client.migrate = real;
    }
    expect(await tables(db)).toEqual([]);
  });

  it('runs with foreign keys OFF, so a table rebuild does not cascade into child rows (0064)', async () => {
    const { db } = await tempDb();
    await db.run(sql.raw('CREATE TABLE t (a int)'));
    await db.run(sql.raw('CREATE TABLE p (id integer PRIMARY KEY)'));
    await db.run(sql.raw('CREATE TABLE c (id integer PRIMARY KEY, p_id integer REFERENCES p(id) ON DELETE CASCADE)'));
    await db.run(sql.raw('INSERT INTO p (id) VALUES (1)'));
    await db.run(sql.raw('INSERT INTO c (id, p_id) VALUES (10, 1)'));
    const dir = makeMigrations([
      {
        tag: '0000_rebuild',
        statements: [
          'CREATE TABLE t (a int)',
          'CREATE TABLE __new_p (id integer PRIMARY KEY, note text)',
          'INSERT INTO __new_p (id) SELECT id FROM p',
          'DROP TABLE p',
          'ALTER TABLE __new_p RENAME TO p',
        ],
      },
    ]);

    await expect(runMigrations(db, dir)).resolves.toBe(dir);
    expect(await db.all(sql.raw('SELECT id, p_id FROM c'))).toEqual([{ id: 10, p_id: 1 }]);
    // …and the connection is handed back with foreign keys on again.
    expect(await db.all(sql.raw('PRAGMA foreign_keys'))).toEqual([{ foreign_keys: 1 }]);
  });
});
