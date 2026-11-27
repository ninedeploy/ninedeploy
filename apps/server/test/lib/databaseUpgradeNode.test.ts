import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backups, createDb, type Database, databases, databaseUpgrades, type DB, runMigrations, servers, users } from '@ninedeploy/db';

/**
 * N12: the major upgrade journal (lib/databaseUpgrade.ts) for a database on a
 * NODE. Real migrated SQLite; the real node deps (lib/nodeDatabaseUpgrade.ts)
 * and the real node runtime; only the agent is a fake, and it is asked for
 * `db.upgrade` actions and statements BY NAME — an op that would carry SQL
 * text has nowhere to go here. The panel host's own Docker throws in this
 * file: nothing about a node row may touch it.
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-node-upgrade-'));
mkdirSync(path.join(tmp, 'backups'), { recursive: true });
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows may still hold a closed libsql file briefly */
  }
});

const h = vi.hoisted(() => ({
  /** What the fake node was asked, in order, in words a reader can check. */
  trace: [] as string[],
  ops: [] as Array<{ op: string; params: Record<string, unknown> }>,
  containers: new Map<string, { labels: Record<string, string>; state: string; exitCode: number; tag: string }>(),
  volumes: new Map<string, Record<string, string>>(),
  unreachable: false,
  /** The node disappears as soon as the copy would start. */
  vanishOnCopy: false,
  /** The series the server on a container reports (`8.0`, `8.4`, `9.7`); a helper reports by its image. */
  series: new Map<string, string>(),
  stagingRows: '42',
  fenceExit: 0,
  /** The copier's exit code; `null` keeps it running. */
  copierExit: 0 as number | null,
  /** `docker.runSpec` fails once for this volume. */
  failStartOf: '' as string,
  native: '',
  dumpBytes: Buffer.from('-- MySQL dump\nINSERT INTO orders VALUES (1);\n'),
  restored: [] as Buffer[],
  streams: [] as Array<{ kind: string; params: Record<string, unknown> }>,
  /** MongoDB: the release the data on each container's volume runs (the feature compatibility version). */
  mongoFcv: new Map<string, string>(),
}));

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { config: { ...actual.config, paths: { ...actual.config.paths, backupsDir: path.join(tmp, 'backups'), dataDir: tmp } } };
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/agentCapabilities.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentCapabilities.js')>()),
  assertNodeCapability: vi.fn(async () => undefined),
}));

vi.mock('../../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentClient.js')>()),
  agentTransportSealed: async () => true,
  agentOp: async (_db: unknown, _id: number, op: string, params: Record<string, unknown>, _sink: unknown, opts?: { tolerateExit?: boolean }) => {
    if (h.unreachable) throw new Error('connect ECONNREFUSED 10.0.0.5:4600');
    h.ops.push({ op, params });
    const answer = (exitCode: number, lines: string[] = []) => {
      if (exitCode !== 0 && !opts?.tolerateExit) throw new Error(`agent ${op} exited with ${exitCode}: ${lines.join(' ')}`);
      return { exitCode, lines };
    };
    const name = params['name'] as string;
    switch (op) {
      case 'agent.ping':
        return answer(0);
      case 'docker.inspect': {
        const c = h.containers.get(name);
        return c ? answer(0, [`${c.state}|172.20.0.2`]) : answer(1, ['Error: No such object']);
      }
      case 'docker.networkCreate':
        return answer(0);
      case 'docker.volumeInspect':
        return answer(h.volumes.has(name) ? 0 : 1);
      case 'docker.volumeCreate':
        if (h.volumes.has(name)) return answer(3, [`ND-VOLUME-EXISTS ${name}`]);
        h.volumes.set(name, (params['labels'] as Record<string, string>) ?? {});
        h.trace.push(`volume+ ${name}`);
        return answer(0, [name]);
      case 'docker.volumeRm':
        h.volumes.delete(name);
        h.trace.push(`volume- ${name}`);
        return answer(0);
      case 'docker.pull':
        h.trace.push(`pull ${params['image']}`);
        return answer(0);
      case 'file.deleteEnv':
        return answer(0);
      case 'file.writeEnv':
        return answer(0, [`wrote .agent-env/${name}.env`]);
      case 'docker.stop':
        h.trace.push(`stop ${name}`);
        h.containers.set(name, { labels: {}, state: 'exited', exitCode: 0, tag: '' });
        return answer(0);
      case 'docker.rm':
        h.containers.delete(name);
        h.trace.push(`rm ${name}`);
        return answer(0);
      case 'docker.runSpec': {
        const image = params['image'] as string;
        const volume = (params['volumes'] as Array<{ name: string }>)[0]!.name;
        h.trace.push(`start ${image} ${volume}`);
        if (h.failStartOf === volume) {
          h.failStartOf = '';
          return answer(1, ['docker: Error response from daemon: driver failed programming external connectivity']);
        }
        h.containers.set(name, { labels: { 'ninedeploy.managed': 'database' }, state: 'running', exitCode: 0, tag: image });
        return answer(0, ['cid']);
      }
      case 'db.upgrade':
        return upgradeOp(params, answer);
      default:
        throw new Error(`agent ${op} failed (400): {"error":{"code":"unknown_op"}}`);
    }
  },
}));

const REPLY = 'ND-DB-UPGRADE ';
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
const TAB = String.fromCharCode(9);
/** psql's field separator in the catalogue (lib/databaseUpgradeSql.ts `SEP`). */
const US = String.fromCharCode(31);
type Answer = (exitCode: number, lines?: string[]) => { exitCode: number; lines: string[] };

