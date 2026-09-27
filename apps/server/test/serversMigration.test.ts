/**
 * r399 regression: migration 0065 repairs duplicate (host, port) server rows
 * before creating the unique index. The repair is data surgery on live
 * installs (services and fan-out targets re-pointed at the surviving row,
 * stale rows deleted) — this test executes the migration's own SQL against a
 * database seeded the way a duplicated endpoint left it.
 */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const MIGRATIONS = fileURLToPath(pathToFileURL(resolve(REPO_ROOT, 'packages/db/src/migrations')));
const { createDb } = await import(
  pathToFileURL(resolve(REPO_ROOT, 'packages/db/src/index.js')).href
);

describe('0065 servers_host_port_unique repair', () => {
  it('re-points references to the newest row, deletes stale duplicates, then enforces uniqueness', async () => {
    const { db } = createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    // Wind the schema back to pre-0065 (the index migration 0065 added) so the
    // duplicate state that existed on real installs can be recreated.
    await db.run(sql`DROP INDEX \`servers_host_port_unique\``);
    await db.run(sql`INSERT INTO servers (id, name, host, port, token_encrypted) VALUES
      (1, 'node-old', '10.0.0.5', 4600, 'tok-old'),
      (2, 'node-new', '10.0.0.5', 4600, 'tok-new'),
      (3, 'other', '10.0.0.9', 4600, 'tok-9')`);
    await db.run(sql`INSERT INTO services (id, owner_user_id, name, slug, type, status, health_path, created_at, updated_at) VALUES
      (10, NULL, 'api-a', 'api-a', 'docker', 'running', '/', 0, 0),
      (11, NULL, 'api-b', 'api-b', 'docker', 'running', '/', 0, 0)`);
    await db.run(sql`UPDATE services SET server_id = 1 WHERE id = 10`);
    await db.run(sql`UPDATE services SET server_id = 3 WHERE id = 11`);
    await db.run(sql`INSERT INTO service_targets (id, service_id, server_id, status, created_at, updated_at) VALUES
      (1, 10, 1, 'running', 0, 0),
      (2, 11, 3, 'running', 0, 0)`);

    // Run the migration's own repair + index statements (everything before
    // the metrics index, which is irrelevant here).
    const migrationSql = readFileSync(
      resolve(REPO_ROOT, 'packages/db/src/migrations/0065_dazzling_clint_barton.sql'),
      'utf8',
    );
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((s) => s.replace(/^--[^\n]*\n/gm, '').trim())
      .filter((s) => s.length > 0 && !s.startsWith('CREATE INDEX `metrics'));
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) {
      await db.run(sql.raw(statement));
    }

    // The stale row is gone; the newest row for the endpoint survives.
    const rows = await db.all<{ id: number; name: string }>(sql`SELECT id, name FROM servers ORDER BY id`);
    expect(rows).toEqual([
      { id: 2, name: 'node-new' },
      { id: 3, name: 'other' },
    ]);

    // The service attached to the stale row now targets the surviving one;
    // the service on the untouched endpoint is unchanged.
    const svc10 = await db.all<{ server_id: number }>(sql`SELECT server_id FROM services WHERE id = 10`);
    expect(svc10[0]?.server_id).toBe(2);
    const svc11 = await db.all<{ server_id: number }>(sql`SELECT server_id FROM services WHERE id = 11`);
    expect(svc11[0]?.server_id).toBe(3);

    // Fan-out targets followed their services.
    const target1 = await db.all<{ server_id: number }>(sql`SELECT server_id FROM service_targets WHERE id = 1`);
    expect(target1[0]?.server_id).toBe(2);

    // And the endpoint is unique from here on (libsql throws on the
    // constraint rather than answering a result object; drizzle wraps it).
    await expect(
      db.run(sql`INSERT INTO servers (name, host, port, token_encrypted) VALUES ('dup', '10.0.0.5', 4600, 'x')`),
    ).rejects.toMatchObject({ cause: { code: 'SQLITE_CONSTRAINT' } });
  });
});
