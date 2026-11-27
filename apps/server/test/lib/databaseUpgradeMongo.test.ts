import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, createDb, type Database, databaseAttachments, databases, databaseUpgrades, type DB, runMigrations, services, users } from '@ninedeploy/db';

/**
 * N12: MongoDB moves one release at a time, and its data directory has a
 * release of its own (the feature compatibility version). Real migrated
 * SQLite; every Docker call is faked, and the fake answers by the NAME of the
 * statement — the server prints JSON for the inventory and the accounts. The
 * real run against real images is test/integration/databaseUpgradeNode.integ.test.ts.
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-db-upgrade-mongo-'));
vi.mock('../../src/config.js', () => ({ config: { paths: { backupsDir: path.join(tmp, 'backups'), dataDir: tmp } } }));
mkdirSync(path.join(tmp, 'backups'), { recursive: true });
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const mod = await import('../../src/lib/databaseUpgrade.js');
const { admitUpgrade, planUpgrade, rollbackDatabaseUpgrade, rowSeries, runDatabaseUpgrade, upgradeOptions, upgradeSteps } = mod;
type Deps = typeof mod.databaseUpgradeDeps;

let db: DB;
let dbClient: ReturnType<typeof createDb>['client'] | undefined;

async function seed(version: string | null) {
  dbClient?.close();
  ({ db, client: dbClient } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 7, email: 'owner@example.com', passwordHash: 'x' });
  await db.insert(services).values({ id: 1, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 7 } as never);
  await db.insert(databases).values({
    id: 30, ownerUserId: 7, name: 'logs', slug: 'logs', engine: 'mongo', status: 'running', version,
    containerName: 'nd-db-logs', internalHost: 'nd-db-logs', volumeName: 'nd-db-logs-data', passwordEncrypted: 'x', username: 'nine',
  } as never);
  await db.insert(databaseAttachments).values({ serviceId: 1, databaseId: 30, envAlias: 'DATABASE_URL' });
}
afterEach(() => {
  dbClient?.close();
  dbClient = undefined;
});

beforeEach(async () => {
  await seed('6.0');
});

function fakeDeps(opts: { binary?: string; fcv?: string; setReply?: string; stagingCount?: number; fenceExit?: number | null; failReadyOf?: string; free?: number } = {}) {
  const calls: string[] = [];
  const volumes = new Set(['nd-db-logs-data']);
  const oldVersion = opts.fcv ?? '6.0';
  let stagingImage = '';
  /** What the data on a volume runs: the old volume's release, and the copy's (which each step raises). */
  const dataRelease = new Map<string, string>([['nd-db-logs-data', oldVersion]]);
  const deps: Deps = {
    psql: vi.fn(async () => { throw new Error('psql must not run for MongoDB'); }),
    sql: vi.fn(async (_d: Database, container: string, s: { name: string; args: Record<string, unknown>; text: string }) => {
      // The database's own container and the fence are on the old volume; the staging copy on the new one.
      const volume = container === 'nd-dbup-logs-new' ? 'nd-db-logs-data-u1' : 'nd-db-logs-data';
      switch (s.name) {
        case 'mongo.serverVersion':
          return `${container === 'nd-db-logs' ? (opts.binary ?? '6.0') : stagingImage.slice(stagingImage.lastIndexOf(':') + 1)}.40\n`;
        case 'mongo.featureCompatibilityVersion':
          return `${dataRelease.get(volume) ?? ''}\n`;
        case 'mongo.ping':
          if (opts.failReadyOf && container === 'nd-dbup-logs-new' && stagingImage.endsWith(opts.failReadyOf)) throw new Error('MongoServerError: authentication failed');
          return '1\n';
        case 'mongo.setFeatureCompatibilityVersion': {
          calls.push(`set ${String(s.args.series)} ${container}`);
          if (opts.setReply) return `${opts.setReply}\n`;
          dataRelease.set(volume, String(s.args.series));
          return '{"ok":1}\n';
        }
        case 'mongo.inventory': {
          // The old data, or what the copy holds: a mismatch shows as a changed count.
          const onStaging = container === 'nd-dbup-logs-new';
          const count = onStaging ? (opts.stagingCount ?? 42) : 42;
          return `${JSON.stringify([[['app.events', 'collection', count, 2]], [['app.readonly', 'view', 7, 0]]])}\n`;
        }
        case 'mongo.users':
          return '["admin.nine"]\n';
        default:
          throw new Error(`a statement of another family ran on MongoDB: ${s.name}`);
      }
    }),
    containerImage: vi.fn(async () => ({ id: 'sha256:old', tag: 'mongo:6.0' })),
    containerRunning: vi.fn(async () => true),
    pull: vi.fn(async (image: string) => { calls.push(`pull ${image}`); }),
    stopAndRemove: vi.fn(async (name: string) => { calls.push(`stop ${name}`); }),
    stopClean: vi.fn(async (name: string) => {
      calls.push(`clean-stop ${name}`);
      return name === 'nd-dbup-logs-old' && opts.fenceExit !== undefined ? opts.fenceExit : 0;
    }),
    runIsolated: vi.fn(async (_d: Database, spec: { name: string; image: string; volume: string; mount: string }) => {
      if (spec.name === 'nd-dbup-logs-new') stagingImage = spec.image;
      calls.push(`isolated ${spec.name} ${spec.image} ${spec.volume}:${spec.mount}`);
    }),
    waitReady: vi.fn(async (container: string) => !(opts.failReadyOf && container === 'nd-dbup-logs-new' && stagingImage.endsWith(opts.failReadyOf))),
    dump: vi.fn(async (d: Database, file: string) => {
      calls.push(`dump ${d.containerName}`);
      writeFileSync(file, 'dump');
    }),
    restore: vi.fn(async () => { throw new Error('restore must not run for MongoDB'); }),
    createVolume: vi.fn(async (name: string) => {
      calls.push(`volume+ ${name}`);
      volumes.add(name);
    }),
    copyVolume: vi.fn(async (from: string, to: string, image: string, name: string) => { calls.push(`copy ${from} ${to} ${image} as ${name}`); }),
    volumeExists: vi.fn(async (name: string) => volumes.has(name)),
    removeVolume: vi.fn(async (name: string) => {
      calls.push(`volume- ${name}`);
      volumes.delete(name);
      return true;
    }),
    start: vi.fn(async (d: Database) => { calls.push(`start ${d.containerName} v${d.version} ${d.volumeName}`); }),
    attachBridges: vi.fn(async (_d: Database, slugs: string[]) => { calls.push(`bridges ${slugs.join(',')}`); }),
    dataDirBytes: vi.fn(async () => 1000),
    freeBytesIn: vi.fn(async () => opts.free ?? 100 * 1024 ** 3),
    freeBytes: vi.fn(async () => 100 * 1024 ** 3),
    maintenance: vi.fn(async (_d, _log, op) => op()),
    fileSize: vi.fn(async () => 4),
  };
  return { deps, calls, volumes };
}