/** The fake node's `db.upgrade`: it knows actions and statement NAMES, nothing else. */
async function upgradeOp(params: Record<string, unknown>, answer: Answer) {
  const id = params['database'] as { databaseId: number; slug: string; container: string };
  const helper = (which: string) => `nd-db-upg-${id.slug}-${which}`;
  // Only `state`, `sql` and `measure` name a target; the real op validates each action's own fields.
  const target = params['target'] as { kind: string; helper?: string } | undefined;
  const where = !target || target.kind === 'database' ? id.container : helper(target.helper!);
  const reply = (value: unknown) => [`${REPLY}${JSON.stringify(value)}`];
  switch (params['action']) {
    case 'state': {
      const c = h.containers.get(where);
      return c ? answer(0, reply({ state: c.state, exitCode: c.exitCode, imageId: 'sha256:old', imageTag: c.tag })) : answer(0, reply({ state: 'missing' }));
    }
    case 'run': {
      const image = params['image'] as string;
      const name = helper(params['helper'] as string);
      const tag = image.startsWith('sha256:') ? (id.engine === 'mongo' ? 'mongo:6.0' : 'mysql:8.0') : image;
      h.containers.set(name, { labels: { 'ninedeploy.managed': 'database-upgrade' }, state: 'running', exitCode: 0, tag });
      // MongoDB's data keeps its own release: a helper starts on what its volume holds (the database's for the fence, the copy's for the staging container).
      if (id.engine === 'mongo') h.mongoFcv.set(name, h.mongoFcv.get(id.container) ?? '6.0');
      h.trace.push(`run ${params['helper']} ${image} ${(params['volume'] as string)}`);
      return answer(0, reply({ started: name }));
    }
    case 'remove':
      h.containers.delete(helper(params['helper'] as string));
      h.trace.push(`remove ${params['helper']}`);
      return answer(0);
    case 'stop': {
      const name = helper(params['helper'] as string);
      const c = h.containers.get(name);
      if (!c) return answer(0, reply({ exitCode: null }));
      const code = params['helper'] === 'old' ? h.fenceExit : 0;
      h.containers.delete(name);
      h.trace.push(`clean-stop ${params['helper']}=${code}`);
      return answer(0, reply({ exitCode: code }));
    }
    case 'copy': {
      if (h.vanishOnCopy) {
        h.unreachable = true;
        throw new Error('connect ECONNREFUSED 10.0.0.5:4600');
      }
      h.containers.set(helper('copy'), { labels: {}, state: h.copierExit === null ? 'running' : 'exited', exitCode: h.copierExit ?? 0, tag: 'mysql:8.4' });
      h.trace.push('copy-start');
      return answer(0, reply({ started: helper('copy') }));
    }
    case 'measure':
      return answer(0, params['what'] === 'size' ? ['1000\t/var/lib/mysql'] : ['Filesystem 1-blocks Used Available', '/dev/vda1 1000 500 322122547200 1%']);
    case 'sql': {
      const statement = params['statement'] as string;
      h.trace.push(`sql ${statement}@${target?.kind === 'database' ? 'database' : target?.helper}`);
      const tag = h.containers.get(where)?.tag ?? 'mysql:8.0';
      const series = h.series.get(where) ?? (tag === 'sha256:old' ? '8.0' : tag.slice(tag.lastIndexOf(':') + 1));
      const staging = target?.helper === 'new';
      switch (statement) {
        case 'mysql.serverVersion':
          return answer(0, [`${series}.40`]);
        case 'mysql.ping':
          return answer(0, ['1']);
        case 'mysql.fastShutdown':
          return answer(0);
        case 'mysql.nativeAccounts':
          return answer(0, h.native ? [h.native] : []);
        case 'mysql.userTables':
          return answer(0, [`${hex('shop')}${TAB}${hex('orders')}`]);
        case 'mysql.tableCounts': {
          // The names come as arguments; the count is keyed by the index the panel says the chunk starts at.
          const args = params['args'] as { tables: Array<{ schema: string; table: string }>; offset: number };
          expect(args.tables).toEqual([{ schema: 'shop', table: 'orders' }]);
          return answer(0, [`${args.offset}${TAB}${staging ? h.stagingRows : '42'}`]);
        }
        case 'mysql.objects':
          return answer(0, [['3', '2', '1', '0', '1', '0', '1'].join(TAB)]);
        case 'mysql.users':
          return answer(0, ['root@%', 'root@localhost', 'app@%', 'mysql.sys@localhost', ...(staging ? ['mysql.infoschema@localhost'] : [])].map(hex));
        // PostgreSQL: the same series the fake reads from the image (`postgres:16` reports 16).
        case 'postgres.serverVersionNum':
          return answer(0, [`${/^postgres:(\d+)/.exec(tag)?.[1] ?? '16'}0004`]);
        case 'postgres.databaseSize':
          return answer(0, ['1000']);
        case 'postgres.otherDatabases':
        case 'postgres.otherRoles':
          return answer(0);
        case 'postgres.tablesInPostgresDb':
          return answer(0, ['0']);
        case 'postgres.ping':
          return answer(0, ['1']);
        case 'postgres.analyze':
          return answer(0);
        case 'postgres.fingerprint.rows':
          return answer(0, [`public.orders${US}42`]);
        case 'postgres.fingerprint.sequences':
          return answer(0, [`public.orders_id_seq${US}42`]);
        case 'postgres.fingerprint.objects':
          return answer(0, [['3', '2', '0', '0', '1', 'plpgsql'].join(US)]);
        // MongoDB: the release the binary is (by image) and the release the data runs (by container); the inventory and the accounts as JSON.
        case 'mongo.serverVersion':
          return answer(0, [`${(h.containers.get(where)?.tag ?? 'mongo:6.0').slice(-3)}.40`]);
        case 'mongo.featureCompatibilityVersion':
          return answer(0, [h.mongoFcv.get(where) ?? '6.0']);
        case 'mongo.ping':
          return answer(0, ['1']);
        case 'mongo.setFeatureCompatibilityVersion': {
          const args = params['args'] as { series: string };
          h.mongoFcv.set(where, args.series);
          return answer(0, ['{"ok":1}']);
        }
        case 'mongo.inventory':
          return answer(0, [JSON.stringify([[['app.events', 'collection', 42, 2]]])]);
        case 'mongo.users':
          return answer(0, ['["admin.nine"]']);
        default:
          throw new Error(`the fake node knows no statement ${statement}`);
      }
    }
    default:
      throw new Error(`the fake node knows no action ${String(params['action'])}`);
  }
}

