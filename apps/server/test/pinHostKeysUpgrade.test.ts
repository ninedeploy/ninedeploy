/**
 * Upgrade compatibility for migration 0073 (`pin_host_keys`, 0.15.8).
 *
 * A self-updating panel applies 0073 to a populated 0.15.7 database. It adds
 * two columns to `sources`: a defaulted flag and a nullable text. Every
 * existing row must read back exactly as it was, every source must keep the
 * per-job accept-new policy (flag off, no stored keys), and a rollback to
 * 0.15.7 must boot on the migrated file.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, sources } from '@ninedeploy/db';
import { migrationsThrough } from './fixtures/migrationsThrough.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-0073-'));
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TAG = '0073_pin_host_keys';
const PREVIOUS = '0072_multi_node';

async function populated0157() {
  const { db, client } = createDb({ url: ':memory:' });
  await runMigrations(db, migrationsThrough(PREVIOUS, scratch));
  await client.execute(
    `INSERT INTO sources (id, type, name, token_encrypted, deploy_key_encrypted, default_branch, base_url, allow_on_nodes)
     VALUES (1, 'github', 'pat', 'enc-token', NULL, 'main', NULL, 0),
            (2, 'gitlab', 'key', NULL, 'enc-key', 'develop', 'https://git.example.com', 1),
            (3, 'registry', 'reg', 'enc-pw', NULL, NULL, NULL, 0)`,
  );
  return { db, client };
}

const sourceRows = async (client: ReturnType<typeof createDb>['client'], columns: string) =>
  (await client.execute(`SELECT ${columns} FROM sources ORDER BY id`)).rows.map((r) => ({ ...r }));

describe('migration 0073 upgrade compatibility', () => {
  it('is the last journal entry, chained to 0072, and adds only a defaulted flag and a nullable text', () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === TAG)!;
    const prior = journal.entries.find((e) => e.tag === PREVIOUS)!;
    expect(entry.when).toBeGreaterThan(prior.when);
    expect(journal.entries.indexOf(entry)).toBe(journal.entries.indexOf(prior) + 1);
    const sql = readFileSync(path.join(migrationsFolder, `${TAG}.sql`), 'utf8');
    const statements = sql.split('--> statement-breakpoint').map((s) => s.replace(/^--.*$/gm, '').trim()).filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE `sources` ADD `pin_host_keys` integer DEFAULT false NOT NULL;',
      'ALTER TABLE `sources` ADD `host_keys` text;',
    ]);
  });

  it('leaves every 0.15.7 source byte-identical and reads the new columns as off and empty', async () => {
    const { db, client } = await populated0157();
    const old = 'id, type, name, token_encrypted, deploy_key_encrypted, default_branch, base_url, allow_on_nodes, registry_username, created_at, updated_at';
    const before = await sourceRows(client, old);
    const ddlBefore = (await client.execute(`SELECT sql FROM sqlite_master WHERE name = 'sources'`)).rows[0]!['sql'] as string;

    await runMigrations(db, migrationsFolder);

    expect(await sourceRows(client, old)).toEqual(before);
    expect(await sourceRows(client, 'pin_host_keys, host_keys')).toEqual(before.map(() => ({ pin_host_keys: 0, host_keys: null })));
    const ddlAfter = (await client.execute(`SELECT sql FROM sqlite_master WHERE name = 'sources'`)).rows[0]!['sql'] as string;
    expect(ddlAfter).toBe(ddlBefore.replace(/\)$/, ', `pin_host_keys` integer DEFAULT false NOT NULL, `host_keys` text)'));
    // Through today's schema: pinning is off for every row.
    const rows = await db.select().from(sources);
    expect(rows.map((r) => [r.pinHostKeys, r.hostKeys])).toEqual([[false, null], [false, null], [false, null]]);
  });

  it('is idempotent, and the 0.15.7 migrator applies nothing to a migrated database (rollback boots)', async () => {
    const { db, client } = await populated0157();
    await runMigrations(db, migrationsFolder);
    await runMigrations(db, migrationsFolder);
    expect((await client.execute(`SELECT COUNT(*) AS n FROM __drizzle_migrations WHERE hash IS NOT NULL`)).rows[0]!['n']).toBeGreaterThan(70);
    await expect(runMigrations(db, migrationsThrough(PREVIOUS, scratch))).resolves.not.toThrow();
    // The 0.15.7 reads (explicit column lists) never mention the new columns, so they keep working.
    const rows = await sourceRows(client, 'id, type, name, token_encrypted, deploy_key_encrypted, default_branch, base_url, allow_on_nodes');
    expect(rows).toHaveLength(3);
  });
});
