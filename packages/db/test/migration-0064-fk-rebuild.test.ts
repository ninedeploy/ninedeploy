import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/index.js';

const migrationsFolder = fileURLToPath(new URL('../src/migrations', import.meta.url));
const TAG = '0064_fk_set_null_and_invitation_reissue';

/**
 * r300: 0064 rebuilds `services` and `backups` to give `environment_id` /
 * `destination_id` their ON DELETE SET NULL rule. A table rebuild on an
 * EXISTING install is the risky part — `services` is the parent of ~20
 * tables, and a DROP TABLE that runs with foreign keys on cascades into all of
 * them. These tests upgrade a populated 0063 database and check that nothing
 * but the delete rule changed.
 */
const scratch = mkdtempSync(join(tmpdir(), 'nd-0064-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of the migrations folder whose journal stops just before 0064. */
function folderBefore0064(): string {
  const dir = join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  expect(at).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function seed(client: Client): Promise<void> {
  await client.execute(`INSERT INTO users (id, email, password_hash) VALUES (1, 'o@example.com', 'x')`);
  await client.execute(`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (1, 'W', 'w', 1)`);
  await client.execute(`INSERT INTO environments (id, workspace_id, name, slug) VALUES (1, 1, 'Production', 'production')`);
  // Service 3 is created and deleted so the AUTOINCREMENT high-water mark (3)
  // sits above MAX(id) (2) — the rebuild must not hand id 3 out again.
  for (const id of [1, 2, 3]) {
    await client.execute({
      sql: `INSERT INTO services (id, name, slug, environment_id, replicas, runtime_replicas) VALUES (?, ?, ?, ?, 2, 2)`,
      args: [id, `svc${id}`, `svc${id}`, id === 1 ? 1 : null],
    });
  }
  await client.execute(`DELETE FROM services WHERE id = 3`);
  await client.execute(`INSERT INTO deployments (id, service_id, status) VALUES (10, 1, 'running')`);
  await client.execute(`INSERT INTO domains (id, service_id, hostname) VALUES (20, 1, 'a.example.com')`);
  await client.execute(
    `INSERT INTO backup_destinations (id, name, endpoint, bucket, access_key_id, secret_key_encrypted) VALUES (1, 's3', 'https://s3', 'b', 'k', 'v0:x')`,
  );
  for (const id of [1, 2]) {
    await client.execute({
      sql: `INSERT INTO backups (id, volume_name, scope, status, path, remote_key, destination_id, label) VALUES (?, 'nd-svc-svc1-data', 'volumes', 'ok', '/b', 'k', 1, 'manual')`,
      args: [id],
    });
  }
  await client.execute(`DELETE FROM backups WHERE id = 2`);
}

async function count(client: Client, table: string): Promise<number> {
  return Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!['n']);
}

async function assertUpgraded(client: Client): Promise<void> {
  // Rows and children survived — the rebuild did not cascade.
  expect(await count(client, 'services')).toBe(2);
  expect(await count(client, 'deployments')).toBe(1);
  expect(await count(client, 'domains')).toBe(1);
  expect(await count(client, 'backups')).toBe(1);
  const svc = (await client.execute('SELECT * FROM services WHERE id = 1')).rows[0]!;
  expect(svc['environment_id']).toBe(1);
  expect(svc['replicas']).toBe(2);
  expect(svc['runtime_replicas']).toBe(2);
  expect((await client.execute('SELECT label, destination_id FROM backups WHERE id = 1')).rows[0]).toMatchObject({
    label: 'manual',
    destination_id: 1,
  });

  // Indexes recreated.
  const idx = (await client.execute(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('services','backups')`)).rows.map(
    (r) => String(r['name']),
  );
  expect(idx).toEqual(
    expect.arrayContaining(['services_slug_unique', 'services_server_idx', 'backups_db_status_idx', 'backups_volume_created_idx']),
  );
  expect((await client.execute(`SELECT name FROM sqlite_master WHERE name LIKE '__new_%'`)).rows).toEqual([]);

  // AUTOINCREMENT high-water marks carried across.
  await client.execute(`INSERT INTO services (name, slug) VALUES ('svc4', 'svc4')`);
  expect(Number((await client.execute(`SELECT MAX(id) AS m FROM services`)).rows[0]!['m'])).toBe(4);
  await client.execute(`INSERT INTO backups (volume_name, scope, path) VALUES ('v', 'volumes', '/c')`);
  expect(Number((await client.execute(`SELECT MAX(id) AS m FROM backups`)).rows[0]!['m'])).toBe(3);

  // The actual fix: both parents can now be deleted, and the children detach.
  await client.execute('PRAGMA foreign_keys = ON');
  expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  await client.execute('DELETE FROM environments WHERE id = 1');
  expect((await client.execute('SELECT environment_id FROM services WHERE id = 1')).rows[0]!['environment_id']).toBeNull();
  await client.execute('DELETE FROM backup_destinations WHERE id = 1');
  expect((await client.execute('SELECT destination_id FROM backups WHERE id = 1')).rows[0]!['destination_id']).toBeNull();
  // Deleting the lane detached the services; it deleted none of them.
  expect(await count(client, 'services')).toBe(3);
  expect(await count(client, 'deployments')).toBe(1);
}

describe('migration 0064 — FK SET NULL rebuild (r300)', () => {
  it('upgrades a populated 0063 database through the drizzle migrator without losing rows', async () => {
    const { db, client } = createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder: folderBefore0064() });
    await seed(client!);

    // On 0063 the delete fails: the defect.
    await client!.execute('PRAGMA foreign_keys = ON');
    await expect(client!.execute('DELETE FROM environments WHERE id = 1')).rejects.toThrow(/FOREIGN KEY/);

    await migrate(db, { migrationsFolder });
    await assertUpgraded(client!);
  });

  it('is safe on the statement-by-statement recovery path, which runs with foreign keys ON', async () => {
    // `applyToleratingExistingObjects` (migrate.ts) replays a migration one
    // statement at a time in autocommit on a connection that has foreign keys
    // on. Without the migration's own PRAGMA foreign_keys=OFF, DROP TABLE
    // `services` would cascade-delete every deployment and domain.
    const { db, client } = createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder: folderBefore0064() });
    await seed(client!);
    await client!.execute('PRAGMA foreign_keys = ON');

    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const when = journal.entries.find((e) => e.tag === TAG)?.when;
    const m = readMigrationFiles({ migrationsFolder }).find((x) => x.folderMillis === when);
    expect(m).toBeDefined();
    for (const stmt of m!.sql) await client!.execute(stmt);

    await assertUpgraded(client!);
  });
});
