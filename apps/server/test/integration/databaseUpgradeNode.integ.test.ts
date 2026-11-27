/**
 * N12, integration: a major upgrade of a NODE database on real Docker.
 *
 * The agent's own code runs in this process — its typed ops through `runOp`
 * (agent.ts), its dump and restore kinds through their handlers
 * (agentOps/databases.ts) — so everything between the journal
 * (lib/databaseUpgrade.ts) and Docker is the real thing: the label binding,
 * the helpers with no network, the statement catalogue, the copier, the clean
 * stop. Only the sealed transport is replaced (by a function call); it has
 * its own tests.
 *
 * What the work item asks to be proved, per engine: identical data on the
 * clean target, the stored credentials work and a wrong password does not,
 * the rollback, and a crash in the middle (the panel "dies" at the copy, the
 * boot recovery finishes it on real containers).
 *
 * Like the other files here: excluded from the default run, gated on
 * RUN_INTEGRATION=1 + Docker.
 */
import { createWriteStream, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, createDb, type Database, databases, databaseUpgrades, type DB, runMigrations, servers, users } from '@ninedeploy/db';
import type { NodeUpgradeAgent } from '../../src/lib/nodeDatabaseUpgrade.js';
import type { NodeDatabaseDeps } from '../../src/lib/nodeDatabase.js';

const ENABLED = process.env.RUN_INTEGRATION === '1';
// Generated per run (test-only, never reused) so no credential is hardcoded.
const PASSWORD = `integ-${process.pid}-${Math.random().toString(36).slice(2)}`;
const READER_PASSWORD = `reader-${process.pid}-${Math.random().toString(36).slice(2)}`;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-node-upgrade-'));
mkdirSync(path.join(tmp, 'backups'), { recursive: true });
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { config: { ...actual.config, paths: { ...actual.config.paths, backupsDir: path.join(tmp, 'backups'), dataDir: tmp } } };
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { runOp } = await import('../../src/agent.js');
const { dbDumpKind, dbRestoreKind } = await import('../../src/agentOps/databases.js');
const { capture } = await import('../../src/lib/exec.js');
const { ENGINES, createBackupReadStream } = await import('../../src/engine/database.js');
const { admitUpgrade, clusterFingerprint, databaseUpgradeDeps, finalizeDatabaseUpgrade, planUpgrade, recoverInterruptedUpgrades, rollbackDatabaseUpgrade, runDatabaseUpgrade } = await import('../../src/lib/databaseUpgrade.js');
const { nodeDatabaseUpgradeDeps } = await import('../../src/lib/nodeDatabaseUpgrade.js');
const { nodeDatabaseRuntime } = await import('../../src/lib/nodeDatabase.js');
const { encrypt: encryptSecret } = await import('../../src/lib/crypto.js');

/** The node's agent, in this process: every op is the agent's own `runOp`, sealed. */
const baseAgent: NodeUpgradeAgent = async (op, params, sink) => {
  const lines: string[] = [];
  const exitCode = await runOp(op, params, (line) => { lines.push(line); sink(line); }, { sealed: true });
  return { exitCode, lines };
};

/** The sealed stream channel, in this process: the panel's side calls the agent's kinds directly. */
const openStream: NonNullable<NodeDatabaseDeps['openStream']> = async (_db, _serverId, kind, params) => {
  if (kind === 'db.dump') {
    const prepared = await dbDumpKind.prepare(params);
    if (prepared.direction !== 'agent-to-panel') throw new Error('db.dump answered the wrong direction');
    const source = await prepared.start();
    return { kind, direction: 'agent-to-panel', readable: source.stream, done: source.done.then((result) => ({ bytes: 0, sha256: '', result })), abort: () => source.abort() };
  }
  const prepared = await dbRestoreKind.prepare(params);
  if (prepared.direction !== 'panel-to-agent') throw new Error('db.restore answered the wrong direction');
  const file = path.join(tmp, `restore-${Math.random().toString(36).slice(2)}.dump`);
  const writable: Writable = createWriteStream(file);
  const done = new Promise<{ bytes: number; sha256: string; result: Record<string, unknown> }>((resolve, reject) => {
    writable.once('error', reject);
    writable.once('finish', () => {
      prepared.apply(file).then((result) => resolve({ bytes: 0, sha256: '', result }), reject);
    });
  });
  // Whoever awaits `done` sees the rejection; nobody listening is no crash.
  done.catch(() => undefined);
  return { kind, direction: 'panel-to-agent', writable, done, abort: () => writable.destroy() };
};

