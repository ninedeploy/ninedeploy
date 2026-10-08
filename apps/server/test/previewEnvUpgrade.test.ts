/**
 * 0.12 upgrade compatibility for migration 0068 (`preview_env_vars`).
 *
 * A self-updating panel applies 0068 to a populated database. The migration
 * only creates a table, and every service must deploy with exactly the
 * environment it had on 0.11 until someone adds a preview-only value:
 *   1. apply every migration BEFORE 0068 to a scratch SQLite,
 *   2. insert a git-backed service with plain + secret env and a PR preview
 *      the way 0.11's webhook created it (raw SQL against the 0.11 columns:
 *      the parent's NON-secret rows copied onto the preview),
 *   3. apply 0068,
 *   4. assemble both runtime environments with the 0.12 code: production is
 *      byte-identical to its pre-migration assembly, the preview gets exactly
 *      its 0.11 values, and no existing row was rewritten.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, services } from '@ninedeploy/db';

// The pipeline module is imported for its env assembly only — nothing here
// may reach Docker, PM2, git, the proxy or the notifier.
vi.mock('../src/engine/builders/docker.js', () => ({ dockerBuilder: {}, railpackUnavailableReason: vi.fn(async () => null) }));
vi.mock('../src/engine/builders/pm2.js', () => ({ pm2Builder: {} }));
vi.mock('../src/engine/builders/compose.js', () => ({ composeBuilder: {} }));
vi.mock('../src/engine/proxy.js', () => ({ writeDynamicConfig: vi.fn(), getAcmeEmail: vi.fn(async () => null) }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: vi.fn() }));
vi.mock('../src/lib/git.js', () => ({ checkoutCommit: vi.fn() }));
vi.mock('../src/lib/exec.js', () => ({ sleep: vi.fn(async () => undefined), run: vi.fn() }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-0068-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);
vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));

const { encrypt } = await import('../src/lib/crypto.js');
const { loadRuntimeEnv } = await import('../src/engine/pipeline.js');

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TAG = '0068_preview_env_vars';

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function folderBefore0068(): string {
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

/** A 0.11 database: service #1 (git-backed, previews on) and its PR #7 preview #2. */
async function populated011(): Promise<{ db: DB; client: Client }> {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderBefore0068() });
  const tables = (await client!.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='preview_env_vars'`)).rows;
  expect(tables).toHaveLength(0);
  await client!.execute(
    `INSERT INTO services (id, name, slug, type, repo_url, branch, preview_deployments_enabled)
     VALUES (1, 'web', 'web', 'docker', 'https://github.com/acme/web.git', 'main', 1)`,
  );
  await client!.execute(
    `INSERT INTO services (id, name, slug, type, repo_url, branch, is_ephemeral_preview, preview_parent_service_id, pr_number)
     VALUES (2, 'web (PR #7)', 'web-pr-7', 'docker', 'https://github.com/acme/web.git', 'feature', 1, 1, 7)`,
  );
  const plain = encrypt('https://api.example.com');
  const env = (id: number, serviceId: number, key: string, value: string, secret: boolean) =>
    client!.execute({
      sql: `INSERT INTO env_vars (id, service_id, scope, scope_key, key, value_encrypted, is_secret) VALUES (?, ?, 'service', ?, ?, ?, ?)`,
      args: [id, serviceId, serviceId, key, value, secret ? 1 : 0],
    });
  await env(1, 1, 'API_URL', plain, false);
  await env(2, 1, 'DATABASE_URL', encrypt('postgres://prod:hunter2@db/app'), true);
  await env(3, 1, 'STRIPE_KEY', encrypt('sk_live_production'), true);
  // 0.11's webhook copied the parent's NON-secret rows verbatim (same ciphertext).
  await env(4, 2, 'API_URL', plain, false);
  return { db, client: client! };
}

const serviceRow = async (db: DB, id: number) => (await db.query.services.findFirst({ where: eq(services.id, id) }))!;

describe('migration 0068 upgrade compatibility', () => {
  it('is purely additive: one new table and its index, nothing rebuilt', () => {
    const sqlText = readFileSync(path.join(migrationsFolder, `${TAG}.sql`), 'utf8');
    expect(sqlText).toMatch(/^CREATE TABLE `preview_env_vars`/);
    const statements = sqlText.split('--> statement-breakpoint').map((s) => s.trim());
    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX `preview_env_vars_service_key_idx`/);
    expect(sqlText).not.toMatch(/__new_|DROP |ALTER TABLE|INSERT INTO|^\s*UPDATE |DELETE FROM/im);
  });

  it('production env is byte-identical, the preview gets exactly its 0.11 env, and no row is rewritten', async () => {
    const { db, client } = await populated011();
    const envRowsBefore = (await client.execute('SELECT * FROM env_vars ORDER BY id')).rows;
    const serviceRowsBefore = (await client.execute('SELECT * FROM services ORDER BY id')).rows;
    // The production path never touches the new table, so it assembles on the
    // 0.11 schema too — the reference for "byte-identical".
    const prodBefore = await loadRuntimeEnv(db, await serviceRow(db, 1));

    await migrate(db, { migrationsFolder });

    expect((await client.execute('SELECT * FROM env_vars ORDER BY id')).rows).toEqual(envRowsBefore);
    expect((await client.execute('SELECT * FROM services ORDER BY id')).rows).toEqual(serviceRowsBefore);
    expect((await client.execute('SELECT COUNT(*) AS n FROM preview_env_vars')).rows[0]!['n']).toBe(0);

    const prodAfter = await loadRuntimeEnv(db, await serviceRow(db, 1));
    expect(JSON.stringify(prodAfter)).toBe(JSON.stringify(prodBefore));
    expect(prodAfter.values).toEqual({
      API_URL: 'https://api.example.com',
      DATABASE_URL: 'postgres://prod:hunter2@db/app',
      STRIPE_KEY: 'sk_live_production',
    });

    // 0.11 gave the preview its own (copied, non-secret) rows and nothing else.
    const previewAfter = await loadRuntimeEnv(db, await serviceRow(db, 2));
    expect(previewAfter.values).toEqual({ API_URL: 'https://api.example.com' });
    expect(previewAfter.withheldFromPreview).toEqual([]);
  });

  it('an existing preview picks up a preview-only value on its next deploy; production never does', async () => {
    const { db, client } = await populated011();
    await migrate(db, { migrationsFolder });
    const prodBefore = JSON.stringify(await loadRuntimeEnv(db, await serviceRow(db, 1)));

    await client.execute({
      sql: `INSERT INTO preview_env_vars (service_id, key, value_encrypted, is_secret) VALUES (1, 'API_URL', ?, 0), (1, 'STRIPE_KEY', ?, 1)`,
      args: [encrypt('https://staging.example.com'), encrypt('sk_test_preview')],
    });

    const preview = await loadRuntimeEnv(db, await serviceRow(db, 2));
    expect(preview.values).toEqual({ API_URL: 'https://staging.example.com', STRIPE_KEY: 'sk_test_preview' });
    // The parent's secrets still never reach the preview (F651).
    expect(JSON.stringify(preview.values)).not.toContain('hunter2');
    expect(JSON.stringify(preview.values)).not.toContain('sk_live_production');
    expect(JSON.stringify(await loadRuntimeEnv(db, await serviceRow(db, 1)))).toBe(prodBefore);

    // A rollback to 0.11 ignores the table; deleting the parent cascades it away.
    await client.execute('PRAGMA foreign_keys = ON');
    await client.execute('DELETE FROM services WHERE id = 1');
    expect((await client.execute('SELECT COUNT(*) AS n FROM preview_env_vars')).rows[0]!['n']).toBe(0);
  });
});