const row = async () => (await db.query.databases.findFirst({ where: eq(databases.id, 30) }))!;
const upgradeRow = async (id: number) => (await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, id) }))!;

async function admitAndRun(deps: Deps, to: string) {
  const d = await row();
  const plan = await planUpgrade(db, d, to, deps);
  const admitted = await admitUpgrade(db, d, plan, 7);
  await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: admitted.fromImageTag }, deps);
  return upgradeRow(admitted.id);
}

describe('paths and releases', () => {
  it('MongoDB never skips a release; data behind its binary starts on the binary\'s own release first', () => {
    expect(upgradeSteps('mongo', '6.0', '8.0', '6.0')).toEqual(['7.0', '8.0']);
    expect(upgradeSteps('mongo', '6.0', '8.0')).toEqual(['7.0', '8.0']);
    expect(upgradeSteps('mongo', '6.0', '7.0', '6.0')).toEqual(['7.0']);
    // The binary is 7.0 already and the data still runs 6.0: 7.0 is set on the copy before 8.0 starts on it.
    expect(upgradeSteps('mongo', '7.0', '8.0', '6.0')).toEqual(['7.0', '8.0']);
    expect(upgradeSteps('mongo', '7.0', '8.0', '7.0')).toEqual(['8.0']);
    expect(upgradeSteps('mongo', '5.0', '8.0', '5.0')).toMatch(/older than 6\.0/);
    expect(upgradeSteps('mongo', '8.0', '7.0', '8.0')).toMatch(/newer release/);
    expect(upgradeSteps('mongo', '6.0', '9.0', '6.0')).toMatch(/not a supported target/);
  });

  it('reads the series a row tag names; NULL is the engine default', () => {
    expect(rowSeries('mongo', null)).toBe('8.0');
    expect(rowSeries('mongo', '7.0.14')).toBe('7.0');
    expect(rowSeries('mongo', 'lts')).toBeNull();
  });

  it('options read the running release and offer what it can reach', async () => {
    expect(await upgradeOptions(db, await row(), fakeDeps().deps)).toEqual({ currentMajor: 6, targets: [], currentSeries: '6.0', versions: ['7.0', '8.0'], refusal: null });
    expect(await upgradeOptions(db, await row(), fakeDeps({ fcv: '8.0' }).deps)).toMatchObject({ currentSeries: '6.0', versions: ['7.0', '8.0'] });
  });
});

