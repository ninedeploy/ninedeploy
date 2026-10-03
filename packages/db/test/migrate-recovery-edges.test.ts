import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The recovery path is entered from a failing batch migrate. Throwing a bare
// string (not an Error) exercises the non-Error arm of the error sniffing.
vi.mock('drizzle-orm/libsql/migrator', () => ({
  migrate: vi.fn(async () => {
    throw 'SQLITE_ERROR: table `t` already exists';
  }),
}));

import { createDb } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'nd-migrate-recovery-'));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Write a minimal drizzle migrations folder with a single migration. */
function makeMigrations(name: string, statements: string[]): string {
  const dir = path.join(tmpRoot, name);
  mkdirSync(path.join(dir, 'meta'), { recursive: true });
  writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [{ idx: 0, version: '7', when: 1_700_000_000_000, tag: '0000_only', breakpoints: true }],
    }),
  );
  writeFileSync(path.join(dir, '0000_only.sql'), statements.join('\n--> statement-breakpoint\n'));
  return dir;
}

describe('runMigrations recovery edge cases', () => {
  it('records the migration when the journal table starts out empty', async () => {
    // Second statement repeats the first, so recovery skips it and journals
    // the migration against an empty `__drizzle_migrations`.
    const dir = makeMigrations('empty-journal', ['CREATE TABLE t (a int)', 'CREATE TABLE t (a int)']);
    const { db } = createDb({ url: ':memory:' });

    await expect(runMigrations(db, dir)).resolves.toBe(dir);

    const rows = await db.all<{ created_at: number }>(
      sql.raw('SELECT created_at FROM `__drizzle_migrations`'),
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.created_at)).toBe(1_700_000_000_000);
  });

  it('aborts recovery on a statement that fails for any other reason', async () => {
    const dir = makeMigrations('bad-statement', ['CREATE TABLE t (a int)', 'THIS IS NOT SQL']);
    const { db } = createDb({ url: ':memory:' });

    await expect(runMigrations(db, dir)).rejects.toThrow();
    // The half-applied migration is not journalled, so the next start retries.
    const rows = await db.all(sql.raw('SELECT created_at FROM `__drizzle_migrations`'));
    expect(rows).toHaveLength(0);
  });
});