vi.mock('../../src/lib/agentStream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentStream.js')>()),
  openAgentStream: async (_db: unknown, _serverId: number, kind: string, params: Record<string, unknown>) => {
    h.streams.push({ kind, params });
    if (kind === 'db.dump') {
      h.trace.push(`dump ${params['container']}`);
      const readable = new PassThrough();
      const done = new Promise((resolve) => readable.on('end', () => resolve({ bytes: h.dumpBytes.length, sha256: 'x', result: {} })));
      setImmediate(() => readable.end(h.dumpBytes));
      return { kind, direction: 'agent-to-panel', readable, done, abort: () => undefined };
    }
    const writable = new PassThrough();
    writable.on('data', (c: Buffer) => h.restored.push(Buffer.from(c)));
    const done = new Promise((resolve) => writable.on('finish', () => resolve({ bytes: 0, sha256: '', result: {} })));
    return { kind, direction: 'panel-to-agent', writable, done, abort: () => undefined };
  },
}));

// The panel host must never be touched for a node database.
const forbidden = (what: string) => () => {
  throw new Error(`local docker must not run: ${what}`);
};
vi.mock('../../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/exec.js')>()),
  run: async (cmd: string, args: string[]) => forbidden(`${cmd} ${args.join(' ')}`)(),
  capture: async (cmd: string, args: string[]) => forbidden(`${cmd} ${args.join(' ')}`)(),
  sleep: async () => undefined,
}));
vi.mock('../../src/lib/dockerPull.js', () => ({
  pullDockerImage: async (image: string) => forbidden(`pull ${image}`)(),
  ensureDockerImage: async (image: string) => forbidden(`ensure ${image}`)(),
}));

const caps = await import('../../src/lib/agentCapabilities.js');
const { HttpError } = await import('../../src/lib/errors.js');
const mod = await import('../../src/lib/databaseUpgrade.js');
const {
  UPGRADE_WAITING, admitUpgrade, assertNoRunningUpgrade, finalizeDatabaseUpgrade, planUpgrade, recoverInterruptedUpgrades, resumeInterruptedUpgrades,
  rollbackDatabaseUpgrade, runDatabaseUpgrade, upgradeOptions, upgradeRefusal,
} = mod;
const { nodeDatabaseUpgradeDeps } = await import('../../src/lib/nodeDatabaseUpgrade.js');
const { helperName, hostView, volumeOf, volumeSet } = await import('../../src/lib/databaseUpgradeNames.js');
const { nodeDatabaseRuntime } = await import('../../src/lib/nodeDatabase.js');
const { ENGINES, createBackupReadStream } = await import('../../src/engine/database.js');
// Late, as in nodeDatabases.test.ts: the config mock reads the temp directory, which exists only after the module's own imports.
const { encrypt } = await import('../../src/lib/crypto.js');

let db: DB;
let dbClient: ReturnType<typeof createDb>['client'] | undefined;
// Release each native connection before another test allocates one. Leaving
// clients to GC can crash libsql 0.5.29 finalizers on Windows (libsql-js#231).
afterEach(() => {
  dbClient?.close();
  dbClient = undefined;
});
const SLUG = 'shop';
const own = (slug: string, id: string) => ({ 'ninedeploy.managed': 'database', 'ninedeploy.database.id': id, 'ninedeploy.database.slug': slug });

