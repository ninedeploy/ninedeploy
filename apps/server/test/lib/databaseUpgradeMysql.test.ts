import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, createDb, type Database, databaseAttachments, databases, databaseUpgrades, type DB, runMigrations, services, users } from '@ninedeploy/db';

/**
 * O2 for MySQL and MariaDB: the old data directory is copied (after a clean,
 * slow shutdown of the fence) and the new image upgrades the COPY in place.
 * Real migrated SQLite; every Docker call is faked. The fake answers SQL per
 * container: the live server and the fence run the old series, the staging
 * container whatever image the run started it with.
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-db-upgrade-mysql-'));
vi.mock('../../src/config.js', () => ({ config: { paths: { backupsDir: path.join(tmp, 'backups'), dataDir: tmp } } }));
mkdirSync(path.join(tmp, 'backups'), { recursive: true });
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const mod = await import('../../src/lib/databaseUpgrade.js');
const { admitUpgrade, planUpgrade, rollbackDatabaseUpgrade, rowSeries, runDatabaseUpgrade, upgradeOptions, upgradeSteps, recoverInterruptedUpgrades } = mod;
type Deps = typeof mod.databaseUpgradeDeps;

const TAB = String.fromCharCode(9);
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
let db: DB;

async function seed(engine: 'mysql' | 'mariadb', version: string | null) {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 7, email: 'owner@example.com', passwordHash: 'x' });
  await db.insert(services).values({ id: 1, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 7 } as never);
  await db.insert(databases).values({
    id: 20, ownerUserId: 7, name: 'shop', slug: 'shop', engine, status: 'running', version,
    containerName: 'nd-db-shop', internalHost: 'nd-db-shop', volumeName: 'nd-db-shop-data', passwordEncrypted: 'x', username: 'root', dbName: 'app',
  } as never);
  await db.insert(databaseAttachments).values({ serviceId: 1, databaseId: 20, envAlias: 'DATABASE_URL' });
}

beforeEach(async () => {
  await seed('mysql', null);
});

interface Server { rows: string; users: string[] }
const OLD: Server = { rows: '42', users: ['root@%', 'root@localhost', 'app@%', 'mysql.sys@localhost'] };

function fakeDeps(opts: {
  oldVersion?: string;
  native?: string;
  staging?: Partial<Server>;
  fenceExit?: number | null;
  volumeFree?: number;
  failReadyOf?: string;
} = {}) {
  const calls: string[] = [];
  const volumes = new Set(['nd-db-shop-data']);
  const oldVersion = opts.oldVersion ?? '8.0.40';
  let stagingImage = '';
  const NEW: Server = { ...OLD, users: [...OLD.users, 'mysql.infoschema@localhost'], ...opts.staging };
  const versionOf = (container: string) => {
    if (container !== 'nd-dbup-shop-new') return oldVersion;
    const tag = stagingImage.slice(stagingImage.lastIndexOf(':') + 1);
    return `${tag}.1`;
  };
  const deps: Deps = {
    psql: vi.fn(async () => { throw new Error('psql must not run for MySQL'); }),
    sql: vi.fn(async (_d: Database, container: string, sql: string) => {
      const server = container === 'nd-dbup-shop-new' ? NEW : OLD;
      if (sql === 'SELECT VERSION()') return `${versionOf(container)}\n`;
      if (sql === 'SELECT 1') return '1\n';
      if (sql.startsWith('SET GLOBAL')) {
        calls.push(`slow-shutdown ${container}`);
        return '';
      }
      if (sql.includes('mysql_native_password')) return opts.native ?? '';
      if (sql.includes('FROM information_schema.TABLES')) return `${hex('shop')}${TAB}${hex('orders')}\n`;
      if (sql.includes('UNION ALL') || sql.startsWith('SELECT 0, COUNT(*)')) return `0${TAB}${server.rows}\n`;
      if (sql.includes('information_schema.STATISTICS')) return ['3', '2', '1', '0', '1', '0', '1'].join(TAB) + '\n';
      if (sql.includes('FROM mysql.user')) return server.users.map(hex).join('\n') + '\n';
      return '';
    }),
    containerImage: vi.fn(async () => ({ id: 'sha256:old', tag: 'mysql:8.0' })),
    containerRunning: vi.fn(async () => true),
    pull: vi.fn(async (image: string) => { calls.push(`pull ${image}`); }),
    stopAndRemove: vi.fn(async (name: string) => { calls.push(`stop ${name}`); }),
    stopClean: vi.fn(async (name: string) => {
      calls.push(`clean-stop ${name}`);
      return name === 'nd-dbup-shop-old' && opts.fenceExit !== undefined ? opts.fenceExit : 0;
    }),
    runIsolated: vi.fn(async (_d: Database, spec: { name: string; image: string; volume: string; mount: string; env?: Record<string, string> }) => {
      if (spec.name === 'nd-dbup-shop-new') stagingImage = spec.image;
      const env = spec.env && Object.keys(spec.env).length > 0 ? ` ${Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join(',')}` : '';
      calls.push(`isolated ${spec.name} ${spec.image} ${spec.volume}:${spec.mount}${env}`);
    }),
    waitReady: vi.fn(async (container: string) => !(opts.failReadyOf && container === 'nd-dbup-shop-new' && stagingImage.endsWith(opts.failReadyOf))),
    dump: vi.fn(async (d: Database, file: string) => {
      calls.push(`dump ${d.containerName}`);
      writeFileSync(file, 'dump');
    }),
    restore: vi.fn(async () => { throw new Error('restore must not run for MySQL'); }),
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
    freeBytesIn: vi.fn(async () => opts.volumeFree ?? 100 * 1024 ** 3),
    freeBytes: vi.fn(async () => 100 * 1024 ** 3),
    maintenance: vi.fn(async (_d, _log, op) => op()),
    fileSize: vi.fn(async () => 4),
  };
  return { deps, calls, volumes };
}

const row = async () => (await db.query.databases.findFirst({ where: eq(databases.id, 20) }))!;
const upgradeRow = async (id: number) => (await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, id) }))!;

async function admitAndRun(deps: Deps, to: string) {
  const d = await row();
  const plan = await planUpgrade(db, d, to, deps);
  const admitted = await admitUpgrade(db, d, plan, 7);
  await runDatabaseUpgrade(db, admitted.id, { actorId: 7, fromImageTag: admitted.fromImageTag }, deps);
  return upgradeRow(admitted.id);
}

describe('paths and series', () => {
  it('MySQL never skips an LTS series; MariaDB goes straight to the target', () => {
    expect(upgradeSteps('mysql', '8.0', '9.7')).toEqual(['8.4', '9.7']);
    expect(upgradeSteps('mysql', '8.0', '8.4')).toEqual(['8.4']);
    expect(upgradeSteps('mysql', '8.4', '9.7')).toEqual(['9.7']);
    expect(upgradeSteps('mysql', '9.1', '9.7')).toEqual(['9.7']);
    expect(upgradeSteps('mysql', '5.7', '8.4')).toMatch(/older than 8\.0/);
    expect(upgradeSteps('mysql', '9.7', '8.4')).toMatch(/newer release/);
    expect(upgradeSteps('mysql', '8.0', '9.1')).toMatch(/not a supported target/);
    expect(upgradeSteps('mariadb', '10.6', '12.3')).toEqual(['12.3']);
    expect(upgradeSteps('mariadb', '10.5', '11.8')).toMatch(/older than 10\.6/);
    expect(upgradeSteps('mariadb', '11.4', '10.11')).toMatch(/newer release/);
  });

  it('reads the series a row tag names; NULL is the engine default', () => {
    expect(rowSeries('mysql', null)).toBe('9.7');
    expect(rowSeries('mysql', '8.0.36')).toBe('8.0');
    expect(rowSeries('mysql', 'lts')).toBeNull();
    expect(rowSeries('mariadb', '11.4')).toBe('11.4');
    expect(rowSeries('mariadb', null)).toBe('12.3');
  });

  it('options read the running series and offer what it can reach', async () => {
    const opts = await upgradeOptions(db, await row(), fakeDeps().deps);
    expect(opts).toEqual({ currentMajor: 8, targets: [], currentSeries: '8.0', versions: ['8.4', '9.7'], refusal: null });
    const latest = await upgradeOptions(db, await row(), fakeDeps({ oldVersion: '9.7.0' }).deps);
    expect(latest).toMatchObject({ currentSeries: '9.7', versions: [], refusal: { code: 'database_upgrade_latest' } });
  });
});

describe('preflight', () => {
  it('refuses accounts on mysql_native_password when the target is 8.4 or newer', async () => {
    await expect(planUpgrade(db, await row(), '8.4', fakeDeps({ native: 'legacy@%\n' }).deps))
      .rejects.toMatchObject({ code: 'database_upgrade_native_password', message: expect.stringContaining('legacy@%') });
  });

  it('MariaDB keeps mysql_native_password: no such refusal', async () => {
    await seed('mariadb', '10.11');
    const plan = await planUpgrade(db, await row(), '11.8', fakeDeps({ oldVersion: '10.11.9-MariaDB', native: 'legacy@%\n' }).deps);
    expect(plan).toMatchObject({ fromSeries: '10.11', toSeries: '11.8', steps: ['11.8'], toImage: 'mariadb:11.8' });
  });

  it('refuses without room for the copy and the safety dump where Docker keeps volumes', async () => {
    await expect(planUpgrade(db, await row(), '8.4', fakeDeps({ volumeFree: 1024 }).deps)).rejects.toMatchObject({ code: 'database_upgrade_disk' });
  });

  it('refuses an unsupported or older target before anything stops', async () => {
    const { deps, calls } = fakeDeps();
    await expect(planUpgrade(db, await row(), '9.1', deps)).rejects.toMatchObject({ code: 'database_upgrade_target' });
    await expect(planUpgrade(db, await row(), '8.0', deps)).rejects.toMatchObject({ code: 'database_upgrade_target' });
    expect(calls).toEqual([]);
  });
});

describe('the run', () => {
  it('8.0 → 9.7: fence, slow clean shutdown, copy, 8.4 then 9.7 on the copy, verify, switch under the same name', async () => {
    const { deps, calls } = fakeDeps();
    const up = await admitAndRun(deps, '9.7');
    expect(up.error).toBeNull();
    const vol = `nd-db-shop-data-u${up.id}`;
    expect(up).toMatchObject({ status: 'completed', switched: true, fromMajor: 8, toMajor: 9, fromSeries: '8.0', toSeries: '9.7', targetVersion: '9.7', previousVolume: 'nd-db-shop-data', targetVolume: vol });
    // The row had no version (the engine default, 9.7): the way back must name 8.0, never the default.
    expect(up.previousVersion).toBe('8.0');
    expect(calls).toEqual([
      'pull mysql:8.4',
      'pull mysql:9.7',
      'stop nd-db-shop',
      'isolated nd-dbup-shop-old sha256:old nd-db-shop-data:/var/lib/mysql',
      'dump nd-dbup-shop-old',
      'slow-shutdown nd-dbup-shop-old',
      'clean-stop nd-dbup-shop-old',
      `volume+ ${vol}`,
      `copy nd-db-shop-data ${vol} mysql:8.4 as nd-dbup-shop-copy`,
      `isolated nd-dbup-shop-new mysql:8.4 ${vol}:/var/lib/mysql`,
      'slow-shutdown nd-dbup-shop-new',
      'clean-stop nd-dbup-shop-new',
      `isolated nd-dbup-shop-new mysql:9.7 ${vol}:/var/lib/mysql`,
      'clean-stop nd-dbup-shop-new',
      `start nd-db-shop v9.7 ${vol}`,
      'bridges web',
    ]);
    expect(await row()).toMatchObject({ status: 'running', version: '9.7', volumeName: vol, containerName: 'nd-db-shop' });
    const safety = await db.query.backups.findFirst({ where: eq(backups.id, up.safetyBackupId!) });
    expect(safety).toMatchObject({ databaseId: 20, label: 'pre-upgrade', status: 'completed' });
    // The image added an account; every account from before is still there.
    expect(JSON.parse(up.verification!)).toMatchObject({ tables: 1, rows: 42, users: 4, objects: { indexes: 3, events: 0, schemas: 1 }, mismatches: [] });
  });

  it('a fence that does not exit cleanly is never copied; the old server starts on its own series', async () => {
    const { deps, calls, volumes } = fakeDeps({ fenceExit: 137 });
    const up = await admitAndRun(deps, '8.4');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('did not shut down cleanly (exit code 137)');
    expect(up.error).toContain('runs on MySQL 8.0 as before');
    expect(calls.some((c) => c.startsWith('copy '))).toBe(false);
    expect(volumes.has(`nd-db-shop-data-u${up.id}`)).toBe(false);
    expect(calls.at(-2)).toBe('start nd-db-shop v8.0 nd-db-shop-data');
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', volumeName: 'nd-db-shop-data' });
  });

  it('an account missing after the upgrade is a mismatch: the copy goes, the old server starts', async () => {
    const { deps, calls, volumes } = fakeDeps({ staging: { users: ['root@%', 'root@localhost', 'mysql.sys@localhost'] } });
    const up = await admitAndRun(deps, '8.4');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('account app@% is missing after the upgrade');
    expect(volumes.has(`nd-db-shop-data-u${up.id}`)).toBe(false);
    expect(calls).toContain(`volume- nd-db-shop-data-u${up.id}`);
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', volumeName: 'nd-db-shop-data' });
  });

  it('a row count that differs after the upgrade stops the switch', async () => {
    const { deps } = fakeDeps({ staging: { rows: '41' } });
    const up = await admitAndRun(deps, '8.4');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('table shop.orders: 42 before, 41 after');
  });

  it('a copy that fails is removed by name before its volume', async () => {
    const { deps, calls } = fakeDeps();
    vi.mocked(deps.copyVolume).mockRejectedValueOnce(new Error('timed out after 21600000 ms'));
    const up = await admitAndRun(deps, '8.4');
    expect(up.status).toBe('failed');
    expect(up.error).toContain('timed out');
    expect(calls.indexOf('stop nd-dbup-shop-copy')).toBeGreaterThan(-1);
    expect(calls.indexOf('stop nd-dbup-shop-copy')).toBeLessThan(calls.indexOf(`volume- nd-db-shop-data-u${up.id}`));
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', volumeName: 'nd-db-shop-data' });
  });

  it('a step that does not come up on the copy fails before the switch', async () => {
    const { deps } = fakeDeps({ failReadyOf: '9.7' });
    const up = await admitAndRun(deps, '9.7');
    expect(up.status).toBe('failed');
    expect(up.switched).toBe(false);
    expect(up.error).toContain('MySQL 9.7 did not come up on the copy');
    expect(await row()).toMatchObject({ version: '8.0', volumeName: 'nd-db-shop-data' });
  });

  it('MariaDB: one step, the image upgrades the copy itself (MARIADB_AUTO_UPGRADE)', async () => {
    await seed('mariadb', '10.11');
    const { deps, calls } = fakeDeps({ oldVersion: '10.11.9-MariaDB-ubu2204' });
    const up = await admitAndRun(deps, '11.8');
    expect(up.error).toBeNull();
    expect(up).toMatchObject({ status: 'completed', fromSeries: '10.11', toSeries: '11.8', previousVersion: '10.11' });
    expect(calls).toContain(`isolated nd-dbup-shop-new mariadb:11.8 nd-db-shop-data-u${up.id}:/var/lib/mysql MARIADB_AUTO_UPGRADE=1`);
    expect(await row()).toMatchObject({ version: '11.8' });
  });
});

describe('after the run', () => {
  it('rollback starts the old series on the untouched old volume', async () => {
    const { deps, calls } = fakeDeps();
    const up = await admitAndRun(deps, '8.4');
    calls.length = 0;
    await rollbackDatabaseUpgrade(db, up, 7, deps);
    expect(calls).toEqual(['stop nd-db-shop', 'start nd-db-shop v8.0 nd-db-shop-data', 'bridges web']);
    expect(await row()).toMatchObject({ status: 'running', version: '8.0', volumeName: 'nd-db-shop-data' });
  });

  it('boot recovery before the switch starts 8.0, never the 9.7 default, and drops the copy', async () => {
    const { deps, calls, volumes } = fakeDeps();
    const d = await row();
    const admitted = await admitUpgrade(db, d, await planUpgrade(db, d, '8.4', deps), 7);
    volumes.add(admitted.targetVolume);
    vi.mocked(deps.containerRunning).mockResolvedValue(false);
    calls.length = 0;
    await recoverInterruptedUpgrades(db, deps);
    expect(calls).toContain('start nd-db-shop v8.0 nd-db-shop-data');
    // A copy the restart cut short may still run: it goes before its volume does.
    expect(calls.indexOf('stop nd-dbup-shop-copy')).toBeGreaterThan(-1);
    expect(calls.indexOf('stop nd-dbup-shop-copy')).toBeLessThan(calls.indexOf(`volume- ${admitted.targetVolume}`));
    expect((await upgradeRow(admitted.id)).status).toBe('failed');
  });
});
