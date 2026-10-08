/**
 * 0.15 upgrade compatibility for migration 0071 (`operations_api`).
 *
 * A self-updating panel applies 0071 to a populated 0.14 database. The
 * migration only creates three tables (terminal_sessions, traffic_rollups,
 * access_grants) and their indexes; every existing row must read back exactly
 * as 0.14 left it, and a rollback to 0.14 must boot:
 *   1. apply every migration through 0070 to a scratch SQLite and seed it the
 *      way 0.14 writes (raw SQL against the 0.14 columns, 0.14 tables included),
 *   2. apply 0071 with the server's own migrator,
 *   3. assert every pre-existing table (rows and DDL) is byte-identical and the
 *      three new tables are empty — so every permission, the Traefik config
 *      and every terminal default are 0.14's (no grant, no rollup, no session),
 *   4. assert the 0071 SQL is only CREATE TABLE / CREATE [UNIQUE] INDEX,
 *   5. exercise the declared defaults, uniques and FK actions of the new tables,
 *   6. run the 0.14 migrator (a journal without 0071) against the migrated
 *      database: it applies nothing and does not throw.
 * No new column is encrypted and no new settings key is secret, so key
 * rotation is unchanged (DESIGN §5).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { accessGrants, createDb, type DB, runMigrations, terminalSessions, trafficRollups } from '@ninedeploy/db';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-0071-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);
vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));

const { encrypt, decrypt } = await import('../src/lib/crypto.js');

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TAG = '0071_operations_api';
const NEW_TABLES = ['access_grants', 'terminal_sessions', 'traffic_rollups'];

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

/** A copy of the migrations folder whose journal stops at 0070 — what 0.14 ships. */
function folderBefore0071(): string {
  const dir = path.join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  expect(at).toBeGreaterThan(0);
  expect(journal.entries[at]!.idx).toBe(71);
  expect(journal.entries[at - 1]!.tag).toBe('0070_network_data_access');
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/**
 * A 0.14 database: an operator and a seated member, a workspace with a project
 * and an environment, a service tagged into both with a domain, a node, a
 * postgres database with public access on, a secret provider, and the
 * instance settings 0.14 writes (none of the 0.15 keys).
 */
async function populated014(): Promise<{ db: DB; client: Client }> {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderBefore0071() });
  for (const t of NEW_TABLES) {
    expect((await client!.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, args: [t] })).rows).toHaveLength(0);
  }
  const c = client!;
  await c.execute(`INSERT INTO users (id, email, password_hash, name, is_instance_operator) VALUES (1, 'op@example.com', 'x', 'Op', 1)`);
  await c.execute(`INSERT INTO users (id, email, password_hash, name) VALUES (2, 'dev@example.com', 'x', 'Dev')`);
  await c.execute(`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (1, 'Team', 'team', 1)`);
  await c.execute(`INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (1, 1, 1, 'owner'), (2, 1, 2, 'viewer')`);
  await c.execute(`INSERT INTO projects (id, workspace_id, name, slug) VALUES (1, 1, 'shop', 'shop')`);
  await c.execute(`INSERT INTO environments (id, workspace_id, name, slug) VALUES (1, 1, 'production', 'production')`);
  await c.execute({
    sql: `INSERT INTO servers (id, name, host, port, status, token_encrypted) VALUES (1, 'node-1', '10.0.0.5', 4600, 'online', ?)`,
    args: [encrypt('agent-token')],
  });
  await c.execute(
    `INSERT INTO services (id, owner_user_id, name, slug, type, image, port, status, runtime_id, environment_id, server_id)
     VALUES (1, 1, 'web', 'web', 'docker', 'nginx:alpine', 80, 'running', 'nd-app-web', 1, NULL)`,
  );
  await c.execute(`INSERT INTO service_workspaces (service_id, workspace_id) VALUES (1, 1)`);
  await c.execute(`INSERT INTO service_projects (service_id, project_id) VALUES (1, 1)`);
  await c.execute(`INSERT INTO domains (id, service_id, hostname, status) VALUES (1, 1, 'shop.example.com', 'active')`);
  await c.execute({
    sql: `INSERT INTO databases (id, project_id, owner_user_id, name, slug, engine, version, status, container_name, password_encrypted)
          VALUES (1, 1, 1, 'app', 'app', 'postgres', '16', 'running', 'nd-db-app', ?)`,
    args: [encrypt('pg-secret')],
  });
  await c.execute(
    `INSERT INTO database_public_access (database_id, enabled, public_port, ip_allowlist) VALUES (1, 1, 15432, '["203.0.113.0/24"]')`,
  );
  await c.execute({ sql: `INSERT INTO secret_providers (id, kind, credential_encrypted) VALUES (1, 'vault', ?)`, args: [encrypt('{"token":"t"}')] });
  await c.execute(`INSERT INTO settings (key, value) VALUES ('panel_domain', '"panel.example.com"'), ('acme_email', '"ops@example.com"')`);
  await c.execute(`INSERT INTO audit_log (user_id, action, entity) VALUES (1, 'service.exec', 'service:1')`);
  return { db, client: c };
}