beforeEach(async () => {
  h.trace.length = 0;
  h.ops.length = 0;
  h.containers.clear();
  h.volumes.clear();
  h.series.clear();
  h.unreachable = false;
  h.vanishOnCopy = false;
  h.stagingRows = '42';
  h.fenceExit = 0;
  h.copierExit = 0;
  h.failStartOf = '';
  h.native = '';
  h.restored = [];
  h.streams = [];
  h.mongoFcv.clear();
  vi.mocked(caps.assertNodeCapability).mockReset();
  vi.mocked(caps.assertNodeCapability).mockResolvedValue(undefined);
  ({ db, client: dbClient } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 7, email: 'owner@example.com', passwordHash: 'x' });
  await db.insert(servers).values({ id: 3, name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' } as never);
  await db.insert(databases).values({
    id: 20, ownerUserId: 7, name: 'shop', slug: SLUG, engine: 'mysql', status: 'running', version: null, serverId: 3,
    containerName: null, volumeName: null, internalHost: 'nd-db-shop', passwordEncrypted: encrypt('pw-shop'), username: 'root', dbName: 'app',
  } as never);
  h.containers.set('nd-db-shop', { labels: { 'ninedeploy.managed': 'database' }, state: 'running', exitCode: 0, tag: 'mysql:8.0' });
  h.volumes.set('nd-db-shop-data', own(SLUG, '20'));
});

const row = async () => (await db.query.databases.findFirst({ where: eq(databases.id, 20) }))!;
const upgradeRow = async (id: number) => (await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, id) }))!;
const noop = () => undefined;
/** The node deps over the fake agent, without real pauses. */
const fastDeps = (d: Database) => nodeDatabaseUpgradeDeps(db, d, { pollMs: 0, wait: async () => undefined });
async function admitAndRun(to: string) {
  const d = await row();
  const plan = await planUpgrade(db, d, to, fastDeps(d));
  const admitted = await admitUpgrade(db, d, plan, 7);
  h.trace.length = 0;
  await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: admitted.fromImageTag }, fastDeps(await row()));
  return upgradeRow(admitted.id);
}

const COPY_PATH = (vol: string) => [
  'pull mysql:8.4', 'pull mysql:9.7',
  'stop nd-db-shop', 'rm nd-db-shop',
  `run old sha256:old nd-db-shop-data`,
  'sql mysql.ping@old',
  'sql mysql.userTables@old', 'sql mysql.tableCounts@old', 'sql mysql.objects@old', 'sql mysql.users@old',
  'dump nd-db-upg-shop-old',
  'sql mysql.fastShutdown@old', 'clean-stop old=0',
  `volume+ ${vol}`,
  'copy-start', 'remove copy',
  `run new mysql:8.4 ${vol}`, 'sql mysql.ping@new', 'sql mysql.fastShutdown@new', 'clean-stop new=0',
  `run new mysql:9.7 ${vol}`, 'sql mysql.ping@new',
  'sql mysql.userTables@new', 'sql mysql.tableCounts@new', 'sql mysql.objects@new', 'sql mysql.users@new',
  'clean-stop new=0',
];

describe('a node is no refusal', () => {
  it('the row keeps its own columns, and the names come out of them', async () => {
    const d = await row();
    expect(upgradeRefusal(d)).toBeNull();
    expect(upgradeRefusal({ ...d, engine: 'mongo' })).toBeNull();
    expect(upgradeRefusal({ ...d, engine: 'redis' })?.code).toBe('database_upgrade_engine');
    expect(upgradeRefusal({ ...d, pitrEnabled: true })?.code).toBe('database_upgrade_pitr');
    const view = hostView(d);
    expect(view).toMatchObject({ containerName: 'nd-db-shop', volumeName: 'nd-db-shop-data', serverId: 3 });
    expect(d).toMatchObject({ containerName: null, volumeName: null });
    expect(volumeOf(view)).toBe('nd-db-shop-data');
    expect(volumeSet(d, 'x')).toEqual({ nodeVolumeName: 'x' });
    expect(volumeSet({ serverId: null }, 'x')).toEqual({ volumeName: 'x' });
    expect(helperName(d, 'fence')).toBe('nd-db-upg-shop-old');
    expect(helperName({ slug: SLUG, serverId: null }, 'fence')).toBe(`nd-dbup-${SLUG}-old`);
  });

  it('options ask the node for its series, after the capability check', async () => {
    expect(await upgradeOptions(db, await row())).toEqual({ currentMajor: 8, targets: [], currentSeries: '8.0', versions: ['8.4', '9.7'], refusal: null });
    expect(caps.assertNodeCapability).toHaveBeenCalledWith(db, 3, { cap: ['db.upgrade'], feature: 'upgrade a database to a new major version', sealedRequired: true });
    expect(h.trace).toEqual(['sql mysql.serverVersion@database']);
  });

  it('an agent that cannot upgrade says so on the card, and refuses a start with its own code', async () => {
    vi.mocked(caps.assertNodeCapability).mockRejectedValue(new HttpError(422, 'node_agent_outdated', 'The agent on node edge-1 (version 0.20.0) cannot upgrade a database to a new major version. Update the node agent.'));
    expect(await upgradeOptions(db, await row())).toMatchObject({ versions: [], refusal: { code: 'node_agent_outdated', message: expect.stringContaining('cannot upgrade a database') } });
    await expect(planUpgrade(db, await row(), '8.4')).rejects.toMatchObject({ statusCode: 422, code: 'node_agent_outdated' });
    expect(h.ops).toEqual([]);
  });

  it('a node that does not answer is a refusal on the card, not an error', async () => {
    h.unreachable = true;
    expect(await upgradeOptions(db, await row())).toMatchObject({ versions: [], refusal: { code: 'database_upgrade_host_unreachable', message: expect.stringContaining('Could not reach the host of this database') } });
  });
});

