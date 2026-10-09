import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@ninedeploy/db';

/**
 * Multi-node T6, the upgrade proof for panel-host databases (design §5.9,
 * "Equivalence"): what NineDeploy sends to Docker for a database on the panel
 * host (`server_id` NULL) — create/start, stop, restart, logs, size, backup,
 * restore, import, the credential and sandbox probes, the bridge attach and
 * the retained-volume adoption, for every engine — recorded once from the
 * v0.15.0 code into `fixtures/databaseArgv015.json`.
 *
 * engine/database.ts and every module it shells out through (lib/exec,
 * lib/dockerPull, lib/serviceBridge, lib/secretFile, lib/crossProcessLock)
 * are byte-identical between v0.15.0 and the commit the fixture was taken at
 * (only two `export` keywords differ), so the fixture IS v0.15.0's argv.
 *
 *  - `engine`: the engine functions, called directly, still produce it.
 *  - `runtime`: the same operations through `databaseRuntime(db, d)` (the
 *    multi-node dispatch) produce it byte for byte for a panel row.
 *
 * Regenerate (only on purpose): NINEDEPLOY_RECORD_DB_ARGV=1 vitest run test/databaseArgv015.test.ts
 */

const FIXED_UUID = '00000000-0000-4000-8000-000000000000';
const h = vi.hoisted(() => {
  const events: unknown[] = [];
  const state = { running: false, volume: false, labels: {} as Record<string, string> };
  return { events, state, scratch: '' };
});

vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  return { ...orig, default: { ...orig, randomUUID: () => FIXED_UUID }, randomUUID: () => FIXED_UUID };
});
vi.mock('../src/lib/crypto.js', async () => {
  const { PassThrough } = await import('node:stream');
  return {
    decrypt: (v: string) => `pw-${v}`,
    encrypt: (v: string) => `enc-${v}`,
    randomToken: () => 'token',
    createBackupCipher: () => {
      const cipher = new PassThrough() as InstanceType<typeof PassThrough> & { getAuthTag: () => Buffer };
      cipher.getAuthTag = () => Buffer.alloc(16, 7);
      return { cipher, header: Buffer.from('NDBK1:v0:AAAAAAAAAAAAAAAA\n') };
    },
    createBackupDecipher: () => new PassThrough(),
  };
});

/** Strip the scratch directory so the fixture is machine-independent. */
const norm = (v: unknown): unknown => {
  if (typeof v === 'string') return h.scratch ? v.split(h.scratch).join('<scratch>').replace(/\\/g, '/') : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => typeof x !== 'function')
        .map(([k, x]) => [k, norm(x)]),
    );
  }
  return v;
};

function respond(args: string[]): string {
  const s = h.state;
  if (args[0] === 'inspect' && args.includes('{{.State.Status}}')) return s.running ? 'running\n' : 'exited\n';
  if (args[0] === 'inspect') return '{}';
  if (args[0] === 'volume' && args[1] === 'inspect') {
    if (!s.volume) throw new Error('Error: No such volume');
    return args.includes('--format') ? JSON.stringify(s.labels) : '[{"Name":"x"}]';
  }
  if (args[0] === 'logs') return 'l1\nl2\n';
  if (args[0] === 'create') return 'cid0123\n';
  if (args[0] === 'network' && args[1] === 'ls') return '';
  if (args[0] === 'run' && args.includes('--single')) return 'NINEDEPLOY_REKEY_OK\n';
  if (args[0] === 'exec') {
    const tail = args.join(' ');
    if (tail.includes('pg_database_size')) return '4242\n';
    if (tail.includes('INFO memory')) return 'used_memory:777\n';
    if (tail.includes('information_schema.tables')) return '9001\n';
    if (tail.includes('stats().dataSize')) return '31337\n';
    if (tail.includes('SELECT 1')) return '1\n';
    if (tail.includes('ping: 1')) return '1\n';
    if (tail.includes('PING')) return 'PONG\n';
    if (tail.includes('--help')) return '  --sandbox  Disallow commands\n  --system-command  x\n';
  }
  return '';
}

