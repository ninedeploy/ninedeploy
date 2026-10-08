/**
 * Retention guard (0.15, DESIGN §5): every table added from 0.15 on must be
 * either swept by a named housekeeping step or declared bounded configuration.
 *
 * Retention here is per table and hand-maintained (`plugins/housekeeping.ts`),
 * and nothing failed when a new event table shipped without a sweep — the
 * "unbounded tables" defect class. This reads the table list from the real
 * migration chain, diffs it against the frozen v0.14.0 list, and requires an
 * entry in `RETENTION` for every table outside it:
 *   - `swept: <step>` — the step must exist in housekeeping.ts;
 *   - `config: <reason>` — bounded by something other than time.
 *
 * Tables that predate 0.15 are out of scope (extending this to them is
 * deferred, DESIGN §9).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ninedeploy/db';

type Retention = { swept: string } | { config: string };

/** Every table added from 0.15 on, and how it stays bounded. */
const RETENTION: Record<string, Retention> = {
  // 0.15 (migration 0071)
  terminal_sessions: { swept: 'terminal-sessions' },
  traffic_rollups: { swept: 'traffic-rollups' },
  access_grants: { config: 'bounded by users × projects/environments; rows cascade with their user, workspace, project and environment' },
};

/** The tables of v0.14.0 (migrations through 0070), frozen. */
const FROZEN_014_TABLES = [
  'alert_rules', 'alert_state', 'api_tokens', 'audit_log', 'backup_destinations', 'backup_drills', 'backups',
  'build_configs', 'cache_registry_blobs', 'config_entries', 'database_attachments', 'database_backup_policies',
  'database_imports', 'database_public_access', 'databases', 'deployments', 'domain_transfers', 'domains',
  'email_template_overrides', 'env_vars', 'environments', 'github_app_installations', 'github_apps',
  'github_pr_comments', 'installed_plugins', 'job_runs', 'labels', 'log_drains', 'metrics', 'notification_channels',
  'notification_log', 'oauth_identities', 'oidc_providers', 'password_reset_tokens', 'preview_env_vars', 'projects',
  'repo_insights', 'scheduled_jobs', 'scim_tokens', 'secret_providers', 'servers', 'service_github_links',
  'service_labels', 'service_notification_channels', 'service_projects', 'service_targets',
  'service_volume_attachments', 'service_workspaces', 'services', 'sessions', 'settings', 'sources', 'sso_providers',
  'swarm_stacks', 'tls_certificates', 'tunnels', 'users', 'webauthn_credentials', 'webhooks', 'workspace_invitations',
  'workspace_members', 'workspaces',
] as const;

const LAST_014_TAG = '0070_network_data_access';
const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-retention-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The migrations folder with its journal cut after `tag` (inclusive), or whole. */
function folderThrough(tag?: string): string {
  if (!tag) return migrationsFolder;
  const dir = path.join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  expect(at).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function tablesAfter(tag?: string): Promise<string[]> {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderThrough(tag) });
  const rows = await client!.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`,
  );
  client!.close();
  return rows.rows.map((r) => String(r['name']));
}

/** Tables outside the frozen 0.14 list that have no RETENTION entry. */
function uncoveredTables(tables: string[], retention: Record<string, Retention>): string[] {
  const frozen = new Set<string>(FROZEN_014_TABLES);
  return tables.filter((t) => !frozen.has(t) && !(t in retention));
}

const housekeepingSteps = (): Set<string> => {
  const src = readFileSync(new URL('../src/plugins/housekeeping.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return new Set([...src.matchAll(/\bstep\('([a-z0-9-]+)'/g)].map((m) => m[1]!));
};

describe('retention coverage for tables added from 0.15 on', () => {
  it('the frozen list is exactly what migrations through 0070 create', async () => {
    expect(await tablesAfter(LAST_014_TAG)).toEqual([...FROZEN_014_TABLES].sort());
  });

  it('every table outside the frozen 0.14 list has a RETENTION entry', async () => {
    expect(uncoveredTables(await tablesAfter(), RETENTION), 'add a housekeeping step, or a `config:` reason').toEqual([]);
  });

  it('every RETENTION entry names a table the migrations create (no stale entries)', async () => {
    const tables = new Set(await tablesAfter());
    expect(Object.keys(RETENTION).filter((t) => !tables.has(t))).toEqual([]);
    expect(Object.keys(RETENTION).filter((t) => (FROZEN_014_TABLES as readonly string[]).includes(t))).toEqual([]);
  });

  it('every `swept:` step is a real housekeeping step', () => {
    const steps = housekeepingSteps();
    // Non-vacuous: the scan finds the long-standing steps too.
    expect(steps.has('audit-log')).toBe(true);
    for (const [table, rule] of Object.entries(RETENTION)) {
      if ('swept' in rule) expect(steps.has(rule.swept), `${table} → step('${rule.swept}')`).toBe(true);
      else expect(rule.config.length, table).toBeGreaterThan(10);
    }
  });

  it('flags a new table with no entry (keeps the check non-vacuous)', () => {
    expect(uncoveredTables(['users', 'terminal_sessions', 'shiny_events'], RETENTION)).toEqual(['shiny_events']);
  });
});