describe('the copy method on a node: MySQL 8.0 → 9.7', () => {
  it('runs the journal through the agent, by action and statement name, and switches the row in its own column', async () => {
    const up = await admitAndRun('9.7');
    const vol = `nd-db-shop-data-u${up.id}`;
    expect(up).toMatchObject({ status: 'completed', switched: true, fromSeries: '8.0', toSeries: '9.7', previousVersion: '8.0', previousVolume: 'nd-db-shop-data', targetVolume: vol });
    expect(up.error).toBeNull();
    expect(h.trace).toEqual([...COPY_PATH(vol), 'remove old', 'remove new', 'remove copy', 'pull mysql:9.7', 'rm nd-db-shop', `start mysql:9.7 ${vol}`, 'sql mysql.ping@database']);
    // The row: switched in the node column; the panel host's columns stay NULL.
    const d = await row();
    expect(d).toMatchObject({ status: 'running', version: '9.7', nodeVolumeName: vol, containerName: null, volumeName: null });
    expect(JSON.parse(up.verification!)).toMatchObject({ tables: 1, rows: 42, users: 4, objects: { indexes: 3, events: 0, schemas: 1 }, mismatches: [] });
  });

  it('no request to the node carries SQL, a helper name of the panel host, or a volume of another database', async () => {
    await admitAndRun('8.4');
    const upgradeOps = h.ops.filter((o) => o.op === 'db.upgrade');
    expect(upgradeOps.length).toBeGreaterThan(10);
    for (const { params } of upgradeOps) {
      expect(JSON.stringify(params)).not.toMatch(/SELECT |COUNT\(\*\)|information_schema|nd-dbup-/);
      expect(params['database']).toEqual({ databaseId: 20, slug: SLUG, engine: 'mysql', container: 'nd-db-shop' });
    }
    // The new volume was created with the row's id among its labels, and never adopted.
    const created = h.ops.find((o) => o.op === 'docker.volumeCreate')!;
    expect(created.params).toMatchObject({ ifExists: 'fail', labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.id': '20', 'ninedeploy.database.engine': 'mysql' } });
    // The helpers ran with the row's credentials in their env, never on the panel host.
    const runs = h.ops.filter((o) => o.op === 'db.upgrade' && o.params['action'] === 'run');
    expect(runs.map((o) => [o.params['helper'], o.params['volume']])).toEqual([['old', 'nd-db-shop-data'], ['new', `nd-db-shop-data-u${(await upgradeRow(1)).id}`]]);
    expect(runs.every((o) => (o.params['env'] as Record<string, string>)['MYSQL_ROOT_PASSWORD'] === 'pw-shop' && o.params['mount'] === '/var/lib/mysql')).toBe(true);
  });

  it('keeps the safety dump in the panel\'s backups directory, read from the fence over the stream channel', async () => {
    const up = await admitAndRun('8.4');
    const safety = await db.query.backups.findFirst({ where: eq(backups.id, up.safetyBackupId!) });
    expect(safety).toMatchObject({ databaseId: 20, label: 'pre-upgrade', status: 'completed' });
    expect(existsSync(safety!.path!)).toBe(true);
    expect(h.streams).toEqual([{ kind: 'db.dump', params: { container: 'nd-db-upg-shop-old', engine: 'mysql', password: 'pw-shop' } }]);
    // Encrypted at rest, in the panel host's format.
    expect(await (await createBackupReadStream(safety!.path!)).toArray()).toEqual([h.dumpBytes]);
  });

  it('a copy that exits non-zero is never started on, and the old server comes back', async () => {
    h.copierExit = 1;
    const up = await admitAndRun('8.4');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('copying the volume exited with 1');
    expect(h.trace.some((line) => line.startsWith('run new'))).toBe(false);
    expect(h.trace).toContain('volume- nd-db-shop-data-u1');
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', nodeVolumeName: 'nd-db-shop-data' });
    expect(up.previousVersion).toBe('8.0');
  });

  it('a fence that did not shut down cleanly is never copied', async () => {
    h.fenceExit = 137;
    const up = await admitAndRun('8.4');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('did not shut down cleanly (exit code 137)');
    expect(h.trace.some((line) => line.startsWith('copy-start'))).toBe(false);
  });

  it('a mismatch on the node fails before the switch', async () => {
    h.stagingRows = '41';
    const up = await admitAndRun('8.4');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('the upgraded copy does not match the old cluster');
    expect(up.switched).toBe(false);
    expect(JSON.parse(up.verification!).mismatches).toEqual(['table shop.orders: 42 before, 41 after']);
    expect(await row()).toMatchObject({ status: 'running', nodeVolumeName: 'nd-db-shop-data' });
  });

  it('a failed start after the switch points the node row back and keeps the new volume', async () => {
    const admitted = await (async () => {
      const d = await row();
      return admitUpgrade(db, d, await planUpgrade(db, d, '8.4', fastDeps(d)), 7);
    })();
    h.failStartOf = `nd-db-shop-data-u${admitted.id}`;
    await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: admitted.fromImageTag }, fastDeps(await row()));
    const up = await upgradeRow(admitted.id);
    expect(up).toMatchObject({ status: 'failed', switched: false });
    expect(up.error).toContain('The database runs on MySQL 8.0 as before. The upgraded volume');
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', nodeVolumeName: 'nd-db-shop-data' });
    expect(h.volumes.has(`nd-db-shop-data-u${admitted.id}`)).toBe(true);
    expect(h.trace.filter((line) => line.startsWith('start '))).toEqual([`start mysql:8.4 nd-db-shop-data-u${admitted.id}`, 'start mysql:8.0 nd-db-shop-data']);
  });
});

