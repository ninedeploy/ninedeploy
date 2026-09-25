import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';

const migrationsFolder = fileURLToPath(new URL('../src/migrations', import.meta.url));

/**
 * Reproduces the upgrade state left by releases up to 0.2.36: the server's
 * `ensureEssentialColumns` boot hook patched `databases.owner_user_id` into
 * the live schema before a matching SQL migration existed, so on upgrade the
 * column is present while its migration is still unjournalled. Drizzle's batch
 * migrator aborts that whole upgrade with `duplicate column name`.
 */
/**
 * The migration to forget: the newest one whose replay actually CONFLICTS.
 *
 * This used to be "the newest migration, whatever it is", which was only ever
 * true by accident — it worked while the last file happened to be an
 * `ALTER TABLE … ADD COLUMN`. Adding `0039_log_drains` (a
 * `CREATE TABLE IF NOT EXISTS`, which replays cleanly) silently turned this
 * suite green without it ever reaching the recovery path it exists to test.
 * Pick the migration by what it does instead.
 */
function newestConflictingMigration(): { millis: number; tag: string } {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ when: number; tag: string }> };
  for (const entry of [...journal.entries].reverse()) {
    const body = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    // An ADD COLUMN has no IF NOT EXISTS in SQLite, so replaying it throws
    // `duplicate column name` — which is precisely the upgrade state the
    // recovery path exists to survive.
    // Match a real `ALTER TABLE … ADD` STATEMENT, comments stripped: 0064's
    // header comment mentions "ALTER TABLE … ADD" while the file itself only
    // rebuilds tables (which replays cleanly), and the loose two-regex test
    // picked it — the suite stayed green without reaching the recovery path.
    const statements = body.replace(/--[^\n]*/g, '');
    if (/ALTER TABLE\s+\S+\s+ADD\b/i.test(statements)) return { millis: entry.when, tag: entry.tag };
  }
  throw new Error('no ALTER TABLE … ADD migration found to exercise the recovery path');
}

async function migratedDbWithLastMigrationUnjournalled() {
  const { db } = createDb({ url: ':memory:' });
  await runMigrations(db, migrationsFolder);

  const before = await db.all<{ hash: string; created_at: number }>(
    sql.raw('SELECT hash, created_at FROM `__drizzle_migrations` ORDER BY created_at DESC'),
  );
  // Forget that migration and everything after it, while keeping the objects
  // they created. Drizzle's own migrator resumes from MAX(created_at), so a
  // hole with newer rows still above it reads as "up to date" and the recovery
  // path is never entered — the state to reproduce is the real one: the
  // unjournalled migrations are the newest.
  const target = newestConflictingMigration();
  await db.run(sql.raw(`DELETE FROM \`__drizzle_migrations\` WHERE created_at >= ${target.millis}`));
  return { db, before, target };
}

describe('runMigrations recovery', () => {
  it('completes an upgrade whose objects already exist outside the journal', async () => {
    const { db, before } = await migratedDbWithLastMigrationUnjournalled();

    // Without the recovery path this rejects with `duplicate column name`.
    await expect(runMigrations(db, migrationsFolder)).resolves.toBe(migrationsFolder);

    const after = await db.all<{ hash: string; created_at: number }>(
      sql.raw('SELECT hash, created_at FROM `__drizzle_migrations` ORDER BY created_at DESC'),
    );
    // The journal is whole again: the migration is recorded exactly once.
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.created_at)).toEqual(before.map((r) => r.created_at));
    expect(after.map((r) => r.hash)).toEqual(before.map((r) => r.hash));
  });

  it('leaves an already-current database untouched', async () => {
    const { db } = createDb({ url: ':memory:' });
    await runMigrations(db, migrationsFolder);
    const first = await db.all<{ hash: string }>(sql.raw('SELECT hash FROM `__drizzle_migrations`'));

    // Second run has nothing pending — no recovery, no duplicate journal rows.
    await expect(runMigrations(db, migrationsFolder)).resolves.toBe(migrationsFolder);
    const second = await db.all<{ hash: string }>(sql.raw('SELECT hash FROM `__drizzle_migrations`'));
    expect(second).toHaveLength(first.length);
  });

  it('still fails the upgrade on an error that is not an existing object', async () => {
    const { db } = createDb({ url: ':memory:' });
    // A migrations folder with a journal but no SQL files makes drizzle throw
    // a genuine read error, which must not be swallowed as "already applied".
    await expect(runMigrations(db, fileURLToPath(new URL('.', import.meta.url)))).rejects.toThrow();
  });
});
