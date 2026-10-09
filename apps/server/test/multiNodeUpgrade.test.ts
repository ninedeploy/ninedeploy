/**
 * Multi-node upgrade compatibility for migration 0072 (`multi_node`).
 *
 * A self-updating panel applies 0072 to a populated 0.15 database. The
 * migration adds one table (image_transfers), nullable or defaulted columns
 * on six existing tables, and indexes — no rebuild, no row rewrite. Every
 * existing row must read back exactly as 0.15 left it, every default must
 * reproduce 0.15's behaviour, and a rollback to 0.15 must boot (design §8):
 *   1. apply every migration through 0071 to a scratch SQLite and seed it the
 *      way 0.15 writes (raw SQL against the 0.15 columns): a panel database
 *      with backups, an attachment and a policy; a node service with a fan-out
 *      target; a PAT source; a build config; a `swarm_stacks` row;
 *   2. apply 0072 with the server's own migrator;
 *   3. every pre-existing column and row is byte-identical, every untouched
 *      table's DDL is identical and an altered table's DDL only gained
 *      trailing columns; the new columns read as NULL or their defaults;
 *   4. the 0072 SQL holds only CREATE TABLE, CREATE INDEX and ALTER TABLE …
 *      ADD with a nullable or defaulted column;
 *   5. the 0.15 migrator (a journal without 0072) applies nothing to the
 *      migrated database and does not throw;
 *   6. 0.15's drizzle schema (test/fixtures/schema015.ts) reads every row,
 *      and its typed reads never return the new columns (D6) — so a node
 *      database row reads on 0.15 with NULL local names (the §5.8 marker);
 *   7. with the defaults, the refusal baseline is 0.15's and the T1 hooks
 *      answer "as before";
 *   8. the declared FK actions: a server hosting a database cannot be deleted.
 * No new column is encrypted and no new settings key is secret, so key
 * rotation is unchanged (design §8).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, databases, imageTransfers, runMigrations, servers, services, sources } from '@ninedeploy/db';
import { effectiveBuildOn, effectiveOrchestrator } from '@ninedeploy/schemas';
import { schema015 } from './fixtures/schema015.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-0072-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);
vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));

const { encrypt, decrypt } = await import('../src/lib/crypto.js');
const { remoteDatabaseRefusal, remoteServiceRefusal, STATIC_CREDENTIAL_REFUSAL } = await import('../src/lib/remoteDeploy.js');
const { resolveBuildPlacement } = await import('../src/engine/buildPlacement.js');
const { isSwarmService } = await import('../src/engine/swarmDeploy.js');
const { serverDeleteBlockers } = await import('../src/lib/serverDependents.js');

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TAG = '0072_multi_node';
const NEW_TABLES = ['image_transfers'];
/** Every column 0072 adds, with the value a pre-0072 row reads (SQL storage form). */
const NEW_COLUMNS: Record<string, Record<string, unknown>> = {
  databases: { server_id: null, node_container_name: null, node_volume_name: null },
  services: { build_on: null, build_server_id: null, push_registry_source_id: null, push_repository: null, orchestrator: null },
  servers: {
    agent_version: null,
    agent_caps: null,
    agent_checked_at: null,
    is_build_server: 0,
    build_concurrency: 1,
    swarm_node_id: null,
    swarm_role: null,
  },
  sources: { allow_on_nodes: 0 },
  backups: { server_id: null },
  deployments: { build_host: null, image_id: null },
};
const NEW_INDEXES = [
  'databases_server_idx',
  'image_transfers_deployment_idx',
  'image_transfers_service_started_idx',
  'image_transfers_started_idx',
  'services_build_server_idx',
];

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

