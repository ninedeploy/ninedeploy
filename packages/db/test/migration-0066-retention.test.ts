import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/index.js';

const migrationsFolder = fileURLToPath(new URL('../src/migrations', import.meta.url));
const TAG = '0066_retention_indexes_project_env_orphans';

/**
 * 0066 upgrades an existing install: it deletes the env vars of projects that
 * no longer exist (r541) and adds the timestamp indexes the hourly
 * housekeeping deletes filter on (r545). Both are checked on a populated 0065
 * database, the state a self-updating server is in.
 */
const scratch = mkdtempSync(join(tmpdir(), 'nd-0066-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function folderBefore0066(): string {
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

async function at0065() {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderBefore0066() });
  return { db, client: client! };
}

async function envRows(client: Client): Promise<string[]> {
  const rows = (await client.execute('SELECT scope, scope_key, key FROM env_vars ORDER BY id')).rows;
  return rows.map((r) => `${String(r['scope'])}:${String(r['scope_key'])}:${String(r['key'])}`);
}

describe('migration 0066', () => {
  it('r541: deletes project-scoped env vars whose project is gone, and nothing else', async () => {
    const { db, client } = await at0065();
    await client.execute(`INSERT INTO projects (id, name, slug) VALUES (1, 'Live', 'live')`);
    await client.execute(`INSERT INTO services (id, name, slug) VALUES (7, 'api', 'api')`);
    await client.execute(`INSERT INTO env_vars (scope, scope_key, key, value_encrypted) VALUES ('project', 1, 'KEEP', 'v0:a')`);
    await client.execute(`INSERT INTO env_vars (scope, scope_key, key, value_encrypted) VALUES ('project', 2, 'ORPHAN', 'v0:b')`);
    await client.execute(`INSERT INTO env_vars (scope, scope_key, key, value_encrypted) VALUES ('project', 3, 'SECRET', 'v0:c')`);
    // A service-scoped row whose scope_key is not a project id is not an orphan.
    await client.execute(
      `INSERT INTO env_vars (service_id, scope, scope_key, key, value_encrypted) VALUES (7, 'service', 7, 'PORT', 'v0:d')`,
    );

    await migrate(db, { migrationsFolder });

    expect(await envRows(client)).toEqual(['project:1:KEEP', 'service:7:PORT']);
  });

  it('r545: the housekeeping deletes are served by an index, not a table scan', async () => {
    const { db, client } = await at0065();
    await migrate(db, { migrationsFolder });

    // The WHERE clauses `plugins/housekeeping.ts` runs every hour.
    const sweeps: Array<[string, string]> = [
      ['DELETE FROM audit_log WHERE ts < 1', 'audit_log_ts_idx'],
      ['DELETE FROM notification_log WHERE ts < 1', 'notification_log_ts_idx'],
      ['DELETE FROM job_runs WHERE created_at < 1', 'job_runs_created_idx'],
      [`SELECT id FROM deployments WHERE created_at < 1 AND status NOT IN ('running')`, 'deployments_created_idx'],
      ['DELETE FROM sessions WHERE expires_at < 1 OR revoked_at < 1', 'sessions_expires_idx'],
      ['DELETE FROM sessions WHERE expires_at < 1 OR revoked_at < 1', 'sessions_revoked_idx'],
    ];
    for (const [query, index] of sweeps) {
      const plan = (await client.execute(`EXPLAIN QUERY PLAN ${query}`)).rows.map((r) => String(r['detail'])).join(' | ');
      expect(plan, query).toContain(index);
    }
  });

  it('re-running its statements is harmless (IF NOT EXISTS)', async () => {
    const { db, client } = await at0065();
    await migrate(db, { migrationsFolder });
    const body = readFileSync(join(migrationsFolder, `${TAG}.sql`), 'utf8');
    for (const stmt of body.split('--> statement-breakpoint')) await client.execute(stmt);
  });
});