describe('preflight', () => {
  it('refuses without room for the copy where Docker keeps volumes', async () => {
    await expect(planUpgrade(db, await row(), '8.0', fakeDeps({ free: 1024 }).deps)).rejects.toMatchObject({ code: 'database_upgrade_disk' });
  });

  it('refuses a target that skips nothing it may skip, or is not newer, before anything stops', async () => {
    const { deps, calls } = fakeDeps();
    await expect(planUpgrade(db, await row(), '9.0', deps)).rejects.toMatchObject({ code: 'database_upgrade_target' });
    await expect(planUpgrade(db, await row(), '6.0', deps)).rejects.toMatchObject({ code: 'database_upgrade_target' });
    expect(calls).toEqual([]);
  });
});

describe('the run', () => {
  it('6.0 → 8.0: fence, copy, 7.0 then 8.0 on the copy with the data told each release, verify, switch under the same name', async () => {
    const { deps, calls } = fakeDeps();
    const up = await admitAndRun(deps, '8.0');
    expect(up.error).toBeNull();
    const vol = 'nd-db-logs-data-u1';
    expect(up).toMatchObject({ status: 'completed', switched: true, fromMajor: 6, toMajor: 8, fromSeries: '6.0', toSeries: '8.0', targetVersion: '8.0', previousVersion: '6.0', previousVolume: 'nd-db-logs-data', targetVolume: vol });
    expect(calls).toEqual([
      'pull mongo:7.0',
      'pull mongo:8.0',
      'stop nd-db-logs',
      'isolated nd-dbup-logs-old sha256:old nd-db-logs-data:/data/db',
      'dump nd-dbup-logs-old',
      'clean-stop nd-dbup-logs-old',
      `volume+ ${vol}`,
      `copy nd-db-logs-data ${vol} mongo:7.0 as nd-dbup-logs-copy`,
      `isolated nd-dbup-logs-new mongo:7.0 ${vol}:/data/db`,
      'set 7.0 nd-dbup-logs-new',
      'clean-stop nd-dbup-logs-new',
      `isolated nd-dbup-logs-new mongo:8.0 ${vol}:/data/db`,
      'set 8.0 nd-dbup-logs-new',
      'clean-stop nd-dbup-logs-new',
      `start nd-db-logs v8.0 ${vol}`,
      'bridges web',
    ]);
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', volumeName: vol, containerName: 'nd-db-logs' });
    // Every collection and account is compared, and the record says which release the data ran and runs.
    expect(JSON.parse(up.verification!)).toMatchObject({
      tables: 2, rows: 49, sequences: 0, users: 1, objects: { indexes: 2, views: 1 }, mismatches: [], featureCompatibility: { before: '6.0', after: '8.0' },
    });
    const safety = await db.query.backups.findFirst({ where: eq(backups.id, up.safetyBackupId!) });
    expect(safety).toMatchObject({ databaseId: 30, label: 'pre-upgrade', status: 'completed' });
  });

  it('data that is a release behind its binary: the copy starts on the binary\'s own release first, so that release is set before the next one', async () => {
    await seed('7.0');
    const { deps, calls } = fakeDeps({ binary: '7.0', fcv: '6.0' });
    const plan = await planUpgrade(db, await row(), '8.0', deps);
    expect(plan).toMatchObject({ fromSeries: '7.0', toSeries: '8.0', steps: ['7.0', '8.0'] });
    await admitAndRun(deps, '8.0');
    // 7.0 on the copy (its data still at 6.0), 7.0 set; then 8.0 on it, 8.0 set.
    expect(calls.filter((c) => c.startsWith('isolated nd-dbup-logs-new') || c.startsWith('set ') || c.startsWith('clean-stop nd-dbup-logs-new'))).toEqual([
      'isolated nd-dbup-logs-new mongo:7.0 nd-db-logs-data-u1:/data/db',
      'set 7.0 nd-dbup-logs-new',
      'clean-stop nd-dbup-logs-new',
      'isolated nd-dbup-logs-new mongo:8.0 nd-db-logs-data-u1:/data/db',
      'set 8.0 nd-dbup-logs-new',
      'clean-stop nd-dbup-logs-new',
    ]);
  });

  it('a release the data is not set to fails before the switch; nothing of the old volume was written', async () => {
    const { deps, calls } = fakeDeps({ setReply: 'MongoServerError: Invalid feature compatibility version value' });
    const up = await admitAndRun(deps, '7.0');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('the data directory was not set to MongoDB 7.0');
    expect(up.error).toContain('The database runs on MongoDB 6.0 as before');
    expect(calls.some((c) => c.startsWith('start nd-db-logs v7.0'))).toBe(false);
    expect(calls.includes('start nd-db-logs v6.0 nd-db-logs-data')).toBe(true);
  });

  it('a copy that does not match fails before the switch and names what differs', async () => {
    const { deps, calls } = fakeDeps({ stagingCount: 41 });
    const up = await admitAndRun(deps, '7.0');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('the upgraded copy does not match the old cluster: table app.events: 42 before, 41 after');
    expect(up.switched).toBe(false);
    expect(calls.some((c) => c.startsWith('start nd-db-logs v7.0'))).toBe(false);
  });

  it('a binary that does not start on the copy (the data is two releases behind) fails before the switch', async () => {
    const { deps, calls } = fakeDeps({ failReadyOf: '7.0' });
    const up = await admitAndRun(deps, '7.0');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('MongoDB 7.0 did not come up on the copy');
    expect(calls.some((c) => c.startsWith('set '))).toBe(false);
  });

  it('a fence that does not exit cleanly is never copied', async () => {
    const { deps, calls } = fakeDeps({ fenceExit: 62 });
    const up = await admitAndRun(deps, '7.0');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('did not shut down cleanly (exit code 62)');
    expect(calls.some((c) => c.startsWith('copy '))).toBe(false);
  });

  it('rollback starts the old release on the untouched old volume, whose data still runs the old release', async () => {
    const { deps, calls } = fakeDeps();
    const up = await admitAndRun(deps, '7.0');
    await rollbackDatabaseUpgrade(db, up, 7, deps);
    expect(await row()).toMatchObject({ status: 'running', version: '6.0', volumeName: 'nd-db-logs-data' });
    expect(calls.at(-1)).toBe('bridges web');
    expect(calls.filter((c) => c.startsWith('start '))).toEqual(['start nd-db-logs v7.0 nd-db-logs-data-u1', 'start nd-db-logs v6.0 nd-db-logs-data']);
  });
});