/** A copy of the migrations folder whose journal stops at 0071 — what 0.15 ships. */
function folderBefore0072(): string {
  const dir = path.join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  expect(at).toBeGreaterThan(0);
  expect(journal.entries[at]!.idx).toBe(72);
  expect(journal.entries[at - 1]!.tag).toBe('0071_operations_api');
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const PAT = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A 0.15 database: an operator, a workspace with a project, two nodes, a PAT
 * source and a registry source, a panel-host service with a build config and
 * deployments, a node service (PAT-cloned) with a fan-out target and an
 * attached panel database, that database's backups and policy, a volume
 * backup, a `swarm_stacks` row, and a terminal session.
 */
async function populated015(): Promise<{ db: DB; client: Client }> {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderBefore0072() });
  for (const t of NEW_TABLES) {
    expect((await client!.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, args: [t] })).rows).toHaveLength(0);
  }
  const c = client!;
  await c.execute(`INSERT INTO users (id, email, password_hash, name, is_instance_operator) VALUES (1, 'op@example.com', 'x', 'Op', 1)`);
  await c.execute(`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (1, 'Team', 'team', 1)`);
  await c.execute(`INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (1, 1, 1, 'owner')`);
  await c.execute(`INSERT INTO projects (id, workspace_id, name, slug) VALUES (1, 1, 'shop', 'shop')`);
  await c.execute({
    sql: `INSERT INTO servers (id, name, host, port, status, token_encrypted, last_seen_at) VALUES (1, 'node-1', '10.0.0.5', 4600, 'online', ?, 1791000000), (2, 'node-2', '10.0.0.6', 4600, 'offline', ?, NULL)`,
    args: [encrypt('agent-token-1'), encrypt('agent-token-2')],
  });
  await c.execute({
    sql: `INSERT INTO sources (id, type, name, token_encrypted, default_branch) VALUES (1, 'github', 'gh-pat', ?, 'main')`,
    args: [encrypt(PAT)],
  });
  await c.execute({
    sql: `INSERT INTO sources (id, type, name, token_encrypted, registry_username) VALUES (2, 'registry', 'ghcr', ?, 'bot')`,
    args: [encrypt('registry-pass')],
  });
  // #1 panel-host image service; #2 node-1 service cloned with the PAT, fanned out to node-2.
  await c.execute(
    `INSERT INTO services (id, owner_user_id, name, slug, type, image, port, status, runtime_id)
     VALUES (1, 1, 'web', 'web', 'docker', 'nginx:alpine', 80, 'running', 'nd-app-web')`,
  );
  await c.execute(
    `INSERT INTO services (id, owner_user_id, name, slug, type, repo_url, branch, commit_sha, source_id, port, status, runtime_id, server_id, cmd, replicas)
     VALUES (2, 1, 'api', 'api', 'docker', 'https://github.com/acme/api.git', 'main', 'abc1234def', 1, 3000, 'running', 'api-7', 1, NULL, 2)`,
  );
  await c.execute(`INSERT INTO service_workspaces (service_id, workspace_id) VALUES (1, 1), (2, 1)`);
  await c.execute(`INSERT INTO service_projects (service_id, project_id) VALUES (1, 1), (2, 1)`);
  await c.execute(`INSERT INTO service_targets (id, service_id, server_id, runtime_id, status) VALUES (1, 2, 2, 'api-t2-7', 'running')`);
  await c.execute(
    `INSERT INTO build_configs (id, service_id, build_pack, base_dir, dockerfile_path, restart_policy) VALUES (1, 2, 'dockerfile', '/', 'Dockerfile', 'unless-stopped')`,
  );
  await c.execute(
    `INSERT INTO deployments (id, service_id, status, commit_sha, image_digest, trigger, config_snapshot, started_at, finished_at)
     VALUES (6, 2, 'superseded', 'abc0000aaa', NULL, 'webhook', '{"buildPack":"dockerfile"}', 1790000000, 1790000100),
            (7, 2, 'running', 'abc1234def', NULL, 'user', '{"buildPack":"dockerfile"}', 1791000000, 1791000200),
            (8, 1, 'running', NULL, 'sha256:${'a'.repeat(64)}', 'user', NULL, 1791000300, 1791000400)`,
  );
  await c.execute({
    sql: `INSERT INTO databases (id, project_id, owner_user_id, name, slug, engine, version, status, container_name, internal_host, internal_port, username, password_encrypted, db_name, volume_name, initialized_at)
          VALUES (1, 1, 1, 'app', 'app', 'postgres', '16', 'running', 'nd-db-app', 'nd-db-app', 5432, 'app', ?, 'app', 'nd-db-app-data', 1790000000)`,
    args: [encrypt('pg-secret')],
  });
  await c.execute(`INSERT INTO database_attachments (id, service_id, database_id, env_alias) VALUES (1, 2, 1, 'DATABASE')`);
  await c.execute(`INSERT INTO database_backup_policies (database_id, enabled, cron, retain_count) VALUES (1, 1, '0 4 * * *', 14)`);
  await c.execute(
    `INSERT INTO backups (id, database_id, scope, status, path, size_bytes) VALUES (1, 1, 'scheduled', 'completed', '/data/backups/app-1.dump', 2048), (2, 1, 'db', 'failed', '/data/backups/app-2.dump', 0)`,
  );
  await c.execute(
    `INSERT INTO backups (id, volume_name, label, scope, status, path, size_bytes) VALUES (3, 'nd-svc-web-data', 'manual', 'volumes', 'completed', '/data/backups/vol-3.tar.gz', 4096)`,
  );
  await c.execute(`INSERT INTO swarm_stacks (id, name, state_json) VALUES (1, 'legacy', '{"services":[]}')`);
  await c.execute(
    `INSERT INTO terminal_sessions (id, user_id, target_kind, service_id, server_id, target_label, status) VALUES (1, 1, 'service', 2, 1, 'api', 'ended')`,
  );
  await c.execute(`INSERT INTO settings (key, value) VALUES ('panel_domain', '"panel.example.com"'), ('terminal_retention_days', '180')`);
  await c.execute(`INSERT INTO audit_log (user_id, action, entity) VALUES (1, 'server.register', 'node-1')`);
  return { db, client: c };
}