/** Every user table (rows sorted canonically) plus the DDL of every object, keyed by name. */
async function snapshot(client: Client, exclude: string[] = []): Promise<Record<string, unknown>> {
  const objects = (await client.execute(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name`)).rows.map((r) => ({
    type: r['type'],
    name: r['name'],
    tbl: r['tbl_name'],
    sql: r['sql'],
  }));
  const out: Record<string, unknown> = {};
  for (const o of objects) {
    if (exclude.includes(String(o.tbl))) continue;
    out[`ddl:${String(o.name)}`] = o.sql;
    if (o.type === 'table') {
      const rows = (await client.execute(`SELECT * FROM "${String(o.name)}"`)).rows.map((r) => JSON.stringify(r));
      out[`rows:${String(o.name)}`] = rows.sort();
    }
  }
  return out;
}

describe('migration 0071 upgrade compatibility', () => {
  it('is journal idx 71 with a snapshot chained to 0070', () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === TAG)!;
    const prior = journal.entries.find((e) => e.tag === '0070_network_data_access')!;
    expect(entry.idx).toBe(71);
    expect(entry.when).toBeGreaterThan(prior.when);
    const snap = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '0071_snapshot.json'), 'utf8')) as {
      prevId: string;
      tables: Record<string, unknown>;
    };
    const prev = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '0070_snapshot.json'), 'utf8')) as {
      id: string;
      tables: Record<string, unknown>;
    };
    expect(snap.prevId).toBe(prev.id);
    expect(Object.keys(snap.tables).filter((t) => !(t in prev.tables)).sort()).toEqual(NEW_TABLES);
  });

  it('is purely additive: three CREATE TABLEs and their indexes, nothing else', () => {
    const sqlText = readFileSync(path.join(migrationsFolder, `${TAG}.sql`), 'utf8');
    expect(sqlText).not.toMatch(/__new_|\bDROP\b|\bRENAME\b|\bALTER\b|INSERT INTO|^\s*UPDATE |DELETE FROM|PRAGMA|TRIGGER|\bCHECK\b/im);
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) {
      expect(s, s).toMatch(/^(CREATE TABLE `[a-z_]+` \(|CREATE (UNIQUE )?INDEX `[a-z0-9_]+` ON `[a-z_]+` \([`a-z0-9_,]+\);?$)/);
    }
    const created = statements.filter((s) => s.startsWith('CREATE TABLE')).map((s) => /^CREATE TABLE `([a-z_]+)`/.exec(s)![1]);
    expect(created.sort()).toEqual(NEW_TABLES);
    for (const s of statements.filter((x) => x.includes(' INDEX '))) {
      expect(NEW_TABLES).toContain(/ ON `([a-z_]+)`/.exec(s)![1]);
    }
    expect(statements.filter((s) => s.startsWith('CREATE UNIQUE INDEX'))).toHaveLength(3);
  });

  it('leaves every 0.14 table byte-identical (rows and DDL) and creates the new tables empty', async () => {
    const { db, client } = await populated014();
    const before = await snapshot(client, ['__drizzle_migrations']);

    await runMigrations(db, migrationsFolder);

    const after = await snapshot(client, ['__drizzle_migrations', ...NEW_TABLES]);
    expect(after).toEqual(before);
    for (const t of NEW_TABLES) {
      expect((await client.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!['n'], t).toBe(0);
    }
    // No 0.15 settings key appears: host shells off and analytics off by absence (O1, O3).
    const keys = (await client.execute(`SELECT key FROM settings WHERE key LIKE 'terminal_%' OR key LIKE 'traffic_%'`)).rows;
    expect(keys).toEqual([]);
    // The 0.14 rows still read through the 0.15 schema, secrets intact.
    const pg = await db.query.databases.findFirst({ where: (d, { eq: e }) => e(d.id, 1) });
    expect(pg).toMatchObject({ slug: 'app', engine: 'postgres', status: 'running', projectId: 1 });
    expect(decrypt(pg!.passwordEncrypted)).toBe('pg-secret');
    const member = await db.query.workspaceMembers.findFirst({ where: (m, { eq: e }) => e(m.userId, 2) });
    expect(member!.role).toBe('viewer');
  });

  it('accepts rows with the declared defaults, enforces the uniques and cascades / nulls like the schema says', async () => {
    const { db, client } = await populated014();
    await runMigrations(db, migrationsFolder);
    await client.execute('PRAGMA foreign_keys = ON');

    // terminal_sessions: pending by default, counters at zero, many NULL tickets allowed.
    const [ts1] = await db
      .insert(terminalSessions)
      .values({ userId: 1, targetKind: 'service', serviceId: 1, serverId: 1, containerName: 'nd-app-web', targetLabel: 'web', ticketHash: 'h1' })
      .returning();
    expect(ts1).toMatchObject({
      status: 'pending',
      bytesIn: 0,
      bytesOut: 0,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      endReason: null,
      exitCode: null,
      authKind: null,
      terminatedByUserId: null,
    });
    expect(ts1!.createdAt).toBeInstanceOf(Date);
    await expect(db.insert(terminalSessions).values({ targetKind: 'host', targetLabel: 'panel host', ticketHash: 'h1' })).rejects.toThrow();
    await db.insert(terminalSessions).values({ targetKind: 'host', targetLabel: 'panel host', ticketHash: null });
    await db.insert(terminalSessions).values({ targetKind: 'database', databaseId: 1, targetLabel: 'app', ticketHash: null });

    // traffic_rollups: counters and histogram default; one row per (granularity, bucket, scope).
    const [roll] = await db.insert(trafficRollups).values({ granularity: 60, bucketStart: 1_791_000_000, scopeKey: 'd:1', domainId: 1, serviceId: 1 }).returning();
    expect(roll).toMatchObject({ requests: 0, status2xx: 0, statusOther: 0, bytesOut: 0, durationSumMs: 0, durationMaxMs: 0, latencyHist: [], host: null });
    await expect(db.insert(trafficRollups).values({ granularity: 60, bucketStart: 1_791_000_000, scopeKey: 'd:1' })).rejects.toThrow();
    await db.insert(trafficRollups).values({ granularity: 3600, bucketStart: 1_791_000_000, scopeKey: 'd:1' });

    // access_grants: unique per (user, target_key); suspended_at null by default.
    const [grant] = await db
      .insert(accessGrants)
      .values({ workspaceId: 1, userId: 2, projectId: 1, targetKey: 'p:1', role: 'member', createdByUserId: 1 })
      .returning();
    expect(grant).toMatchObject({ environmentId: null, suspendedAt: null, createdByUserId: 1 });
    expect(grant!.updatedAt).toBeInstanceOf(Date);
    await expect(db.insert(accessGrants).values({ workspaceId: 1, userId: 2, projectId: 1, targetKey: 'p:1', role: 'admin' })).rejects.toThrow();
    await db.insert(accessGrants).values({ workspaceId: 1, userId: 2, environmentId: 1, targetKey: 'e:1', role: 'viewer' });
    await db.insert(accessGrants).values({ workspaceId: 1, userId: 2, projectId: 1, environmentId: 1, targetKey: 'pe:1:1', role: 'admin' });

    // SET NULL: deleting the service, database or node keeps session history.
    await client.execute('DELETE FROM domains WHERE id = 1');
    await client.execute('DELETE FROM service_workspaces');
    await client.execute('DELETE FROM service_projects');
    await client.execute('DELETE FROM services WHERE id = 1');
    await client.execute('DELETE FROM database_public_access');
    await client.execute('DELETE FROM databases WHERE id = 1');
    await client.execute('DELETE FROM servers WHERE id = 1');
    const kept = await db.query.terminalSessions.findFirst({ where: eq(terminalSessions.id, ts1!.id) });
    expect(kept).toMatchObject({ serviceId: null, serverId: null, targetLabel: 'web', containerName: 'nd-app-web' });
    // No FK on rollups: the domain is gone, its history stays until retention.
    expect((await client.execute('SELECT COUNT(*) AS n FROM traffic_rollups WHERE domain_id = 1')).rows[0]!['n']).toBe(1);

    // CASCADE: a deleted environment takes its grants; a deleted project the rest.
    await client.execute('DELETE FROM environments WHERE id = 1');
    expect((await client.execute('SELECT target_key FROM access_grants ORDER BY target_key')).rows.map((r) => r['target_key'])).toEqual(['p:1']);
    await client.execute('DELETE FROM projects WHERE id = 1');
    expect((await client.execute('SELECT COUNT(*) AS n FROM access_grants')).rows[0]!['n']).toBe(0);

    // A deleted user: their sessions keep the row, with the user nulled.
    await client.execute('DELETE FROM workspace_members WHERE user_id = 1');
    await client.execute('UPDATE workspaces SET owner_id = 2 WHERE id = 1');
    await client.execute('DELETE FROM audit_log');
    await client.execute('DELETE FROM users WHERE id = 1');
    expect((await db.query.terminalSessions.findFirst({ where: eq(terminalSessions.id, ts1!.id) }))!.userId).toBeNull();
    // A deleted workspace cascades its grants.
    await db.insert(accessGrants).values({ workspaceId: 1, userId: 2, targetKey: 'p:77', role: 'viewer' });
    await client.execute('DELETE FROM workspace_members WHERE workspace_id = 1');
    await client.execute('DELETE FROM workspaces WHERE id = 1');
    expect((await client.execute('SELECT COUNT(*) AS n FROM access_grants')).rows[0]!['n']).toBe(0);
  });

  it('the 0.14 migrator (journal without 0071) applies nothing to a 0.15 database and does not throw', async () => {
    const { db, client } = await populated014();
    await runMigrations(db, migrationsFolder);
    await db.insert(terminalSessions).values({ userId: 1, targetKind: 'host', targetLabel: 'panel host', status: 'ended', endReason: 'shell_exited' });
    await db.insert(accessGrants).values({ workspaceId: 1, userId: 2, projectId: 1, targetKey: 'p:1', role: 'member' });
    const before = await snapshot(client);
    const journalRows = (await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')).rows[0]!['n'];

    await expect(runMigrations(db, folderBefore0071())).resolves.toBeTypeOf('string');

    expect((await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')).rows[0]!['n']).toBe(journalRows);
    expect(await snapshot(client)).toEqual(before);
    // The 0.15 rows are simply left alone for a later re-upgrade; 0.14 never reads them,
    // so the grant has no effect there (rollback fails closed: a loss of access, never a gain).
    expect((await db.query.accessGrants.findFirst())!.role).toBe('member');
  });
});