vi.mock('../src/lib/exec.js', () => ({
  run: async (cmd: string, args: string[], opts: Record<string, unknown> = {}, sink?: (line: string) => void) => {
    h.events.push(norm({ fn: 'run', cmd, args, opts }));
    // `docker cp <container>:<path> <host file>` writes the host file.
    if (cmd === 'docker' && args[0] === 'cp' && /^[^/]+:\//.test(args[1] ?? '') && args[2]) writeFileSync(args[2], 'DUMP-BYTES');
    sink?.('');
  },
  capture: async (cmd: string, args: string[], opts: Record<string, unknown> = {}, stdin?: Buffer) => {
    h.events.push(norm({ fn: 'capture', cmd, args, opts, ...(stdin ? { stdin: stdin.toString('utf8') } : {}) }));
    return respond(args);
  },
  sleep: async () => undefined,
}));
vi.mock('../src/lib/dockerPull.js', () => ({
  pullDockerImage: async (image: string) => {
    h.events.push({ fn: 'pullDockerImage', image });
  },
  ensureDockerImage: async (image: string) => {
    h.events.push({ fn: 'ensureDockerImage', image });
  },
}));
vi.mock('../src/lib/secretFile.js', () => ({
  writeSecretFile: (prefix: string, name: string, contents: string) => {
    h.events.push({ fn: 'writeSecretFile', prefix, name, contents });
    return { path: `/tmp/${prefix}-FIXED/${name}`, cleanup: () => h.events.push({ fn: 'secretFile.cleanup' }) };
  },
}));
vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/config.js')>();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-dbargv-'));
  return { ...orig, config: { ...orig.config, paths: { ...orig.config.paths, dataDir: dir, backupsDir: dir } } };
});

const engine = await import('../src/engine/database.js');
const { databaseRuntime } = await import('../src/lib/databaseRuntime.js');
const { config } = await import('../src/config.js');
h.scratch = config.paths.dataDir;
afterAll(() => undefined);

const FIXTURE = new URL('./fixtures/databaseArgv015.json', import.meta.url);
const RECORD = process.env['NINEDEPLOY_RECORD_DB_ARGV'] === '1';

/** A panel-host database row as v0.15.0 writes it. */
function row(engineName: string, version: string | null, extra: Partial<Database> = {}): Database {
  const slug = `${engineName}${version ? `-${version}` : ''}`.replace(/[^a-z0-9-]/g, '');
  return {
    id: 7,
    projectId: 1,
    ownerUserId: 3,
    name: `My ${engineName}`,
    slug,
    engine: engineName,
    version,
    status: 'running',
    containerName: `nd-db-${slug}`,
    internalHost: `nd-db-${slug}`,
    internalPort: null,
    username: null,
    passwordEncrypted: 'secret',
    dbName: null,
    volumeName: `nd-db-${slug}-data`,
    cpuShares: 0,
    cpuLimitMilli: 0,
    memLimitMb: 0,
    webGuiEnabled: false,
    webGuiPort: null,
    extensions: [],
    pgbouncerEnabled: false,
    pgbouncerContainerName: null,
    pgbouncerPort: 6432,
    initializedAt: null,
    serverId: null,
    nodeContainerName: null,
    nodeVolumeName: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  } as Database;
}

/** What one implementation exposes: the engine functions, or the runtime dispatch. */
interface ArgvImpl {
  start(d: Database, log: (l: string) => void, opts?: { labels?: Record<string, string> }): Promise<void>;
  stop(d: Database, log: (l: string) => void): Promise<void>;
  restart(d: Database, log: (l: string) => void): Promise<void>;
  logs(d: Database, lines: number): Promise<string[]>;
  size(d: Database): Promise<number>;
  backup(d: Database, file: string, log: (l: string) => void): Promise<void>;
  restore(d: Database, file: string, log: (l: string) => void): Promise<void>;
  import(d: Database, file: string, plan: import('../src/engine/database.js').DatabaseImportPlan, log: (l: string) => void): Promise<void>;
  probeCredentials(d: Database): Promise<boolean>;
  probeSandbox(d: Database): Promise<string | null>;
  attachBridges(d: Database, slugs: string[], log: (l: string) => void): Promise<void>;
  adopt(d: Database, log: (l: string) => void): Promise<unknown>;
}

const engineImpl: ArgvImpl = {
  start: (d, log, opts) => engine.startDatabase(d, log, opts),
  stop: (d, log) => engine.stopDatabase(d, log),
  restart: (d, log) => engine.restartDatabase(d, log),
  logs: (d, lines) => engine.databaseLogs(d, lines),
  size: (d) => engine.databaseSize(d),
  backup: (d, file, log) => engine.backupDatabase(d, file, log),
  restore: (d, file, log) => engine.restoreDatabase(d, file, log),
  import: (d, file, plan, log) => engine.importDatabase(d, file, plan, log),
  probeCredentials: (d) => engine.probeDatabaseCredentials(d, 2, 0),
  probeSandbox: (d) => engine.probeMysqlSandboxFlag(d),
  attachBridges: (d, slugs, log) => engine.attachDatabaseToServiceBridges(d, slugs, log),
  adopt: (d, log) => engine.adoptRetainedVolume(d, log),
};