type Snapshot = { ddl: Map<string, string>; columns: Map<string, string[]>; rows: Map<string, string[]> };

/** DDL of every object, plus every table's columns and rows (canonically sorted). */
async function snapshot(client: Client, exclude: string[] = []): Promise<Snapshot> {
  const objects = (await client.execute(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name`)).rows;
  const out: Snapshot = { ddl: new Map(), columns: new Map(), rows: new Map() };
  for (const o of objects) {
    if (exclude.includes(String(o['tbl_name']))) continue;
    out.ddl.set(String(o['name']), String(o['sql']));
    if (o['type'] !== 'table') continue;
    const name = String(o['name']);
    const cols = (await client.execute(`PRAGMA table_info("${name}")`)).rows.map((r) => String(r['name']));
    out.columns.set(name, cols);
    out.rows.set(name, (await client.execute(`SELECT * FROM "${name}"`)).rows.map((r) => JSON.stringify(r)).sort());
  }
  return out;
}

/** The rows of `table`, projected onto `cols`, canonically sorted. */
async function rowsOn(client: Client, table: string, cols: string[]): Promise<string[]> {
  const list = cols.map((c) => `"${c}"`).join(', ');
  return (await client.execute(`SELECT ${list} FROM "${table}"`)).rows.map((r) => JSON.stringify(r)).sort();
}

describe('migration 0072 upgrade compatibility', () => {
  it('is journal idx 72 with a snapshot chained to 0071', () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === TAG)!;
    const prior = journal.entries.find((e) => e.tag === '0071_operations_api')!;
    expect(entry.idx).toBe(72);
    expect(entry.when).toBeGreaterThan(prior.when);
    expect(journal.entries.at(-1)!.tag).toBe(TAG);
    const snap = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '0072_snapshot.json'), 'utf8')) as {
      prevId: string;
      tables: Record<string, { columns: Record<string, { notNull: boolean; default?: unknown }> }>;
    };
    const prev = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '0071_snapshot.json'), 'utf8')) as {
      id: string;
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    expect(snap.prevId).toBe(prev.id);
    expect(Object.keys(snap.tables).filter((t) => !(t in prev.tables)).sort()).toEqual(NEW_TABLES);
    // The snapshot records exactly the columns this test expects, each nullable or defaulted.
    for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
      const added = Object.keys(snap.tables[table]!.columns).filter((c) => !(c in prev.tables[table]!.columns));
      expect(added.sort(), table).toEqual(Object.keys(cols).sort());
      for (const c of added) {
        const col = snap.tables[table]!.columns[c]!;
        expect(!col.notNull || col.default !== undefined, `${table}.${c}`).toBe(true);
      }
    }
  });

  it('is purely additive: CREATE TABLE, CREATE INDEX and ALTER TABLE … ADD of a nullable or defaulted column', () => {
    const raw = readFileSync(path.join(migrationsFolder, `${TAG}.sql`), 'utf8');
    const sqlText = raw.replace(/^\s*--(?!>).*$/gm, '');
    expect(sqlText).not.toMatch(/__new_|\bDROP\b|\bRENAME\b|INSERT INTO|^\s*UPDATE |DELETE FROM|PRAGMA|TRIGGER|\bCHECK\b/im);
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    const added: string[] = [];
    for (const s of statements) {
      expect(s, s).toMatch(
        /^(CREATE TABLE `[a-z_]+` \(|CREATE (UNIQUE )?INDEX `[a-z0-9_]+` ON `[a-z_]+` \([`a-z0-9_,]+\);?$|ALTER TABLE `[a-z_]+` ADD `[a-z0-9_]+` (integer|text)\b[^;]*;?$)/,
      );
      const add = /^ALTER TABLE `([a-z_]+)` ADD `([a-z0-9_]+)` (.*?);?$/.exec(s);
      if (!add) continue;
      added.push(`${add[1]}.${add[2]}`);
      // A NOT NULL column needs a DEFAULT, or SQLite would refuse it on a populated table.
      if (/NOT NULL/.test(add[3]!)) expect(add[3], s).toMatch(/\bDEFAULT\b/);
    }
    expect(added.sort()).toEqual(
      Object.entries(NEW_COLUMNS)
        .flatMap(([t, cols]) => Object.keys(cols).map((c) => `${t}.${c}`))
        .sort(),
    );
    const created = statements.filter((s) => s.startsWith('CREATE TABLE')).map((s) => /^CREATE TABLE `([a-z_]+)`/.exec(s)![1]);
    expect(created).toEqual(NEW_TABLES);
    const indexes = statements.filter((s) => s.includes(' INDEX ')).map((s) => /INDEX `([a-z0-9_]+)`/.exec(s)![1]);
    expect(indexes.sort()).toEqual(NEW_INDEXES);
    // r300: the hand-written ON DELETE rules drizzle-kit drops from ADD … REFERENCES.
    expect(raw).toMatch(/ALTER TABLE `backups` ADD `server_id` integer REFERENCES servers\(id\) ON UPDATE no action ON DELETE set null;/);
    expect(raw).toMatch(/ALTER TABLE `services` ADD `build_server_id` integer REFERENCES servers\(id\) ON UPDATE no action ON DELETE set null;/);
    expect(raw).toMatch(/ALTER TABLE `services` ADD `push_registry_source_id` integer REFERENCES sources\(id\) ON UPDATE no action ON DELETE set null;/);
    // databases.server_id keeps NO ACTION: a server hosting a database cannot be deleted.
    expect(raw).toMatch(/ALTER TABLE `databases` ADD `server_id` integer REFERENCES servers\(id\);/);
  });

  it('leaves every 0.15 row byte-identical, only appends columns to the altered tables, and reads the new columns as NULL or their defaults', async () => {
    const { db, client } = await populated015();
    const before = await snapshot(client, ['__drizzle_migrations']);

    await runMigrations(db, migrationsFolder);

    const after = await snapshot(client, ['__drizzle_migrations', ...NEW_TABLES]);
    // DDL: untouched objects identical. SQLite splices an added column's
    // definition, verbatim, in after the last column; removing exactly the
    // 0072 definitions must give back the 0.15 DDL byte for byte.
    const defs = [
      ...readFileSync(path.join(migrationsFolder, `${TAG}.sql`), 'utf8').matchAll(/^ALTER TABLE `([a-z_]+)` ADD (`[^;]+);/gm),
    ].map((m) => ({ table: m[1]!, def: m[2]! }));
    expect(defs).toHaveLength(Object.values(NEW_COLUMNS).flatMap((c) => Object.keys(c)).length);
    for (const [name, ddl] of before.ddl) {
      const now = after.ddl.get(name);
      expect(now, name).toBeDefined();
      let stripped = now!;
      for (const { def } of defs.filter((d) => d.table === name)) {
        expect(stripped, `${name}: ${def}`).toContain(`, ${def}`);
        stripped = stripped.replace(`, ${def}`, '');
      }
      expect(stripped, name).toBe(ddl);
    }
    expect([...after.ddl.keys()].filter((k) => !before.ddl.has(k)).sort()).toEqual(
      NEW_INDEXES.filter((i) => !i.startsWith('image_transfers')).sort(),
    );
    // Rows: every pre-existing column of every table, byte-identical.
    for (const [table, cols] of before.columns) {
      expect(await rowsOn(client, table, cols), table).toEqual(before.rows.get(table));
      const added = after.columns.get(table)!.filter((c) => !cols.includes(c));
      expect(added.sort(), table).toEqual(Object.keys(NEW_COLUMNS[table] ?? {}).sort());
    }
    // New columns: NULL or the default that reproduces 0.15, on every row.
    for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
      const rows = (await client.execute(`SELECT ${Object.keys(cols).join(', ')} FROM ${table}`)).rows;
      expect(rows.length, table).toBeGreaterThan(0);
      for (const r of rows) expect({ ...r }, table).toEqual(cols);
    }
    for (const t of NEW_TABLES) {
      expect((await client.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!['n'], t).toBe(0);
    }
    // No multi-node settings key appears: every feature is off by absence.
    const keys = (await client.execute(`SELECT key FROM settings WHERE key LIKE 'swarm_%' OR key LIKE 'image_transfer_%'`)).rows;
    expect(keys).toEqual([]);

    // Through today's schema: the 0.15 rows, secrets intact, defaults typed.
    const pg = await db.query.databases.findFirst({ where: eq(databases.id, 1) });
    expect(pg).toMatchObject({ slug: 'app', containerName: 'nd-db-app', volumeName: 'nd-db-app-data', serverId: null, nodeContainerName: null });
    expect(decrypt(pg!.passwordEncrypted)).toBe('pg-secret');
    const node = await db.query.servers.findFirst({ where: eq(servers.id, 1) });
    expect(node).toMatchObject({ isBuildServer: false, buildConcurrency: 1, agentCaps: null, swarmRole: null });
    const src = await db.query.sources.findFirst({ where: eq(sources.id, 1) });
    expect(src!.allowOnNodes).toBe(false);
    expect(decrypt(src!.tokenEncrypted!)).toBe(PAT);
    for (const svc of await db.select().from(services)) {
      expect(effectiveBuildOn(svc.buildOn)).toBe('target');
      expect(effectiveOrchestrator(svc.orchestrator)).toBe('container');
    }
  });

  it('with the defaults, the 0.15 refusals and the T1 hooks behave exactly as before', async () => {
    const { db } = await populated015();
    await runMigrations(db, migrationsFolder);
    const api = (await db.query.services.findFirst({ where: eq(services.id, 2) }))!;
    const web = (await db.query.services.findFirst({ where: eq(services.id, 1) }))!;

    // r268: allow_on_nodes = 0 keeps the static-credential refusal word for word.
    const probe = vi.fn();
    expect(await remoteServiceRefusal(db, api, { probe })).toBe(STATIC_CREDENTIAL_REFUSAL);
    expect(probe).not.toHaveBeenCalled();
    // r229: the panel database attached to the node service is still refused, same text.
    expect(await remoteDatabaseRefusal(db, api)).toBe(
      'Deployments to a remote server are not available for a service with an attached managed database: the database runs on the panel host and its hostname does not resolve on the node. Detach it (use an external database URL) or clear the target server.',
    );
    expect(await remoteDatabaseRefusal(db, web)).toBeNull();
    expect(await remoteServiceRefusal(db, web)).toBeNull();

    // The T1 hooks: build where it runs, plain containers, nothing blocks a delete.
    expect(await resolveBuildPlacement(db, api)).toEqual({ kind: 'target' });
    expect(isSwarmService(api)).toBe(false);
    expect(await serverDeleteBlockers(db, 1)).toEqual([]);
  });

  it('the 0.15 migrator (journal without 0072) applies nothing to a migrated database and does not throw', async () => {
    const { db, client } = await populated015();
    await runMigrations(db, migrationsFolder);
    // A 0.16 panel then wrote multi-node rows.
    await db.update(servers).set({ isBuildServer: true, agentVersion: '0.16.0', agentCaps: ['stream'] }).where(eq(servers.id, 1));
    await db.update(sources).set({ allowOnNodes: true }).where(eq(sources.id, 1));
    await db.insert(imageTransfers).values({ serviceId: 2, deploymentId: 7, method: 'stream', imageRef: 'ninedeploy/api:abc1234-b7', targetServerId: 2 });
    const before = await snapshot(client);
    const journalRows = (await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')).rows[0]!['n'];

    await expect(runMigrations(db, folderBefore0072())).resolves.toBeTypeOf('string');

    expect((await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')).rows[0]!['n']).toBe(journalRows);
    expect(await snapshot(client)).toEqual(before);
  });

  it("0.15's schema reads every migrated row, never sees the new columns, and reads a node database with NULL local names (§5.8 marker, D6)", async () => {
    const { db, client } = await populated015();
    await runMigrations(db, migrationsFolder);
    await client.execute('PRAGMA foreign_keys = ON');
    // A 0.16 panel placed a database on node-1: the rollback marker.
    await db.insert(databases).values({
      name: 'cache',
      slug: 'cache',
      engine: 'redis',
      status: 'running',
      containerName: null,
      volumeName: null,
      internalHost: 'nd-db-cache',
      internalPort: 6379,
      passwordEncrypted: encrypt('redis-secret'),
      serverId: 1,
      nodeContainerName: 'nd-db-cache',
      nodeVolumeName: 'nd-db-cache-data',
    });

    const db015 = drizzle(client, { schema: schema015 });
    for (const table of Object.values(schema015)) {
      const rows = await db015.select().from(table);
      expect(rows.length).toBeGreaterThan(0);
    }
    const all = await db015.query.databases.findMany();
    expect(all).toHaveLength(2);
    const cache = await db015.query.databases.findFirst({ where: eq(schema015.databases.slug, 'cache') });
    // 0.15 sees an ordinary row whose local names are NULL — every 0.15 local
    // action refuses it ("no container/volume name", "not runnable").
    expect(cache).toMatchObject({ containerName: null, volumeName: null, status: 'running', internalHost: 'nd-db-cache' });
    // D6: drizzle selects declared columns only — 0.15 never reads server_id.
    expect(cache).not.toHaveProperty('serverId');
    expect(Object.keys(cache!)).not.toContain('server_id');
    expect(Object.keys(cache!).some((k) => /^node/.test(k))).toBe(false);
    const src = await db015.query.sources.findFirst();
    expect(src).not.toHaveProperty('allowOnNodes');
    const svc = await db015.query.services.findFirst({ where: eq(schema015.services.id, 2) });
    expect(svc).toMatchObject({ serverId: 1, sourceId: 1, replicas: 2 });
    expect(svc).not.toHaveProperty('buildOn');
    expect(svc).not.toHaveProperty('orchestrator');
  });

  it('declares the FK actions: a server hosting a database cannot be deleted; roles, backups and transfers detach or cascade', async () => {
    const { db, client } = await populated015();
    await runMigrations(db, migrationsFolder);
    await client.execute('PRAGMA foreign_keys = ON');

    await db.insert(databases).values({ name: 'n', slug: 'n', engine: 'postgres', passwordEncrypted: encrypt('p'), serverId: 2, nodeContainerName: 'nd-db-n' });
    await db.update(services).set({ buildOn: 'server', buildServerId: 2, pushRegistrySourceId: 2, pushRepository: 'acme/web' }).where(eq(services.id, 1));
    await client.execute('UPDATE backups SET server_id = 2 WHERE id = 3');
    const [t1] = await db
      .insert(imageTransfers)
      .values({ serviceId: 2, deploymentId: 7, sourceServerId: null, targetServerId: 2, method: 'stream', imageRef: 'ninedeploy/api:abc1234-b7' })
      .returning();
    expect(t1).toMatchObject({ status: 'running', bytes: 0, imageId: null, sha256: null, error: null, finishedAt: null, durationMs: null });
    expect(t1!.startedAt).toBeInstanceOf(Date);

    // NO ACTION: deleting node-2 fails while it hosts a database (design §5.2).
    await client.execute('DELETE FROM service_targets WHERE server_id = 2');
    await expect(client.execute('DELETE FROM servers WHERE id = 2')).rejects.toThrow(/FOREIGN KEY/);
    expect((await client.execute('SELECT COUNT(*) AS n FROM servers WHERE id = 2')).rows[0]!['n']).toBe(1);

    // Once the database is gone, the delete goes through and SET NULL detaches the rest.
    await client.execute(`DELETE FROM databases WHERE slug = 'n'`);
    await client.execute('DELETE FROM servers WHERE id = 2');
    const web = (await db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    expect(web).toMatchObject({ buildOn: 'server', buildServerId: null, pushRegistrySourceId: 2 });
    expect((await client.execute('SELECT server_id FROM backups WHERE id = 3')).rows[0]!['server_id']).toBeNull();
    // A transfer row keeps its target server as a snapshot (no FK).
    expect((await db.query.imageTransfers.findFirst({ where: eq(imageTransfers.id, t1!.id) }))!.targetServerId).toBe(2);

    // A deleted registry source detaches the push target.
    await client.execute('DELETE FROM sources WHERE id = 2');
    expect((await db.query.services.findFirst({ where: eq(services.id, 1) }))!.pushRegistrySourceId).toBeNull();

    // A pruned deployment detaches its transfers; a deleted service takes them.
    await client.execute('DELETE FROM deployments WHERE id = 7');
    expect((await db.query.imageTransfers.findFirst({ where: eq(imageTransfers.id, t1!.id) }))!.deploymentId).toBeNull();
    await client.execute('DELETE FROM terminal_sessions');
    await client.execute('DELETE FROM database_attachments');
    await client.execute('DELETE FROM services WHERE id = 2');
    expect((await client.execute('SELECT COUNT(*) AS n FROM image_transfers')).rows[0]!['n']).toBe(0);
  });
});