/** A second node database, PostgreSQL 16, with its container and volume on the same fake node. */
async function seedPostgres() {
  await db.insert(databases).values({
    id: 21, ownerUserId: 7, name: 'pg', slug: 'pg', engine: 'postgres', status: 'running', version: '16', serverId: 3,
    containerName: null, volumeName: null, internalHost: 'nd-db-pg', passwordEncrypted: encrypt('pw-pg'), username: 'nine', dbName: 'app',
  } as never);
  h.containers.set('nd-db-pg', { labels: { 'ninedeploy.managed': 'database' }, state: 'running', exitCode: 0, tag: 'postgres:16' });
  h.volumes.set('nd-db-pg-data', own('pg', '21'));
  return (await db.query.databases.findFirst({ where: eq(databases.id, 21) }))!;
}

describe('the dump method on a node: PostgreSQL 16 → 17', () => {
  it('dumps through the fence, restores into the staging copy over the stream channel, compares, switches, starts', async () => {
    const pg = await seedPostgres();
    const image = ENGINES.postgres!.image('17');
    const plan = await planUpgrade(db, pg, '17', fastDeps(pg));
    expect(plan).toMatchObject({ fromSeries: '16', toSeries: '17', steps: ['17'], fromImage: { id: 'sha256:old', tag: 'postgres:16' } });
    const admitted = await admitUpgrade(db, pg, plan, 7);
    const vol = `nd-db-pg-data-u${admitted.id}`;
    h.trace.length = 0;
    await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: admitted.fromImageTag }, fastDeps(pg));
    expect((await upgradeRow(admitted.id)).error).toBeNull();
    expect(await upgradeRow(admitted.id)).toMatchObject({ status: 'completed', switched: true, fromSeries: '16', toSeries: '17', targetVolume: vol });
    expect(h.trace).toEqual([
      `pull ${image}`, 'stop nd-db-pg', 'rm nd-db-pg',
      'run old sha256:old nd-db-pg-data', 'sql postgres.ping@old',
      'sql postgres.fingerprint.rows@old', 'sql postgres.fingerprint.sequences@old', 'sql postgres.fingerprint.objects@old',
      'dump nd-db-upg-pg-old', 'remove old',
      `volume+ ${vol}`,
      `run new ${image} ${vol}`, 'sql postgres.ping@new', 'sql postgres.analyze@new',
      'sql postgres.fingerprint.rows@new', 'sql postgres.fingerprint.sequences@new', 'sql postgres.fingerprint.objects@new',
      'remove new',
      'remove old', 'remove new', 'remove copy',
      `pull ${image}`, 'rm nd-db-pg', `start ${image} ${vol}`, 'sql postgres.ping@database',
    ]);
    expect(await db.query.databases.findFirst({ where: eq(databases.id, 21) })).toMatchObject({ status: 'running', version: '17', nodeVolumeName: vol, containerName: null, volumeName: null });
    expect(JSON.parse((await upgradeRow(admitted.id)).verification!)).toMatchObject({ tables: 1, rows: 42, sequences: 1, mismatches: [] });
    // What went back into the staging copy is the safety dump itself, decrypted on the panel, in the stream channel.
    expect(h.streams.map((s) => [s.kind, s.params['container']])).toEqual([['db.dump', 'nd-db-upg-pg-old'], ['db.restore', 'nd-db-upg-pg-new']]);
    expect(Buffer.concat(h.restored).equals(h.dumpBytes)).toBe(true);
    // The fence was started on the old image on the old volume; the staging copy on the new image on the new one.
    const runs = h.ops.filter((o) => o.op === 'db.upgrade' && o.params['action'] === 'run');
    expect(runs.map((o) => [o.params['helper'], o.params['image'], o.params['volume']])).toEqual([['old', 'sha256:old', 'nd-db-pg-data'], ['new', image, vol]]);
  });
});