/** The multi-node dispatch for a panel row (server_id NULL). The db handle is never touched on that path. */
const NO_DB = new Proxy({}, { get: () => { throw new Error('the panel-host runtime must not read the database'); } }) as never;
const runtimeImpl: ArgvImpl = {
  start: (d, log, opts) => databaseRuntime(NO_DB, d).start(log, opts),
  stop: (d, log) => databaseRuntime(NO_DB, d).stop(log),
  restart: (d, log) => databaseRuntime(NO_DB, d).restart(log),
  logs: (d, lines) => databaseRuntime(NO_DB, d).logs(lines),
  size: (d) => databaseRuntime(NO_DB, d).size(),
  backup: (d, file, log) => databaseRuntime(NO_DB, d).backup(file, log),
  restore: (d, file, log) => databaseRuntime(NO_DB, d).restore(file, log),
  import: (d, file, plan, log) => databaseRuntime(NO_DB, d).import(file, plan, log),
  probeCredentials: (d) => databaseRuntime(NO_DB, d).probeCredentials(2, 0),
  probeSandbox: (d) => databaseRuntime(NO_DB, d).probeMysqlSandboxFlag(),
  attachBridges: (d, slugs, log) => databaseRuntime(NO_DB, d).attachToServiceBridges(slugs, log),
  adopt: (d, log) => databaseRuntime(NO_DB, d).adoptRetainedVolume(log),
};

interface Scenario {
  name: string;
  state?: Partial<typeof h.state>;
  run(impl: ArgvImpl): Promise<unknown>;
}

const ROWS: Database[] = [
  row('postgres', null),
  row('postgres', '16', { cpuShares: 512, cpuLimitMilli: 1500, memLimitMb: 256 }),
  row('postgres', 'vector'),
  row('mysql', null),
  row('mariadb', null, { memLimitMb: 512 }),
  row('redis', null),
  row('valkey', null),
  row('mongo', null),
  row('clickhouse', null),
  row('meilisearch', null),
  row('rabbitmq', null),
];

const IMPORT_PLANS: Record<string, import('../src/engine/database.js').DatabaseImportPlan[]> = {
  postgres: [
    { format: 'pg_custom', clean: true, singleTransaction: true },
    { format: 'pg_plain', singleTransaction: true },
  ],
  mysql: [{ format: 'mysql_sql', sandboxFlag: '--system-command=OFF' }],
  mariadb: [{ format: 'mysql_sql', sandboxFlag: '--sandbox' }, { format: 'mysql_sql', sandboxFlag: null }],
  mongo: [{ format: 'mongo_archive', gzip: true, drop: true }],
  redis: [{ format: 'rdb' }],
  valkey: [{ format: 'rdb' }],
};

const scratchFile = (name: string, contents = 'PLAIN-DUMP\n'): string => {
  const file = path.join(h.scratch, name);
  writeFileSync(file, contents);
  return file;
};

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  const log = () => undefined;
  for (const d of ROWS) {
    const k = `${d.engine}${d.version ? `:${d.version}` : ''}`;
    out.push(
      { name: `${k} start (fresh volume)`, state: { running: false, volume: false }, run: (i) => i.start(d, log) },
      { name: `${k} start (retained volume, template label)`, state: { running: false, volume: true }, run: (i) => i.start(d, log, { labels: { 'ninedeploy.template': 'ghost' } }) },
      { name: `${k} start (already running)`, state: { running: true, volume: true }, run: (i) => i.start(d, log) },
      { name: `${k} stop`, run: (i) => i.stop(d, log) },
      { name: `${k} restart`, run: (i) => i.restart(d, log) },
      { name: `${k} logs`, run: (i) => i.logs(d, 50) },
      { name: `${k} size`, run: (i) => i.size(d) },
      { name: `${k} backup`, run: (i) => i.backup(d, path.join(h.scratch, `${d.slug}-ts.dump`), log) },
      { name: `${k} restore`, run: (i) => i.restore(d, scratchFile(`${d.slug}-restore.dump`), log) },
      { name: `${k} probe credentials`, run: (i) => i.probeCredentials(d) },
      { name: `${k} probe sandbox`, run: (i) => i.probeSandbox(d) },
      { name: `${k} attach to service bridges`, run: (i) => i.attachBridges(d, ['web', 'api'], log) },
      {
        name: `${k} adopt retained volume`,
        state: { volume: true, labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.engine': d.engine, 'ninedeploy.database.image': 'postgres:17' } },
        run: (i) => i.adopt(d, log),
      },
    );
    for (const [n, plan] of (IMPORT_PLANS[d.engine] ?? []).entries()) {
      out.push({ name: `${k} import #${n} ${plan.format}`, run: (i) => i.import(d, scratchFile(`${d.slug}-import-${n}.dump`), plan, log) });
    }
  }
  // The pre-import safety backup runs inside the import's lock.
  const pg = ROWS[0]!;
  out.push({
    name: 'postgres import with the safety backup',
    run: (i) =>
      i.import(pg, scratchFile('pg-safety-import.dump'), {
        format: 'pg_plain',
        singleTransaction: true,
        safetyBackup: {
          file: path.join(h.scratch, 'pg-pre-import.dump'),
          onDone: async () => {
            h.events.push({ fn: 'safetyBackup.onDone' });
          },
          onFailed: async () => {
            h.events.push({ fn: 'safetyBackup.onFailed' });
          },
        },
      }, () => undefined),
  });
  return out;
}