const noCap = { assertCapable: async () => undefined, assertHost: async () => undefined };
const depsFor = (row: Database, agent: NodeUpgradeAgent = baseAgent) =>
  nodeDatabaseUpgradeDeps(db, row, { agent, openStream, ...noCap, pollMs: 1_000 });

let db: DB;
let nextId = 30;
const slugs: string[] = [];
const log = () => undefined;

async function seedRow(engine: 'mysql' | 'postgres', slug: string, version: string): Promise<Database> {
  slugs.push(slug);
  const id = nextId++;
  await db.insert(databases).values({
    id, ownerUserId: 1, name: slug, slug, engine, status: 'stopped', version, serverId: 3,
    containerName: null, volumeName: null, internalHost: `nd-db-${slug}`, passwordEncrypted: encryptSecret(PASSWORD), username: engine === 'postgres' ? 'nine' : 'root', dbName: 'app',
  } as never);
  return (await db.query.databases.findFirst({ where: eq(databases.id, id) }))!;
}
const rowOf = (id: number) => db.query.databases.findFirst({ where: eq(databases.id, id) });

/** The panel "dies" when the agent is asked for `action`: that call and everything after it never reach Docker. */
function crashing(action: string) {
  let dead = false;
  let armed = true;
  const agent: NodeUpgradeAgent = async (op, params, sink) => {
    if (dead) throw new Error('SIMULATED CRASH: the panel is gone');
    if (armed && op === 'db.upgrade' && params['action'] === action) {
      armed = false;
      dead = true;
      throw new Error('SIMULATED CRASH');
    }
    return baseAgent(op, params, sink);
  };
  return { agent, revive: () => { dead = false; } };
}