describe('the copy method on a node: MongoDB 6.0 → 7.0', () => {
  it('the copy starts on 7.0, the data is told it runs 7.0 (by name, the series as its argument), the record says what the data ran', async () => {
    await db.insert(databases).values({
      id: 22, ownerUserId: 7, name: 'events', slug: 'events', engine: 'mongo', status: 'running', version: '6.0', serverId: 3,
      containerName: null, volumeName: null, internalHost: 'nd-db-events', passwordEncrypted: encrypt('pw-events'), username: 'nine',
    } as never);
    const events = (await db.query.databases.findFirst({ where: eq(databases.id, 22) }))!;
    h.containers.set('nd-db-events', { labels: { 'ninedeploy.managed': 'database' }, state: 'running', exitCode: 0, tag: 'mongo:6.0' });
    h.volumes.set('nd-db-events-data', own('events', '22'));
    const deps = fastDeps(events);
    const plan = await planUpgrade(db, events, '7.0', deps);
    expect(plan).toMatchObject({ fromSeries: '6.0', toSeries: '7.0', steps: ['7.0'], fromImage: { tag: 'mongo:6.0' } });
    const admitted = await admitUpgrade(db, events, plan, 7);
    h.trace.length = 0;
    await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: admitted.fromImageTag }, deps);
    const up = await upgradeRow(admitted.id);
    expect(up.error).toBeNull();
    const vol = `nd-db-events-data-u${admitted.id}`;
    expect(h.trace).toEqual([
      'sql mongo.featureCompatibilityVersion@database',
      'pull mongo:7.0', 'stop nd-db-events', 'rm nd-db-events',
      'run old sha256:old nd-db-events-data', 'sql mongo.ping@old', 'sql mongo.inventory@old', 'sql mongo.users@old',
      'dump nd-db-upg-events-old', 'clean-stop old=0',
      `volume+ ${vol}`, 'copy-start', 'remove copy',
      `run new mongo:7.0 ${vol}`, 'sql mongo.ping@new', 'sql mongo.setFeatureCompatibilityVersion@new',
      'sql mongo.inventory@new', 'sql mongo.users@new', 'sql mongo.featureCompatibilityVersion@new',
      'clean-stop new=0',
      'remove old', 'remove new', 'remove copy', 'pull mongo:7.0', 'rm nd-db-events', `start mongo:7.0 ${vol}`, 'sql mongo.ping@database',
    ]);
    const set = h.ops.find((o) => o.op === 'db.upgrade' && o.params['action'] === 'sql' && o.params['statement'] === 'mongo.setFeatureCompatibilityVersion')!;
    expect(set.params).toEqual({ database: { databaseId: 22, slug: 'events', engine: 'mongo', container: 'nd-db-events' }, action: 'sql', target: { kind: 'helper', helper: 'new' }, statement: 'mongo.setFeatureCompatibilityVersion', args: { series: '7.0' }, password: 'pw-events' });
    // The helper that ran on the copy got the row's credentials; the fence started on the old image on the old volume at `/data/db`.
    expect(h.ops.filter((o) => o.op === 'db.upgrade' && o.params['action'] === 'run').map((o) => [o.params['helper'], o.params['image'], o.params['volume'], o.params['mount'], (o.params['env'] as Record<string, string>)['MONGO_INITDB_ROOT_PASSWORD']])).toEqual([['old', 'sha256:old', 'nd-db-events-data', '/data/db', 'pw-events'], ['new', 'mongo:7.0', vol, '/data/db', 'pw-events']]);
    expect(JSON.parse(up.verification!)).toMatchObject({ tables: 1, rows: 42, users: 1, objects: { indexes: 2, views: 0 }, mismatches: [], featureCompatibility: { before: '6.0', after: '7.0' } });
    expect(await db.query.databases.findFirst({ where: eq(databases.id, 22) })).toMatchObject({ status: 'running', version: '7.0', nodeVolumeName: vol, containerName: null, volumeName: null });
  });
});

describe('rollback and finalize on a node', () => {
  it('rollback starts the old series on the untouched old volume; finalize removes the new one on the node', async () => {
    const up = await admitAndRun('8.4');
    await rollbackDatabaseUpgrade(db, up, 7, fastDeps(await row()));
    expect(await upgradeRow(up.id)).toMatchObject({ status: 'rolled_back', switched: false });
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', nodeVolumeName: 'nd-db-shop-data' });
    expect(h.trace.slice(-9)).toEqual(['stop nd-db-shop', 'rm nd-db-shop', 'remove old', 'remove new', 'remove copy', 'pull mysql:8.0', 'rm nd-db-shop', 'start mysql:8.0 nd-db-shop-data', 'sql mysql.ping@database']);
    expect(await finalizeDatabaseUpgrade(db, await upgradeRow(up.id), 7, fastDeps(await row()))).toEqual({ removedVolume: `nd-db-shop-data-u${up.id}` });
    expect(await upgradeRow(up.id)).toMatchObject({ status: 'finalized' });
    expect(h.volumes.has(`nd-db-shop-data-u${up.id}`)).toBe(false);
    expect(h.volumes.has('nd-db-shop-data')).toBe(true);
  });

  it('finalize refuses while the row still uses the volume the upgrade would delete', async () => {
    const up = await admitAndRun('8.4');
    // A rollback claimed, yet the row was not pointed back: the volume it would delete is the one in use.
    await db.update(databaseUpgrades).set({ status: 'rolled_back' }).where(eq(databaseUpgrades.id, up.id));
    await expect(finalizeDatabaseUpgrade(db, up, 7, fastDeps(await row()))).rejects.toMatchObject({ code: 'database_upgrade_state', message: expect.stringContaining('still uses') });
    expect(h.volumes.has(`nd-db-shop-data-u${up.id}`)).toBe(true);
  });
});

describe('the node disappears during the copy', () => {
  it('the row is pointed back in the database alone, the failure is honest, and the next start clears the helpers first', async () => {
    const admitted = await (async () => {
      const d = await row();
      return admitUpgrade(db, d, await planUpgrade(db, d, '8.4', fastDeps(d)), 7);
    })();
    h.vanishOnCopy = true;
    await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: admitted.fromImageTag }, fastDeps(await row()));
    const up = await upgradeRow(admitted.id);
    expect(up.status).toBe('failed');
    expect(up.error).toContain('could not be started again on MySQL 8.0');
    // What the panel could do without the node: the row names the old volume and series again.
    expect(await row()).toMatchObject({ status: 'error', version: '8.0', nodeVolumeName: 'nd-db-shop-data' });
    // The node is back: a start removes the three helpers by name before anything runs on the old volume.
    h.unreachable = false;
    h.trace.length = 0;
    await nodeDatabaseRuntime(db, await row()).start(noop);
    expect(h.trace.slice(0, 6)).toEqual(['remove old', 'remove new', 'remove copy', 'pull mysql:8.0', 'rm nd-db-shop', 'start mysql:8.0 nd-db-shop-data']);
  });

  it('a database that was never upgraded is not asked about helpers', async () => {
    h.containers.delete('nd-db-shop');
    await nodeDatabaseRuntime(db, await row()).start(noop);
    expect(h.trace.slice(0, 3)).toEqual(['pull mysql:9.7', 'rm nd-db-shop', 'start mysql:9.7 nd-db-shop-data']);
    expect(h.ops.some((o) => o.op === 'db.upgrade')).toBe(false);
  });
});