/** Run every scenario against `impl`: per scenario, the Docker calls in order and the outcome. */
async function recordArgv(impl: ArgvImpl): Promise<Record<string, { events: unknown[]; outcome: unknown }>> {
  const out: Record<string, { events: unknown[]; outcome: unknown }> = {};
  for (const s of scenarios()) {
    h.events.length = 0;
    Object.assign(h.state, { running: false, volume: false, labels: {} }, s.state ?? {});
    let outcome: unknown;
    try {
      outcome = { ok: norm((await s.run(impl)) ?? null) };
    } catch (err) {
      outcome = { error: err instanceof Error ? err.message : String(err) };
    }
    out[s.name] = { events: [...h.events], outcome };
  }
  return out;
}

beforeEach(() => {
  h.events.length = 0;
});

describe('v0.15.0 database argv fixture (panel host)', () => {
  it('the engine functions send exactly the recorded v0.15.0 argv', async () => {
    const got = await recordArgv(engineImpl);
    if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as typeof got;
    expect(Object.keys(got)).toEqual(Object.keys(fixture));
    for (const name of Object.keys(fixture)) expect(got[name], name).toEqual(fixture[name]);
  });

  it('a panel-host row (server_id NULL) through databaseRuntime sends byte-identical argv (the upgrade proof)', async () => {
    const got = await recordArgv(runtimeImpl);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as typeof got;
    expect(Object.keys(got)).toEqual(Object.keys(fixture));
    for (const name of Object.keys(fixture)) expect(got[name], name).toEqual(fixture[name]);
  });

  it('a row written by 0.15 and read after migration 0072 takes the panel path with the same argv', async () => {
    const { migrate } = await import('drizzle-orm/libsql/migrator');
    const { createDb, runMigrations } = await import('@ninedeploy/db');
    const { migrationsThrough, MIGRATIONS_FOLDER } = await import('./fixtures/migrationsThrough.js');
    const { db, client } = createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder: migrationsThrough('0071_operations_api', h.scratch) });
    await client!.execute(`INSERT INTO users (id, email, password_hash) VALUES (3, 'o@example.com', 'x')`);
    await client!.execute(
      `INSERT INTO databases (id, owner_user_id, name, slug, engine, status, container_name, volume_name, internal_host, password_encrypted)
       VALUES (7, 3, 'My postgres', 'postgres', 'postgres', 'running', 'nd-db-postgres', 'nd-db-postgres-data', 'nd-db-postgres', 'secret')`,
    );
    await runMigrations(db, MIGRATIONS_FOLDER);
    const migrated = (await db.query.databases.findFirst())!;
    expect(migrated).toMatchObject({ serverId: null, nodeContainerName: null, nodeVolumeName: null });
    const runtime = databaseRuntime(db, migrated);
    expect(runtime.where).toBe('panel');
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, { events: unknown[] }>;
    const log = () => undefined;
    for (const [name, op, state] of [
      ['postgres start (fresh volume)', () => runtime.start(log), { running: false, volume: false }],
      ['postgres stop', () => runtime.stop(log), {}],
      ['postgres backup', () => runtime.backup(path.join(h.scratch, 'postgres-ts.dump'), log), {}],
      ['postgres size', () => runtime.size(), {}],
    ] as const) {
      h.events.length = 0;
      Object.assign(h.state, { running: false, volume: false, labels: {} }, state);
      await op();
      expect(h.events, name).toEqual(fixture[name]!.events);
    }
    client!.close();
  });

  it('covers every engine and operation (the fixture is not trivially empty)', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, { events: Array<{ fn: string; args?: string[] }> }>;
    expect(Object.keys(fixture).length).toBeGreaterThan(140);
    const runs = Object.values(fixture).flatMap((s) => s.events).filter((e) => e.fn === 'run' && e.args?.[0] === 'run');
    expect(runs.length).toBeGreaterThanOrEqual(ROWS.length * 2);
    expect(fixture['redis start (fresh volume)']!.events).toContainEqual(
      expect.objectContaining({ fn: 'run', args: expect.arrayContaining(['redis:8.8', '--requirepass', 'pw-secret']) }),
    );
  });
});