async function until(what: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
const exists = async (kind: 'container' | 'volume' | 'network', name: string): Promise<boolean> =>
  capture('docker', kind === 'container' ? ['inspect', name] : kind === 'volume' ? ['volume', 'inspect', name] : ['network', 'inspect', name]).then(() => true, () => false);

/** From the host, as an operator would: a statement in the database container (tab-separated, no header). */
// Over TCP: the image's entrypoint first runs a temporary server on the socket only, so the socket answers before the real server is up.
const mysql = (container: string, sql: string, user = 'root', password = PASSWORD): Promise<string> =>
  capture('docker', ['exec', '-e', `MYSQL_PWD=${password}`, container, 'mysql', '-h127.0.0.1', `-u${user}`, '-N', '-B', '-e', sql]);
const psql = (container: string, sql: string): Promise<string> => capture('docker', ['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'nine', '-d', 'app', '-At', '-F', '\t', '-c', sql]);
/** From the container's own address, so the password is what logs in (the image trusts the socket and 127.0.0.1). */
const psqlTcp = (container: string, sql: string, password: string): Promise<string> =>
  capture('docker', ['exec', '-e', `PGPASSWORD=${password}`, container, 'sh', '-c', 'psql -h "$(hostname -i | cut -d" " -f1)" -U nine -d app -At -c "$1"', 'sh', sql]);

// `GROUP_CONCAT` is cut at 1024 characters by default: the fingerprint must cover every row.
const MYSQL_FINGERPRINT = "SET SESSION group_concat_max_len = 1000000; SELECT COUNT(*), COALESCE(SUM(qty), 0), MD5(GROUP_CONCAT(CONCAT(id, ':', item, ':', qty) ORDER BY id SEPARATOR ';')) FROM app.orders";
const PG_FINGERPRINT = "SELECT count(*), coalesce(sum(qty), 0), md5(string_agg(id || ':' || item || ':' || qty, ',' ORDER BY id)) FROM orders";

interface Scenario {
  engine: 'mysql' | 'postgres';
  slug: string;
  from: string;
  to: string;
  seed: (container: string) => Promise<string>;
  fingerprint: (container: string) => Promise<string>;
  credentials: (container: string) => Promise<void>;
  /** What the server reports after the upgrade (`SELECT VERSION()` / `server_version`). */
  version: (container: string) => Promise<string>;
}

/** One MySQL scenario per slug: a volume carries its row's id, which is what the agent binds an upgrade to. */
const mysqlScenario = (slug: string): Scenario => ({
  engine: 'mysql', slug, from: '8.0', to: '8.4',
  seed: async (container) => {
    await mysql(container, 'CREATE TABLE app.orders (id INT AUTO_INCREMENT PRIMARY KEY, item VARCHAR(50) NOT NULL, qty INT NOT NULL) ENGINE=InnoDB');
    await mysql(container, "INSERT INTO app.orders (item, qty) WITH RECURSIVE n AS (SELECT 1 AS x UNION ALL SELECT x + 1 FROM n WHERE x < 500) SELECT CONCAT('item', x), x * 3 FROM n");
    // An account besides root: it must survive the upgrade with its password and its grant.
    await mysql(container, `CREATE USER 'reader'@'%' IDENTIFIED BY '${READER_PASSWORD}'; GRANT SELECT ON app.* TO 'reader'@'%'; FLUSH PRIVILEGES`);
    return mysql(container, MYSQL_FINGERPRINT);
  },
  fingerprint: (container) => mysql(container, MYSQL_FINGERPRINT),
  credentials: async (container) => {
    expect((await mysql(container, 'SELECT COUNT(*) FROM app.orders', 'reader', READER_PASSWORD)).trim()).toBe('500');
    await expect(mysql(container, 'SELECT 1', 'reader', 'not-the-password')).rejects.toThrow();
    await expect(mysql(container, 'SELECT 1', 'root', 'not-the-password')).rejects.toThrow();
  },
  version: (container) => mysql(container, 'SELECT VERSION()'),
});

const pgScenario: Scenario = {
  engine: 'postgres', slug: 'it-pg', from: '16', to: '17',
  seed: async (container) => {
    await psql(container, 'CREATE TABLE orders (id serial PRIMARY KEY, item text NOT NULL, qty int NOT NULL)');
    await psql(container, "INSERT INTO orders (item, qty) SELECT 'item' || g, g * 3 FROM generate_series(1, 500) g");
    return psql(container, PG_FINGERPRINT);
  },
  fingerprint: (container) => psql(container, PG_FINGERPRINT),
  credentials: async (container) => {
    expect((await psqlTcp(container, 'SELECT COUNT(*) FROM orders', PASSWORD)).trim()).toBe('500');
    await expect(psqlTcp(container, 'SELECT 1', 'not-the-password')).rejects.toThrow();
  },
  version: (container) => psql(container, 'SHOW server_version'),
};

const scenarios: Scenario[] = [mysqlScenario('it-mysql'), pgScenario];

async function cleanup(slug: string) {
  for (const name of [`nd-db-${slug}`, `nd-db-upg-${slug}-old`, `nd-db-upg-${slug}-new`, `nd-db-upg-${slug}-copy`]) {
    await capture('docker', ['rm', '-f', name]).catch(() => undefined);
  }
  await capture('docker', ['network', 'rm', `nd-dbnet-${slug}`]).catch(() => undefined);
  const volumes = (await capture('docker', ['volume', 'ls', '--format', '{{.Name}}']).catch(() => '')).split('\n').map((l) => l.trim()).filter((l) => l === `nd-db-${slug}-data` || l.startsWith(`nd-db-${slug}-data-u`));
  for (const volume of volumes) await capture('docker', ['volume', 'rm', '-f', volume]).catch(() => undefined);
}

describe.skipIf(!ENABLED)('major upgrade of a node database (real Docker, the agent in this process)', () => {
  beforeAll(async () => {
    ({ db } = createDb({ url: ':memory:' }));
    await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
    await db.insert(users).values({ id: 1, email: 'owner@example.com', passwordHash: 'x' });
    await db.insert(servers).values({ id: 3, name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encryptSecret('t'), status: 'online' } as never);
    // Pulled once, before the clock of a test runs.
    for (const image of ['mysql:8.0', 'mysql:8.4', 'postgres:16', 'postgres:17']) await capture('docker', ['pull', image]);
  }, 900_000);

  afterAll(async () => {
    for (const slug of slugs) await cleanup(slug);
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows may still hold a closed libsql file briefly */
    }
  }, 300_000);

  /** Start the row as a node does, seed it, and prove the live server is the `from` series. */
  async function bringUp(scenario: Scenario): Promise<{ row: Database; before: string }> {
    const row = await seedRow(scenario.engine, scenario.slug, scenario.from);
    await nodeDatabaseRuntime(db, row, { agent: (op, params, opts) => baseAgent(op, params, () => undefined, opts), ...noCap }).start(log);
    // The start route records `running`; the runtime itself does not write the row.
    await db.update(databases).set({ status: 'running' }).where(eq(databases.id, row.id));
    const container = `nd-db-${scenario.slug}`;
    await until(`${scenario.engine} accepts connections`, () => scenario.version(container).then((v) => v.trim().startsWith(scenario.from)), 180_000);
    const before = (await scenario.seed(container)).trim();
    // 500 rows whose `qty` is three times their number: 3 × (500 × 501 / 2) = 375 750.
    expect(before).toMatch(/^500\t375750\t[0-9a-f]{32}$/);
    return { row: (await rowOf(row.id))!, before };
  }

  for (const scenario of scenarios) {
    it(`${scenario.engine}: ${scenario.from} → ${scenario.to}, then rollback and finalize`, async () => {
      const { row, before } = await bringUp(scenario);
      const container = `nd-db-${scenario.slug}`;
      if (scenario.engine === 'postgres') {
        // The panel host's own way of running the catalogue's statements, on this real cluster. Until N12 the count of indexes read a column that does not exist, and every PostgreSQL upgrade stopped there.
        const fingerprint = await clusterFingerprint(databaseUpgradeDeps, container);
        expect(fingerprint.rows).toEqual({ 'public.orders': '500' });
        expect(fingerprint.sequences).toEqual({ 'public.orders_id_seq': '500' });
        expect(fingerprint.objects).toMatchObject({ indexes: 1, constraints: 1, views: 0, triggers: 0, functions: 0, extensions: 'plpgsql' });
      }
      const deps = depsFor(row);
      const plan = await planUpgrade(db, row, scenario.to, deps);
      expect(plan).toMatchObject({ fromSeries: scenario.from, toSeries: scenario.to, steps: [scenario.to] });
      const admitted = await admitUpgrade(db, row, plan, 1);
      await runDatabaseUpgrade(db, admitted.id, { actorId: 1, fromImageTag: admitted.fromImageTag }, deps);
      const up = (await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, admitted.id) })!)!;
      expect(up.status, up.error ?? '').toBe('completed');
      expect(up.switched).toBe(true);
      expect(JSON.parse(up.verification!)).toMatchObject({ tables: 1, rows: 500, mismatches: [] });

      // The row, switched in its own column; the container keeps its name; it runs the new image on the new volume.
      const target = `nd-db-${scenario.slug}-data-u${admitted.id}`;
      expect(await rowOf(row.id)).toMatchObject({ status: 'running', version: scenario.to, nodeVolumeName: target, containerName: null, volumeName: null });
      expect((await capture('docker', ['inspect', container, '--format', '{{.Config.Image}}|{{range .Mounts}}{{.Name}}{{end}}'])).trim()).toBe(`${ENGINES[scenario.engine]!.image(scenario.to)}|${target}`);
      expect((await scenario.version(container)).trim()).toMatch(new RegExp(`^${scenario.to}\\.`));

      // Identical data on the clean target; the stored credentials work, a wrong password does not.
      expect((await scenario.fingerprint(container)).trim()).toBe(before);
      await scenario.credentials(container);

      // The helpers are gone; the old volume stays until the upgrade is finalized; the safety dump is on the panel host.
      for (const helper of ['old', 'new', 'copy']) expect(await exists('container', `nd-db-upg-${scenario.slug}-${helper}`)).toBe(false);
      expect(await exists('volume', `nd-db-${scenario.slug}-data`)).toBe(true);
      const safety = (await db.query.backups.findFirst({ where: eq(backups.id, up.safetyBackupId!) }))!;
      expect(safety).toMatchObject({ label: 'pre-upgrade', status: 'completed' });
      const dump = (await (await createBackupReadStream(safety.path!)).toArray()).toString('utf8');
      expect(dump).toContain('orders');

      // Rollback: the untouched old volume, the old series, the same data.
      await rollbackDatabaseUpgrade(db, up, 1, deps);
      expect(await rowOf(row.id)).toMatchObject({ status: 'running', version: scenario.from, nodeVolumeName: `nd-db-${scenario.slug}-data` });
      expect((await scenario.version(container)).trim()).toMatch(new RegExp(`^${scenario.from}\\.`));
      expect((await scenario.fingerprint(container)).trim()).toBe(before);
      // Finalize: the upgraded volume goes, on the node.
      expect(await finalizeDatabaseUpgrade(db, (await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, admitted.id) })!)!, 1, deps)).toEqual({ removedVolume: target });
      expect(await exists('volume', target)).toBe(false);
      expect(await exists('volume', `nd-db-${scenario.slug}-data`)).toBe(true);
    }, 900_000);
  }

  it('a crash in the middle: the boot recovery on real containers', async () => {
    const scenario = mysqlScenario('it-crash');
    const { row, before } = await bringUp(scenario);
    const container = `nd-db-${scenario.slug}`;
    // The panel dies as it asks for the fence's clean stop: the fence is still up on the old volume, and nothing after that reaches Docker.
    const crash = crashing('stop');
    const deps = depsFor(row, crash.agent);
    const admitted = await admitUpgrade(db, row, await planUpgrade(db, row, scenario.to, deps), 1);
    await runDatabaseUpgrade(db, admitted.id, { actorId: 1, fromImageTag: admitted.fromImageTag }, deps);
    expect(await exists('container', `nd-db-upg-${scenario.slug}-old`)).toBe(true);
    expect(await exists('container', container)).toBe(false);
    expect(await exists('volume', `nd-db-${scenario.slug}-data-u${admitted.id}`)).toBe(false);
    // The row as a crash leaves it: still `running`, in the dump phase (the failure handler of this test's run wrote `failed`; a dead panel writes nothing).
    await db.update(databaseUpgrades).set({ status: 'running', error: null, phase: 'dump', switched: false, completedAt: null }).where(eq(databaseUpgrades.id, admitted.id));
    crash.revive();

    const trace: string[] = [];
    const tracing: NodeUpgradeAgent = async (op, params, sink, opts) => {
      trace.push(op === 'db.upgrade' ? `db.upgrade:${String(params['action'])}` : op);
      return baseAgent(op, params, sink, opts);
    };
    expect(await recoverInterruptedUpgrades(db, depsFor(row, tracing))).toBe(1);
    const up = (await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, admitted.id) })!)!;
    expect(up).toMatchObject({ status: 'failed', switched: false });
    expect(up.error).toBe('interrupted by a panel restart; the database was started on its previous volume');
    // The fence went by name BEFORE anything started on the old volume, and that is where the old server runs now, with the same data.
    expect(trace.indexOf('db.upgrade:remove')).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('db.upgrade:remove')).toBeLessThan(trace.indexOf('docker.runSpec'));
    for (const helper of ['old', 'new', 'copy']) expect(await exists('container', `nd-db-upg-${scenario.slug}-${helper}`)).toBe(false);
    expect(await rowOf(row.id)).toMatchObject({ status: 'running', version: scenario.from, nodeVolumeName: `nd-db-${scenario.slug}-data` });
    await until('the old server accepts connections again', () => scenario.version(container).then((v) => v.trim().startsWith(scenario.from)), 180_000);
    expect((await scenario.fingerprint(container)).trim()).toBe(before);
  }, 900_000);
});