describe('boot recovery on a node', () => {
  async function interrupted(opts: { switched?: boolean } = {}) {
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, '8.4', fastDeps(d)), 7);
    await db.update(databaseUpgrades).set({ phase: 'copy', switched: opts.switched ?? false }).where(eq(databaseUpgrades.id, admitted.id));
    if (opts.switched) await db.update(databases).set({ version: '8.4', nodeVolumeName: admitted.targetVolume }).where(eq(databases.id, 20));
    // What the node holds when the panel comes back: the database container is gone, the helpers are there.
    h.containers.delete('nd-db-shop');
    for (const which of ['old', 'new', 'copy']) h.containers.set(`nd-db-upg-shop-${which}`, { labels: {}, state: 'running', exitCode: 0, tag: 'mysql:8.0' });
    h.volumes.set(admitted.targetVolume, own(SLUG, '20'));
    h.trace.length = 0;
    return admitted;
  }

  it('not switched: the helpers go, the new volume goes, the old server starts on its own volume', async () => {
    const admitted = await interrupted();
    expect(await recoverInterruptedUpgrades(db)).toBe(1);
    const up = await upgradeRow(admitted.id);
    expect(up).toMatchObject({ status: 'failed', switched: false });
    expect(up.error).toBe('interrupted by a panel restart; the database was started on its previous volume');
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', nodeVolumeName: 'nd-db-shop-data' });
    expect(h.volumes.has(admitted.targetVolume)).toBe(false);
    expect(h.containers.has('nd-db-upg-shop-old')).toBe(false);
    // The helpers go by name before anything is started; the start clears them once more.
    expect(h.trace.slice(0, 4)).toEqual(['remove old', 'remove new', 'remove copy', 'volume- nd-db-shop-data-u1']);
    expect(h.trace.filter((line) => line.startsWith('start '))).toEqual(['start mysql:8.0 nd-db-shop-data']);
    expect(h.ops.filter((o) => o.op === 'docker.rm').map((o) => o.params['name'])).toEqual(['nd-db-shop']);
  });

  it('switched, on the new volume: one start on it, and the upgrade counts as completed', async () => {
    const admitted = await interrupted({ switched: true });
    expect(await recoverInterruptedUpgrades(db)).toBe(1);
    expect(await upgradeRow(admitted.id)).toMatchObject({ status: 'completed', switched: true });
    expect(await row()).toMatchObject({ status: 'running', version: '8.4', nodeVolumeName: admitted.targetVolume });
    expect(h.trace.filter((line) => line.startsWith('start '))).toEqual([`start mysql:8.4 ${admitted.targetVolume}`]);
  });

  it('the node does not answer at boot: the row stays open with a note, the lifecycle keeps refusing, and the sweep finishes it when the node is back', async () => {
    const admitted = await interrupted();
    h.unreachable = true;
    expect(await recoverInterruptedUpgrades(db)).toBe(1);
    const waiting = await upgradeRow(admitted.id);
    expect(waiting.status).toBe('running');
    expect(waiting.error).toMatch(new RegExp(`^${UPGRADE_WAITING} \\(connect ECONNREFUSED`));
    // Nothing was touched on the node: the row names the old volume (it always did), and no start is possible.
    expect(await row()).toMatchObject({ version: '8.0', nodeVolumeName: 'nd-db-shop-data' });
    await expect(assertNoRunningUpgrade(db, 20)).rejects.toMatchObject({ statusCode: 409 });
    // Still down: the sweep tries and finishes nothing.
    expect(await resumeInterruptedUpgrades(db)).toBe(0);
    expect((await upgradeRow(admitted.id)).status).toBe('running');
    // Back: the same recovery boot would have run.
    h.unreachable = false;
    h.trace.length = 0;
    expect(await resumeInterruptedUpgrades(db)).toBe(1);
    const up = await upgradeRow(admitted.id);
    expect(up.status).toBe('failed');
    expect(up.error).not.toMatch(new RegExp(`^${UPGRADE_WAITING}`));
    expect(await row()).toMatchObject({ status: 'running', nodeVolumeName: 'nd-db-shop-data' });
    expect(h.trace.filter((line) => line.startsWith('start '))).toEqual(['start mysql:8.0 nd-db-shop-data']);
    // Nothing left waiting.
    expect(await resumeInterruptedUpgrades(db)).toBe(0);
  });

  it('a running upgrade of this process is never picked up by the sweep: only rows that wait carry a note', async () => {
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, '8.4', fastDeps(d)), 7);
    expect(admitted.error).toBeNull();
    expect(await resumeInterruptedUpgrades(db)).toBe(0);
    expect(h.trace).toEqual(['sql mysql.serverVersion@database', 'sql mysql.nativeAccounts@database']);
  });
});

describe('what the panel host still answers for a node row', () => {
  it('the safety dump lands on the panel host, so its room is the panel host\'s', async () => {
    const before = readdirSync(path.join(tmp, 'backups')).length;
    await admitAndRun('8.4');
    expect(readdirSync(path.join(tmp, 'backups')).length).toBe(before + 1);
  });

  it('the names of the journal never leak into the node columns as a host view', async () => {
    await admitAndRun('8.4');
    expect(await row()).toMatchObject({ containerName: null, volumeName: null, nodeContainerName: null, nodeVolumeName: 'nd-db-shop-data-u1' });
  });
});
