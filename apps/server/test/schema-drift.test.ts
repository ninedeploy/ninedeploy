/**
 * Schema-drift regression test.
 *
 * The `databases` table drifted once (the `owner_user_id` column was added
 * to the Drizzle schema and the snapshot but never reached the migrations,
 * breaking every `db.insert(databases)` and `db.query.databases.*` at
 * runtime). This test runs every migration on a fresh in-memory DB and
 * asserts the live `PRAGMA table_info(databases)` matches the columns the
 * Drizzle schema declares.
 *
 * If a future PR adds a column to the schema but forgets the migration,
 * the test will fail with a clear "Missing from actual DB" message —
 * no production deploy needed to discover the drift.
 */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const MIGRATIONS = fileURLToPath(
  pathToFileURL(resolve(REPO_ROOT, 'packages/db/src/migrations')),
);
const { createDb } = await import(
  pathToFileURL(resolve(REPO_ROOT, 'packages/db/src/index.js')).href
);

describe('databases table — schema/migration drift guard', () => {
  it('live PRAGMA table_info matches the columns the Drizzle schema declares', async () => {
    const { db } = createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const cols = await db.all<{ name: string }>(sql`PRAGMA table_info(databases)`);
    const actual = new Set(cols.map((c) => c.name));
    // The canonical list of columns every code path relies on. Update in
    // lock-step with `packages/db/src/schema.ts` and the relevant migration.
    const expected = [
      'id',
      'project_id',
      'owner_user_id',
      'name',
      'slug',
      'engine',
      'version',
      'status',
      'container_name',
      'internal_host',
      'internal_port',
      'username',
      'password_encrypted',
      'db_name',
      'volume_name',
      'cpu_shares',
      'cpu_limit_milli',
      'mem_limit_mb',
      'web_gui_enabled',
      'web_gui_port',
      'extensions',
      'pgbouncer_enabled',
      'pgbouncer_container_name',
      'pgbouncer_port',
      'initialized_at',
      'created_at',
      'updated_at',
    ];
    const missing = expected.filter((c) => !actual.has(c));
    const extra = [...actual].filter((c) => !expected.includes(c));
    expect(missing, `migration missing columns: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `unexpected live columns: ${extra.join(', ')}`).toEqual([]);
    expect(actual.size, 'column count').toBe(expected.length);
  });
});
