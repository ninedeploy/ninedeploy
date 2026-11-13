import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, createDb, type Database, databaseAttachments, databases, databaseUpgrades, type DB, runMigrations, services, users } from '@ninedeploy/db';

/**
 * O2: a major PostgreSQL upgrade by dump and restore into a new volume. Real
 * migrated SQLite; every Docker call is faked. The fake keeps three clusters
 * apart — the live container, the fence (old image, old volume, no network)
 * and the staging copy (new image, new volume, no network) — so the tests can
 * make the copy differ from the original and watch what the run does.
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-db-upgrade-'));
vi.mock('../../src/config.js', () => ({ config: { paths: { backupsDir: path.join(tmp, 'backups'), dataDir: tmp } } }));
mkdirSync(path.join(tmp, 'backups'), { recursive: true });
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const mod = await import('../../src/lib/databaseUpgrade.js');
const {
  admitUpgrade, assertNoRunningUpgrade, compareFingerprints, finalizeDatabaseUpgrade, planUpgrade, pruneFinishedUpgrades,
  recoverInterruptedUpgrades, rollbackDatabaseUpgrade, runDatabaseUpgrade, upgradeOptions, upgradeRefusal, upgradeTargets,
} = mod;
type Deps = typeof mod.databaseUpgradeDeps;

const SEP = '\u001f';
let db: DB;

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 7, email: 'owner@example.com', passwordHash: 'x' });
  await db.insert(services).values({ id: 1, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 7 } as never);
  await db.insert(databases).values({
    id: 10, ownerUserId: 7, name: 'orders', slug: 'orders', engine: 'postgres', status: 'running', version: '16',
    containerName: 'nd-db-orders', internalHost: 'nd-db-orders', volumeName: 'nd-db-orders-data', passwordEncrypted: 'x', username: 'nine', dbName: 'app',
  } as never);
  await db.insert(databaseAttachments).values({ serviceId: 1, databaseId: 10, envAlias: 'DATABASE_URL' });
});

interface Cluster { version: string; rows: string; seq: string; objects: string }
const OLD: Cluster = { version: '160004', rows: `public.orders${SEP}42`, seq: `public.orders_id_seq${SEP}42`, objects: ['3', '2', '0', '0', '1', 'plpgsql'].join(SEP) };

function fakeDeps(opts: { staging?: Partial<Cluster>; otherDatabases?: string; otherRoles?: string; postgresDbTables?: string; free?: number; failPull?: boolean; failStartOf?: string; volumes?: string[] } = {}) {
  const calls: string[] = [];
  const volumes = new Set(opts.volumes ?? ['nd-db-orders-data']);
  const NEW: Cluster = { ...OLD, version: '180001', ...opts.staging };
  const clusterOf = (container: string): Cluster => (container === 'nd-dbup-orders-new' ? NEW : OLD);
  let startCount = 0;
  const deps: Deps = {
    psql: vi.fn(async (container: string, sql: string, o?: { database?: string }) => {
      const c = clusterOf(container);
      if (sql.includes('server_version_num')) return `${c.version}\n`;
      if (sql.includes('pg_database_size')) return '1000\n';
      if (sql.includes('FROM pg_database')) return opts.otherDatabases ?? '';
      if (sql.includes('FROM pg_roles')) return opts.otherRoles ?? '';
      if (o?.database === 'postgres') return `${opts.postgresDbTables ?? '0'}\n`;
      if (sql.includes('query_to_xml')) return `${c.rows}\n`;
      if (sql.includes('pg_sequences')) return `${c.seq}\n`;
      if (sql.includes('pg_extension')) return `${c.objects}\n`;
      return '';
    }),
    containerImage: vi.fn(async () => ({ id: 'sha256:old', tag: 'postgres:16' })),
    containerRunning: vi.fn(async () => true),
    pull: vi.fn(async (image: string) => {
      calls.push(`pull ${image}`);
      if (opts.failPull) throw new Error('pull denied');
    }),
    stopAndRemove: vi.fn(async (name: string) => { calls.push(`stop ${name}`); }),
    runIsolated: vi.fn(async (_d: Database, spec: { name: string; image: string; volume: string; mount: string }) => {
      calls.push(`isolated ${spec.name} ${spec.image} ${spec.volume}:${spec.mount}`);
    }),
    waitReady: vi.fn(async () => true),
    dump: vi.fn(async (d: Database, file: string) => {
      calls.push(`dump ${d.containerName}`);
      writeFileSync(file, 'dump');
    }),
    restore: vi.fn(async (d: Database) => { calls.push(`restore ${d.containerName} v${d.version}`); }),
    createVolume: vi.fn(async (name: string, labels: Record<string, string>) => {
      calls.push(`volume+ ${name} ${labels['ninedeploy.database.image']}`);
      volumes.add(name);
    }),
    volumeExists: vi.fn(async (name: string) => volumes.has(name)),
    removeVolume: vi.fn(async (name: string) => {
      calls.push(`volume- ${name}`);
      volumes.delete(name);
      return true;
    }),
    start: vi.fn(async (d: Database) => {
      startCount++;
      calls.push(`start ${d.containerName} v${d.version} ${d.volumeName}`);
      if (opts.failStartOf && d.volumeName === opts.failStartOf) throw new Error(`start #${startCount} failed`);
    }),
    attachBridges: vi.fn(async (_d: Database, slugs: string[]) => { calls.push(`bridges ${slugs.join(',')}`); }),
    freeBytes: vi.fn(async () => opts.free ?? 100 * 1024 ** 3),
    maintenance: vi.fn(async (_d, _log, op) => op()),
    fileSize: vi.fn(async () => 4),
  };
  return { deps, calls, volumes };
}

const row = async () => (await db.query.databases.findFirst({ where: eq(databases.id, 10) }))!;
const upgradeRow = async (id: number) => (await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, id) }))!;

async function admitAndRun(deps: Deps, toMajor = 18) {
  const d = await row();
  const plan = await planUpgrade(db, d, toMajor, deps);
  const admitted = await admitUpgrade(db, d, plan, 7);
  await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: admitted.fromImageTag }, deps);
  return upgradeRow(admitted.id);
}

describe('refusals before anything stops', () => {
  it('offers PostgreSQL, MySQL and MariaDB on the panel host only, and not pgvector, preview copies or PITR', async () => {
    const base = await row();
    expect(upgradeRefusal(base)).toBeNull();
    expect(upgradeRefusal({ ...base, serverId: 3 })?.code).toBe('database_upgrade_node');
    expect(upgradeRefusal({ ...base, engine: 'mysql' })).toBeNull();
    expect(upgradeRefusal({ ...base, engine: 'mongo' })?.code).toBe('database_upgrade_engine');
    expect(upgradeRefusal({ ...base, version: 'vector' })?.code).toBe('database_upgrade_pgvector');
    expect(upgradeRefusal({ ...base, previewCopyOf: 2 })?.code).toBe('database_upgrade_preview');
    expect(upgradeRefusal({ ...base, pitrEnabled: true })?.code).toBe('database_upgrade_pitr');
  });

  it('reads the major from the running cluster, not the row tag, and offers only newer ones', async () => {
    const { deps } = fakeDeps();
    expect(upgradeTargets(16)).toEqual([17, 18]);
    // The row says nothing (engine default); the cluster says 16.
    await db.update(databases).set({ version: null }).where(eq(databases.id, 10));
    const opts = await upgradeOptions(db, await row(), deps);
    expect(opts).toEqual({ currentMajor: 16, targets: [17, 18], currentSeries: '16', versions: ['17', '18'], refusal: null });
    await expect(planUpgrade(db, await row(), 16, deps)).rejects.toMatchObject({ code: 'database_upgrade_target' });
    await expect(planUpgrade(db, await row(), 19, deps)).rejects.toMatchObject({ code: 'database_upgrade_target' });
  });

  it('refuses what the dump would not carry over: other databases, other roles, objects in the postgres database', async () => {
    await expect(planUpgrade(db, await row(), 18, fakeDeps({ otherDatabases: 'analytics\n' }).deps)).rejects.toMatchObject({ code: 'database_upgrade_other_databases' });
    await expect(planUpgrade(db, await row(), 18, fakeDeps({ otherRoles: 'reporter\n' }).deps)).rejects.toMatchObject({ code: 'database_upgrade_other_roles' });
    await expect(planUpgrade(db, await row(), 18, fakeDeps({ postgresDbTables: '2' }).deps)).rejects.toMatchObject({ code: 'database_upgrade_postgres_db' });
  });

  it('refuses without room for the dump and the new volume', async () => {
    await expect(planUpgrade(db, await row(), 18, fakeDeps({ free: 1024 }).deps)).rejects.toMatchObject({ code: 'database_upgrade_disk' });
  });

  it('refuses a second upgrade while one runs or still keeps the previous volume', async () => {
    const { deps } = fakeDeps();
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, 17, deps), 7);
    await expect(planUpgrade(db, d, 18, deps)).rejects.toMatchObject({ code: 'database_upgrade_running' });
    await expect(assertNoRunningUpgrade(db, 10)).rejects.toMatchObject({ statusCode: 409 });
    await db.update(databaseUpgrades).set({ status: 'completed' }).where(eq(databaseUpgrades.id, admitted.id));
    await expect(planUpgrade(db, d, 18, deps)).rejects.toMatchObject({ code: 'database_upgrade_unfinalized' });
    await expect(assertNoRunningUpgrade(db, 10)).resolves.toBeUndefined();
  });
});

describe('the run', () => {
  it('fences the old cluster, restores into a new volume, verifies, then switches under the same container name', async () => {
    const { deps, calls } = fakeDeps();
    const up = await admitAndRun(deps);
    expect(up.error).toBeNull();
    expect(up).toMatchObject({ status: 'completed', switched: true, fromMajor: 16, toMajor: 18, previousVolume: 'nd-db-orders-data', targetVolume: `nd-db-orders-data-u${up.id}` });
    expect(calls).toEqual([
      'pull postgres:18',
      'stop nd-db-orders',
      // The fence runs the OLD container's own image, on the old volume, at the pre-18 mount.
      'isolated nd-dbup-orders-old sha256:old nd-db-orders-data:/var/lib/postgresql/data',
      'dump nd-dbup-orders-old',
      'stop nd-dbup-orders-old',
      `volume+ nd-db-orders-data-u${up.id} postgres:18`,
      // PostgreSQL 18 mounts the volume one level up (engine/database.ts postgresClusterLayout).
      `isolated nd-dbup-orders-new postgres:18 nd-db-orders-data-u${up.id}:/var/lib/postgresql`,
      'restore nd-dbup-orders-new v18',
      'stop nd-dbup-orders-new',
      `start nd-db-orders v18 nd-db-orders-data-u${up.id}`,
      'bridges web',
    ]);
    const d = await row();
    expect(d).toMatchObject({ status: 'running', version: '18', volumeName: `nd-db-orders-data-u${up.id}`, containerName: 'nd-db-orders', internalHost: 'nd-db-orders' });
    const safety = await db.query.backups.findFirst({ where: eq(backups.id, up.safetyBackupId!) });
    expect(safety).toMatchObject({ databaseId: 10, scope: 'db', label: 'pre-upgrade', status: 'completed' });
    expect(JSON.parse(up.verification!)).toMatchObject({ tables: 1, rows: 42, sequences: 1, mismatches: [] });
  });

  it('a copy that does not match never gets switched to: the new volume goes and the old cluster starts as it was', async () => {
    const { deps, calls, volumes } = fakeDeps({ staging: { rows: `public.orders${SEP}41` } });
    const up = await admitAndRun(deps);
    expect(up.status).toBe('failed');
    expect(up.error).toContain('table public.orders: 42 before, 41 after');
    expect(up.error).toContain('runs on PostgreSQL 16 as before');
    expect(calls).toContain(`volume- nd-db-orders-data-u${up.id}`);
    expect(calls.at(-2)).toBe('start nd-db-orders v16 nd-db-orders-data');
    expect(volumes.has(`nd-db-orders-data-u${up.id}`)).toBe(false);
    expect(await row()).toMatchObject({ status: 'running', version: '16', volumeName: 'nd-db-orders-data' });
  });

  it('a new cluster that does not start after the switch is pointed back', async () => {
    const { deps, calls } = fakeDeps({ failStartOf: 'nd-db-orders-data-u1' });
    const up = await admitAndRun(deps);
    expect(up.id).toBe(1);
    expect(up).toMatchObject({ status: 'failed', switched: false });
    expect(calls).toContain('start nd-db-orders v18 nd-db-orders-data-u1');
    // The new cluster was on the network: it may hold writes, so its volume stays.
    expect(calls).not.toContain('volume- nd-db-orders-data-u1');
    expect(up.error).toContain('nd-db-orders-data-u1 is kept');
    expect(calls.at(-2)).toBe('start nd-db-orders v16 nd-db-orders-data');
    expect(await row()).toMatchObject({ status: 'running', version: '16', volumeName: 'nd-db-orders-data' });
  });

  it('a failure to join the service bridges after the switch does not undo it', async () => {
    const { deps } = fakeDeps();
    deps.attachBridges = vi.fn(async () => { throw new Error('network gone'); });
    const up = await admitAndRun(deps);
    expect(up.status).toBe('completed');
    expect(await row()).toMatchObject({ status: 'running', version: '18' });
  });

  it('a row with no version on a 16 cluster goes back to 16, never to the engine default', async () => {
    // NULL follows the engine default (18): starting that on 16 data crash-loops.
    await db.update(databases).set({ version: null }).where(eq(databases.id, 10));
    const { deps, calls } = fakeDeps({ staging: { rows: `public.orders${SEP}41` } });
    const up = await admitAndRun(deps);
    expect(up).toMatchObject({ status: 'failed', previousVersion: '16' });
    expect(calls.at(-2)).toBe('start nd-db-orders v16 nd-db-orders-data');
    expect(await row()).toMatchObject({ status: 'running', version: '16' });
  });

  it('a rollback from a row that had no version starts 16', async () => {
    await db.update(databases).set({ version: null }).where(eq(databases.id, 10));
    const { deps, calls } = fakeDeps();
    const up = await admitAndRun(deps);
    expect(up.previousVersion).toBe('16');
    calls.length = 0;
    await rollbackDatabaseUpgrade(db, up, 7, deps);
    expect(calls).toContain('start nd-db-orders v16 nd-db-orders-data');
    expect((await row()).version).toBe('16');
  });

  it('a row whose tag matches the cluster keeps its tag', async () => {
    const { deps } = fakeDeps();
    await db.update(databases).set({ version: '16.4' }).where(eq(databases.id, 10));
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, 18, deps), 7);
    expect(admitted.previousVersion).toBe('16.4');
  });

  it('a failed pull stops nothing', async () => {
    const { deps, calls } = fakeDeps({ failPull: true });
    const up = await admitAndRun(deps);
    expect(up.status).toBe('failed');
    expect(up.error).toContain('Nothing was stopped');
    expect(calls).toEqual(['pull postgres:18']);
    expect((await row()).status).toBe('running');
  });

  it('a database that changed between admission and the lock is not upgraded from the stale plan', async () => {
    const { deps, calls } = fakeDeps();
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, 18, deps), 7);
    await db.update(databases).set({ volumeName: 'nd-db-orders-other' }).where(eq(databases.id, 10));
    await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: 'postgres:16' }, deps);
    expect((await upgradeRow(admitted.id)).status).toBe('failed');
    expect(calls).toEqual([]);
  });
});

describe('rollback and finalize', () => {
  it('rollback points the row back at the previous volume; finalizing that rollback deletes the upgraded volume', async () => {
    const { deps, calls } = fakeDeps();
    const up = await admitAndRun(deps);
    calls.length = 0;
    await rollbackDatabaseUpgrade(db, up, 7, deps);
    expect(calls).toEqual(['stop nd-db-orders', 'start nd-db-orders v16 nd-db-orders-data', 'bridges web']);
    expect(await row()).toMatchObject({ status: 'running', version: '16', volumeName: 'nd-db-orders-data' });
    const rolled = await upgradeRow(up.id);
    expect(rolled.status).toBe('rolled_back');
    await expect(rollbackDatabaseUpgrade(db, rolled, 7, deps)).rejects.toMatchObject({ code: 'database_upgrade_state' });
    expect(await finalizeDatabaseUpgrade(db, rolled, 7, deps)).toEqual({ removedVolume: `nd-db-orders-data-u${up.id}` });
    expect((await upgradeRow(up.id)).status).toBe('finalized');
  });

  it('finalize after a completed upgrade deletes the previous volume, never the one in use', async () => {
    const { deps, volumes } = fakeDeps();
    const up = await admitAndRun(deps);
    expect(await finalizeDatabaseUpgrade(db, up, 7, deps)).toEqual({ removedVolume: 'nd-db-orders-data' });
    expect(volumes.has('nd-db-orders-data')).toBe(false);
    expect(volumes.has(`nd-db-orders-data-u${up.id}`)).toBe(true);
    // A volume still mounted somewhere is reported, and the upgrade stays open.
    const { deps: busy } = fakeDeps({ volumes: ['nd-db-orders-data', `nd-db-orders-data-u${up.id}`] });
    await db.update(databaseUpgrades).set({ status: 'completed' }).where(eq(databaseUpgrades.id, up.id));
    busy.removeVolume = vi.fn(async () => false);
    await expect(finalizeDatabaseUpgrade(db, await upgradeRow(up.id), 7, busy)).rejects.toMatchObject({ code: 'database_upgrade_volume_busy' });
    expect((await upgradeRow(up.id)).status).toBe('completed');
  });

  it('finalize and rollback act on the state under the lock, never on a stale copy', async () => {
    const { deps, volumes } = fakeDeps();
    const stale = await admitAndRun(deps);
    expect(stale.status).toBe('completed');
    await rollbackDatabaseUpgrade(db, stale, 7, deps);
    // A finalize sent with the pre-rollback copy must delete the UPGRADED
    // volume (now unused), never the previous one the row points at again.
    expect(await finalizeDatabaseUpgrade(db, stale, 7, deps)).toEqual({ removedVolume: `nd-db-orders-data-u${stale.id}` });
    expect(volumes.has('nd-db-orders-data')).toBe(true);
    // And a rollback sent with that copy after the finalize is refused.
    await expect(rollbackDatabaseUpgrade(db, stale, 7, deps)).rejects.toMatchObject({ code: 'database_upgrade_state' });
    expect(deps.maintenance).toHaveBeenCalledTimes(4);
  });

  it('rollback is refused while PITR is on', async () => {
    const { deps } = fakeDeps();
    const up = await admitAndRun(deps);
    await db.update(databases).set({ pitrEnabled: true }).where(eq(databases.id, 10));
    await expect(rollbackDatabaseUpgrade(db, up, 7, deps)).rejects.toMatchObject({ code: 'database_upgrade_pitr' });
  });
});

describe('boot recovery and retention', () => {
  it('an upgrade interrupted before the switch: helpers and the new volume go, the old cluster starts', async () => {
    const { deps, calls, volumes } = fakeDeps();
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, 18, deps), 7);
    volumes.add(admitted.targetVolume);
    await db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, 10));
    deps.containerRunning = vi.fn(async () => false);
    expect(await recoverInterruptedUpgrades(db, deps)).toBe(1);
    expect(calls).toEqual([
      'stop nd-dbup-orders-old', 'stop nd-dbup-orders-new', `volume- ${admitted.targetVolume}`,
      'start nd-db-orders v16 nd-db-orders-data', 'bridges web',
    ]);
    expect(await row()).toMatchObject({ status: 'running', volumeName: 'nd-db-orders-data' });
    expect((await upgradeRow(admitted.id))).toMatchObject({ status: 'failed' });
    expect((await upgradeRow(admitted.id)).error).toContain('interrupted by a panel restart');
  });

  it('boot recovery of a row with no version starts the major it really ran', async () => {
    await db.update(databases).set({ version: null }).where(eq(databases.id, 10));
    const { deps, calls } = fakeDeps();
    const d = await row();
    await admitUpgrade(db, d, await planUpgrade(db, d, 18, deps), 7);
    await db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, 10));
    deps.containerRunning = vi.fn(async () => false);
    await recoverInterruptedUpgrades(db, deps);
    expect(calls).toContain('start nd-db-orders v16 nd-db-orders-data');
  });

  it('an upgraded cluster that does not start at boot is pointed back, its volume kept', async () => {
    const { deps, calls } = fakeDeps({ failStartOf: 'nd-db-orders-data-u1' });
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, 18, deps), 7);
    await db.update(databases).set({ status: 'stopped', version: '18', volumeName: admitted.targetVolume }).where(eq(databases.id, 10));
    await db.update(databaseUpgrades).set({ switched: true }).where(eq(databaseUpgrades.id, admitted.id));
    deps.containerRunning = vi.fn(async () => false);
    await recoverInterruptedUpgrades(db, deps);
    expect(calls).not.toContain(`volume- ${admitted.targetVolume}`);
    expect(calls.at(-2)).toBe('start nd-db-orders v16 nd-db-orders-data');
    expect((await upgradeRow(admitted.id)).error).toContain(`${admitted.targetVolume} is kept`);
  });

  it('switched, but the row names another volume: recovery deletes nothing', async () => {
    const { deps, calls } = fakeDeps({ volumes: ['nd-db-orders-data', 'nd-db-orders-data-u1'] });
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, 18, deps), 7);
    await db.update(databaseUpgrades).set({ switched: true }).where(eq(databaseUpgrades.id, admitted.id));
    await recoverInterruptedUpgrades(db, deps);
    expect(calls.some((c) => c.startsWith('volume-'))).toBe(false);
    expect((await upgradeRow(admitted.id)).error).toContain('nothing was deleted');
  });

  it('an upgrade interrupted after the switch gets its start; the verified copy stays', async () => {
    const { deps, calls } = fakeDeps();
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, 18, deps), 7);
    await db.update(databases).set({ status: 'stopped', version: '18', volumeName: admitted.targetVolume }).where(eq(databases.id, 10));
    await db.update(databaseUpgrades).set({ switched: true }).where(eq(databaseUpgrades.id, admitted.id));
    await recoverInterruptedUpgrades(db, deps);
    expect(calls).toContain(`start nd-db-orders v18 ${admitted.targetVolume}`);
    expect(await upgradeRow(admitted.id)).toMatchObject({ status: 'completed' });
    expect(await row()).toMatchObject({ status: 'running', volumeName: admitted.targetVolume });
  });

  it('prunes old failed and finalized records, never one that still holds a volume', async () => {
    const { deps } = fakeDeps();
    const d = await row();
    const ids: number[] = [];
    for (const status of ['failed', 'finalized', 'completed', 'rolled_back'] as const) {
      const a = await admitUpgrade(db, d, await planUpgrade(db, d, 18, deps).catch(() => ({ facts: { major: 16, sizeBytes: 0, otherDatabases: [], otherRoles: [], tablesInPostgresDb: 0 }, fromImage: { id: 'x', tag: 'postgres:16' }, toImage: 'postgres:18', targetVersion: '18', fromSeries: '16', toSeries: '18', steps: ['18'] })), 7);
      await db.update(databaseUpgrades).set({ status, completedAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(databaseUpgrades.id, a.id));
      ids.push(a.id);
    }
    expect(await pruneFinishedUpgrades(db)).toBe(2);
    expect((await db.query.databaseUpgrades.findMany()).map((r) => r.status).sort()).toEqual(['completed', 'rolled_back']);
  });
});

describe('fingerprint comparison', () => {
  it('names every difference', () => {
    const a = { rows: { 'public.a': '1', 'public.b': '2' }, sequences: { 'public.s': '5' }, objects: { indexes: 1, constraints: 1, views: 0, triggers: 0, functions: 0, extensions: 'plpgsql' } };
    expect(compareFingerprints(a, a)).toEqual([]);
    expect(compareFingerprints(a, { ...a, rows: { 'public.a': '1', 'public.c': '0' }, objects: { ...a.objects, extensions: 'plpgsql,vector' } })).toEqual([
      'table public.b is missing after the restore',
      'table public.c appeared after the restore',
      'extensions: plpgsql before, plpgsql,vector after',
    ]);
  });
});
