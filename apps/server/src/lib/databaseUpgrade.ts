/**
 * O2 (competitive roadmap): a one-click major-version upgrade of a managed
 * database on the panel host into a NEW volume; PostgreSQL by dump and restore.
 *
 * The order is what keeps it safe:
 *  1. preflight against the RUNNING cluster, before any downtime: its real
 *     major (`server_version_num`, not the row's tag), nothing the dump would
 *     leave behind (another database in the cluster, another role, tables in
 *     the `postgres` database), and room on disk;
 *  2. pull the target image, still before any downtime;
 *  3. stop the container, then dump through a FENCE: the old container's own
 *     image on the old volume with no network, so nothing writes after the
 *     dump; the dump is kept as a `pre-upgrade` backup;
 *  4. restore into a STAGING copy (new image, new volume, no network) and
 *     compare it to the old cluster: every user table's exact row count, every
 *     sequence, and the count of indexes, constraints, views, triggers,
 *     functions and the extension list;
 *  5. only then switch the row (`version`, `volume_name`) and start the
 *     container under the SAME name, so every attached service, PgBouncer and
 *     Studio keep their hostname and password.
 *
 * Any failure before the switch removes the new volume and starts the old
 * cluster as it was. A failed start after the switch points the row back. The
 * previous volume stays until the upgrade is finalized; until then a rollback
 * points the row back at it (writes made since the upgrade stay on the new
 * volume, which a later finalize of the rollback deletes).
 *
 * MySQL and MariaDB move by COPY instead (`method: 'copy'` below): a dump of
 * every database carries the `mysql` system schema, and loading that into
 * another series is the path both projects say not to take. The fence takes
 * the fingerprint and the safety dump, then shuts down slowly
 * (`innodb_fast_shutdown = 0`) and must exit cleanly; its data directory is
 * copied into the new volume, and the new image upgrades the COPY in place on
 * start (MySQL's `--upgrade=AUTO`; MariaDB's `MARIADB_AUTO_UPGRADE`). Users
 * and grants come along as they are. MySQL never skips an LTS series, so 8.0
 * reaches 9.x through an 8.4 step on the same copy. The old volume is never
 * written to, which is what makes the rollback possible: neither server can
 * downgrade a data directory.
 */
import { mkdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { backups, databaseAttachments, databases, databaseUpgrades, type Database, type DatabaseUpgrade, type DB } from '@ninedeploy/db';
import { config } from '../config.js';
import { audit } from './audit.js';
import { badRequest, conflict, HttpError } from './errors.js';
import { capture, run } from './exec.js';
import { createLogger } from './log.js';
import { pullDockerImage } from './dockerPull.js';
import { decrypt } from './crypto.js';
import {
  copyDockerVolume,
  createDockerVolume,
  databaseVolumeLabels,
  dumpDatabaseHeld,
  ENGINES,
  postgresMajor,
  postgresMountForImage,
  resolveVolumePath,
  restoreDatabaseHeld,
  runIsolatedDatabase,
  startDatabase,
  stopContainerClean,
  attachDatabaseToServiceBridges,
  volumeExists,
  waitForPostgresTcp,
  withDatabaseMaintenance,
} from '../engine/database.js';

const logger = createLogger('database-upgrade');

/** The PostgreSQL majors an upgrade can target. The newest is the engine default. */
export const POSTGRES_UPGRADE_MAJORS = [14, 15, 16, 17, 18] as const;
/** Headroom kept free on top of the dump and the new volume. */
const FREE_SPACE_MARGIN_BYTES = 1024 * 1024 * 1024;
/** psql field separator (ASCII unit separator: never part of a name in practice). */
const SEP = '\u001f';
const SYSTEM_SCHEMAS = `('pg_catalog','information_schema')`;

export type UpgradePhase = 'pull' | 'stop' | 'dump' | 'copy' | 'upgrade' | 'restore' | 'verify' | 'switch' | 'start';

export interface ClusterFingerprint {
  /** `schema.table` → exact row count, user tables only (extension-owned excluded). */
  rows: Record<string, string>;
  /** `schema.sequence` → last_value (`null` when never called). */
  sequences: Record<string, string>;
  /** MySQL/MariaDB add `events` (scheduled events) and `schemas` (user databases). */
  objects: { indexes: number; constraints: number; views: number; triggers: number; functions: number; extensions: string; events?: number; schemas?: number };
  /** MySQL/MariaDB: every account (`user@host`). Each must still exist after; the new image may add its own. */
  users?: string[];
}

export interface UpgradeVerification {
  tables: number;
  rows: number;
  sequences: number;
  objects: ClusterFingerprint['objects'];
  users?: number;
}

/** The engines a major upgrade is offered for. */
export type UpgradeEngine = 'postgres' | 'mysql' | 'mariadb';

interface EngineUpgradeSpec {
  label: string;
  /** `dump`: dump and restore into an empty cluster. `copy`: copy the stopped data directory and upgrade the copy in place. */
  method: 'dump' | 'copy';
  /** The series an upgrade can target, oldest first. The newest is the engine default. */
  targets: readonly string[];
  /** Below this series a copy upgrade is refused (older images lack what it relies on). */
  floor?: string;
}

/**
 * MySQL: 8.4 is the LTS, 9.7 the Innovation release the engine defaults to.
 * MariaDB: the LTS releases and the default. Every target must be a tag the
 * engine's image factory resolves (`mysql:8.4`, `mariadb:11.8`).
 */
export const UPGRADE_ENGINES: Record<UpgradeEngine, EngineUpgradeSpec> = {
  postgres: { label: 'PostgreSQL', method: 'dump', targets: ['14', '15', '16', '17', '18'] },
  mysql: { label: 'MySQL', method: 'copy', targets: ['8.4', '9.7'], floor: '8.0' },
  mariadb: { label: 'MariaDB', method: 'copy', targets: ['10.11', '11.4', '11.8', '12.3'], floor: '10.6' },
};

const MYSQL_DATA_DIR = '/var/lib/mysql';
/** MySQL's own accounts, present in every 8.x and 9.x data directory. */
const MYSQL_SYSTEM_USERS = `('mysql.sys','mysql.session','mysql.infoschema')`;
const MYSQL_SYSTEM_SCHEMAS = `('mysql','information_schema','performance_schema','sys')`;

export const isUpgradeEngine = (engine: string): engine is UpgradeEngine => Object.hasOwn(UPGRADE_ENGINES, engine);
export const engineLabel = (engine: string) => (isUpgradeEngine(engine) ? UPGRADE_ENGINES[engine].label : engine);

/** `8.0.36` → [8, 0]; null when the text does not start with a version. */
function seriesParts(v: string): [number, number] | null {
  const m = v.trim().match(/^(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), m[2] === undefined ? 0 : Number(m[2])] : null;
}

/** Negative when a is the older series. PostgreSQL series are single numbers. */
export function compareSeries(a: string, b: string): number {
  const pa = seriesParts(a) ?? [0, 0];
  const pb = seriesParts(b) ?? [0, 0];
  return pa[0] - pb[0] || pa[1] - pb[1];
}

/** The series a server version string belongs to: `16`, `8.4`, `11.4`. */
export function seriesOf(engine: string, serverVersion: string): string | null {
  const p = seriesParts(serverVersion);
  if (!p) return null;
  return engine === 'postgres' ? String(p[0]) : `${p[0]}.${p[1]}`;
}

/** The series a row's `version` tag starts (NULL = the engine default), or null when the tag does not say. */
export function rowSeries(engine: string, version: string | null): string | null {
  if (engine === 'postgres') return String(postgresMajor(version));
  if (!isUpgradeEngine(engine)) return null;
  if (version == null || version === '') return UPGRADE_ENGINES[engine].targets.at(-1)!;
  return /^\d+\.\d+/.test(version) ? seriesOf(engine, version) : null;
}

/**
 * The series a copy upgrade passes through, ending at `to`; a string says why
 * it cannot. MySQL never skips an LTS series: anything before 8.4 steps
 * through 8.4 first (8.0 → 8.4 → 9.7 on the same copy). MariaDB upgrades
 * from any earlier release directly.
 */
export function upgradeSteps(engine: UpgradeEngine, from: string, to: string): string[] | string {
  const spec = UPGRADE_ENGINES[engine];
  if (!spec.targets.includes(to)) return `${spec.label} ${to} is not a supported target (supported: ${spec.targets.join(', ')}).`;
  if (compareSeries(to, from) <= 0) return `The database already runs ${spec.label} ${from}; an upgrade must go to a newer release.`;
  if (spec.floor && compareSeries(from, spec.floor) < 0) return `${spec.label} ${from} is older than ${spec.floor}, the oldest release this upgrade starts from. Upgrade it to ${spec.floor} by hand first.`;
  if (engine === 'mysql' && compareSeries(from, '8.4') < 0 && compareSeries(to, '8.4') > 0) return ['8.4', to];
  return [to];
}

/** The leading integer of a series (`8.4` → 8), for the `fromMajor`/`toMajor` columns. */
const majorOf = (series: string) => (seriesParts(series) ?? [0, 0])[0];

/** How an upgrade row names its series (rows from before 0126 have only the majors). */
export const fromSeriesOf = (r: Pick<DatabaseUpgrade, 'fromSeries' | 'fromMajor'>) => r.fromSeries ?? String(r.fromMajor);
export const toSeriesOf = (r: Pick<DatabaseUpgrade, 'toSeries' | 'toMajor'>) => r.toSeries ?? String(r.toMajor);

/** Everything that touches Docker, injectable for tests. */
export interface DatabaseUpgradeDeps {
  psql(container: string, sql: string, opts?: { database?: string }): Promise<string>;
  containerImage(container: string): Promise<{ id: string; tag: string } | null>;
  containerRunning(container: string): Promise<boolean>;
  pull(image: string, log: (line: string) => void): Promise<void>;
  /** Graceful stop, then remove (the volume stays). */
  stopAndRemove(container: string, log: (line: string) => void): Promise<void>;
  runIsolated(d: Database, spec: { name: string; image: string; volume: string; mount: string; env?: Record<string, string> }, log: (line: string) => void): Promise<void>;
  /** MySQL/MariaDB: one statement as root over loopback TCP (so the stored password is what logs in); tab-separated rows, no header. */
  sql(d: Database, container: string, sql: string): Promise<string>;
  /** Bytes under `dir` inside a running container (`du -sb`). */
  dataDirBytes(container: string, dir: string): Promise<number>;
  /** Free bytes on the filesystem holding `dir` inside a running container: where Docker keeps the volume. */
  freeBytesIn(container: string, dir: string): Promise<number>;
  /** Stop (long bound), report the exit code (null = unknown or still running), remove. */
  stopClean(container: string, log: (line: string) => void): Promise<number | null>;
  /** Copy through a helper container called `name` (removed by name if anything goes wrong). */
  copyVolume(from: string, to: string, image: string, name: string, log: (line: string) => void): Promise<void>;
  waitReady(container: string, d: Database, log: (line: string) => void): Promise<boolean>;
  dump(d: Database, file: string, log: (line: string) => void): Promise<void>;
  restore(d: Database, file: string, log: (line: string) => void): Promise<void>;
  createVolume(name: string, labels: Record<string, string>, log: (line: string) => void): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  /** Removes the volume; resolves false when it is still there afterwards. */
  removeVolume(name: string, log: (line: string) => void): Promise<boolean>;
  start(d: Database, log: (line: string) => void): Promise<void>;
  attachBridges(d: Database, slugs: string[], log: (line: string) => void): Promise<void>;
  freeBytes(dir: string): Promise<number>;
  maintenance<T>(d: Database, log: (line: string) => void, op: () => Promise<T>): Promise<T>;
  fileSize(file: string): Promise<number>;
}

/**
 * A MySQL/MariaDB `[client]` option file holding the password. Quoted, with
 * backslash and quote escaped: inside an option file an unquoted `#` starts a
 * comment.
 */
export function mysqlClientOptions(password: string): Buffer {
  return Buffer.from(`[client]\npassword="${password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`);
}

/**
 * MySQL/MariaDB: wait until root logs in over loopback TCP with the stored
 * password. A server upgrading its data directory on start (MySQL's data
 * dictionary, MariaDB's `mariadb-upgrade`) answers only afterwards, so the
 * bound is long; a container that exited (a failed upgrade) ends the wait.
 */
async function waitForMysqlTcp(container: string, d: Database, log: (line: string) => void, timeoutSec = 1800): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      if ((await databaseUpgradeDeps.sql(d, container, 'SELECT 1')).trim() === '1') return true;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (!(await databaseUpgradeDeps.containerRunning(container))) {
      log(`${container} exited before it accepted connections${last ? ` (${clip(last)})` : ''}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  log(`${container} did not accept connections within ${timeoutSec} s${last ? ` (${clip(last)})` : ''}`);
  return false;
}

export const databaseUpgradeDeps: DatabaseUpgradeDeps = {
  psql: (container, sql, opts = {}) => {
    const cfg = ENGINES.postgres!;
    return capture('docker', ['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', cfg.username()!, '-d', opts.database ?? cfg.dbName()!, '-At', '-F', SEP, '-c', sql]);
  },
  containerImage: async (container) => {
    try {
      const out = (await capture('docker', ['inspect', container, '--format', '{{.Image}}|{{.Config.Image}}'])).trim();
      const [id, tag] = out.split('|');
      return id && tag ? { id, tag } : null;
    } catch {
      return null;
    }
  },
  containerRunning: async (container) => {
    try {
      return (await capture('docker', ['inspect', container, '--format', '{{.State.Status}}'])).trim() === 'running';
    } catch {
      return false;
    }
  },
  pull: (image, log) => pullDockerImage(image, log),
  stopAndRemove: async (container, log) => {
    await run('docker', ['stop', '--time', '60', container], {}, log).catch(() => undefined);
    await run('docker', ['rm', '-f', container], {}, () => undefined).catch(() => undefined);
  },
  runIsolated: (d, spec, log) => runIsolatedDatabase(d, spec, log),
  // The password travels as a `[client]` option file on stdin: never in argv
  // (the host's and the container's process lists) nor in the environment.
  // `--defaults-extra-file` must come first; checked on mysql 8.0/9.7 and mariadb 10.6/11.8.
  sql: (d, container, sql) =>
    capture(
      'docker',
      ['exec', '-i', container, d.engine === 'mariadb' ? 'mariadb' : 'mysql', '--defaults-extra-file=/dev/stdin', '-h127.0.0.1', '-uroot', '-N', '-B', '-e', sql],
      { timeoutMs: 6 * 60 * 60 * 1000 },
      mysqlClientOptions(decrypt(d.passwordEncrypted)),
    ),
  dataDirBytes: async (container, dir) => {
    const n = Number.parseInt((await capture('docker', ['exec', container, 'du', '-sb', dir])).trim().split(/\s+/)[0] ?? '', 10);
    if (!Number.isFinite(n)) throw new Error(`could not measure ${dir} in ${container}`);
    return n;
  },
  freeBytesIn: async (container, dir) => {
    const last = lines(await capture('docker', ['exec', container, 'df', '-PB1', dir])).at(-1) ?? '';
    const n = Number.parseInt(last.trim().split(/\s+/)[3] ?? '', 10);
    if (!Number.isFinite(n)) throw new Error(`could not read the free space of ${dir} in ${container}`);
    return n;
  },
  stopClean: (container, log) => stopContainerClean(container, log),
  copyVolume: (from, to, image, name, log) => copyDockerVolume(from, to, image, name, log),
  waitReady: async (container, d, log) => {
    if (d.engine === 'mysql' || d.engine === 'mariadb') return waitForMysqlTcp(container, d, log);
    const cfg = ENGINES.postgres!;
    // TCP, not the socket: a fresh cluster's init server listens on the socket
    // only and is restarted by the entrypoint; TCP answers only once the real
    // server is up (loopback works with --network none).
    return (await waitForPostgresTcp(container, cfg.username()!, cfg.dbName()!, log, 180, 1_000)) !== 'not-ready';
  },
  dump: (d, file, log) => dumpDatabaseHeld(d, file, log),
  restore: (d, file, log) => restoreDatabaseHeld(d, file, log),
  createVolume: (name, labels, log) => createDockerVolume(name, log, labels),
  // Lazily: a test mocking engine/database.js without it must still load this module.
  volumeExists: (name) => volumeExists(name),
  removeVolume: async (name, log) => {
    await run('docker', ['volume', 'rm', name], {}, log).catch(() => undefined);
    return !(await volumeExists(name));
  },
  start: (d, log) => startDatabase(d, log),
  attachBridges: (d, slugs, log) => attachDatabaseToServiceBridges(d, slugs, log),
  freeBytes: async (dir) => {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  },
  maintenance: (d, log, op) => withDatabaseMaintenance(d, log, op),
  fileSize: async (file) => {
    const { stat } = await import('node:fs/promises');
    return (await stat(file).catch(() => ({ size: 0 }))).size;
  },
};

export const fenceName = (slug: string) => `nd-dbup-${slug}-old`;
export const stagingName = (slug: string) => `nd-dbup-${slug}-new`;
/** MySQL/MariaDB: the helper that copies the old volume into the new one. */
export const copierName = (slug: string) => `nd-dbup-${slug}-copy`;
/** The new volume. Resolves to its database in the inventory (lib/inventory.ts). */
export const upgradeVolumeName = (slug: string, upgradeId: number) => `nd-db-${slug}-data-u${upgradeId}`;

const refuse = (code: string, message: string) => new HttpError(409, code, message);

/** Why this database cannot be upgraded at all (before any cluster query), or null. */
export function upgradeRefusal(d: Database): { code: string; message: string } | null {
  if (d.serverId != null) return { code: 'database_upgrade_node', message: 'A major upgrade runs on the panel host only for now; this database lives on a node.' };
  if (!isUpgradeEngine(d.engine)) return { code: 'database_upgrade_engine', message: `A major upgrade is available for PostgreSQL, MySQL and MariaDB, not ${d.engine}.` };
  if (d.version === 'vector' || d.version === 'pgvector') return { code: 'database_upgrade_pgvector', message: 'This database runs the pgvector image, which follows its own release line; a major upgrade is not offered for it.' };
  if (d.previewCopyOf != null || d.previewServiceId != null) return { code: 'database_upgrade_preview', message: 'A preview copy follows its source database; upgrade the source instead.' };
  if (d.pitrEnabled) return { code: 'database_upgrade_pitr', message: 'Point-in-time recovery is on: its WAL archive and base backups belong to the current cluster. Turn it off, upgrade, then turn it on again.' };
  if (!d.containerName || !d.volumeName) return { code: 'database_upgrade_unmanaged', message: 'This database has no container or volume name on the panel host.' };
  return null;
}

/** An upgrade of this database that is running or still holds a previous volume, or null. */
export async function openUpgrade(db: DB, databaseId: number) {
  return (await db.query.databaseUpgrades.findFirst({
    where: and(eq(databaseUpgrades.databaseId, databaseId), inArray(databaseUpgrades.status, ['running', 'completed'])),
    orderBy: desc(databaseUpgrades.id),
  })) ?? null;
}

/** Refuses a lifecycle change while an upgrade runs (the routes and the Doctor call it). */
export async function assertNoRunningUpgrade(db: DB, databaseId: number): Promise<void> {
  const open = await openUpgrade(db, databaseId);
  if (open?.status === 'running') {
    throw conflict(`A major upgrade of this database is running (to ${engineLabel(open.engine)} ${toSeriesOf(open)}); wait for it to finish.`);
  }
}

export interface ClusterFacts {
  major: number;
  sizeBytes: number;
  otherDatabases: string[];
  otherRoles: string[];
  tablesInPostgresDb: number;
}

const lines = (out: string) => out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);

/** What the dump would leave behind, read from the running cluster. */
export async function readClusterFacts(deps: DatabaseUpgradeDeps, container: string): Promise<ClusterFacts> {
  const cfg = ENGINES.postgres!;
  const versionNum = Number.parseInt((await deps.psql(container, `SELECT current_setting('server_version_num')`)).trim(), 10);
  if (!Number.isFinite(versionNum)) throw new Error('could not read the server version');
  const sizeBytes = Number.parseInt((await deps.psql(container, 'SELECT pg_database_size(current_database())')).trim(), 10) || 0;
  const otherDatabases = lines(await deps.psql(container, `SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres', '${cfg.dbName()!}') ORDER BY 1`));
  const otherRoles = lines(await deps.psql(container, `SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> current_user ORDER BY 1`));
  const tablesInPostgresDb = Number.parseInt((await deps.psql(container, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','m','v','S') AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname !~ '^pg_'`, { database: 'postgres' })).trim(), 10) || 0;
  return { major: Math.floor(versionNum / 10_000), sizeBytes, otherDatabases, otherRoles, tablesInPostgresDb };
}

/** The majors this cluster can move to. */
export function upgradeTargets(currentMajor: number): number[] {
  return POSTGRES_UPGRADE_MAJORS.filter((m) => m > currentMajor);
}

export interface UpgradePlan {
  facts: ClusterFacts;
  fromImage: { id: string; tag: string };
  toImage: string;
  targetVersion: string;
  fromSeries: string;
  toSeries: string;
  /** The series the copy is started on in turn (copy engines); the last is the target. */
  steps: string[];
}

/** MySQL/MariaDB: the running server's series. */
async function readServerSeries(deps: DatabaseUpgradeDeps, d: Database, container: string): Promise<string> {
  const raw = (await deps.sql(d, container, 'SELECT VERSION()')).trim();
  const series = seriesOf(d.engine, raw);
  if (!series) throw new Error(`could not read the server version (${clip(raw)})`);
  return series;
}

/**
 * Everything checked before an upgrade is admitted — against the RUNNING
 * cluster, so a refusal never costs downtime. Throws an HttpError naming what
 * to change. `to` is the PostgreSQL major, or the series (`8.4`, `11.8`).
 */
export async function planUpgrade(db: DB, d: Database, to: number | string, deps: DatabaseUpgradeDeps = databaseUpgradeDeps): Promise<UpgradePlan> {
  const refusal = upgradeRefusal(d);
  if (refusal) throw refuse(refusal.code, refusal.message);
  const open = await openUpgrade(db, d.id);
  if (open?.status === 'running') throw refuse('database_upgrade_running', `An upgrade to ${engineLabel(open.engine)} ${toSeriesOf(open)} is already running.`);
  if (open?.status === 'completed') {
    throw refuse('database_upgrade_unfinalized', `The upgrade to ${engineLabel(open.engine)} ${toSeriesOf(open)} still keeps the previous volume ${open.previousVolume}. Finalize it (or roll it back) before another upgrade.`);
  }
  if (d.status !== 'running' || !(await deps.containerRunning(d.containerName!))) {
    throw refuse('database_upgrade_not_running', 'The database must be running: the upgrade reads the live cluster before it stops anything.');
  }
  const fromImage = await deps.containerImage(d.containerName!);
  if (!fromImage) throw refuse('database_upgrade_not_running', `Could not inspect ${d.containerName}.`);
  if (d.engine !== 'postgres') return planCopyUpgrade(d, String(to), fromImage, deps);
  const toMajor = typeof to === 'number' ? to : /^\d+$/.test(to) ? Number.parseInt(to, 10) : Number.NaN;
  const facts = await readClusterFacts(deps, d.containerName!);
  if (!(POSTGRES_UPGRADE_MAJORS as readonly number[]).includes(toMajor)) {
    throw badRequest(`PostgreSQL ${to} is not a supported target (supported: ${POSTGRES_UPGRADE_MAJORS.join(', ')}).`, 'database_upgrade_target');
  }
  if (toMajor <= facts.major) {
    throw badRequest(`The cluster already runs PostgreSQL ${facts.major}; an upgrade must go to a newer major.`, 'database_upgrade_target');
  }
  if (facts.otherDatabases.length > 0) {
    throw refuse('database_upgrade_other_databases', `The cluster holds other databases (${facts.otherDatabases.join(', ')}) that the upgrade would not carry over. Move or drop them first.`);
  }
  if (facts.otherRoles.length > 0) {
    throw refuse('database_upgrade_other_roles', `The cluster has roles besides the database user (${facts.otherRoles.join(', ')}); the dump does not carry roles, so their grants would fail on the new cluster. Drop them first.`);
  }
  if (facts.tablesInPostgresDb > 0) {
    throw refuse('database_upgrade_postgres_db', `The built-in "postgres" database holds ${facts.tablesInPostgresDb} user object(s); the upgrade carries over "${ENGINES.postgres!.dbName()}" only. Move them first.`);
  }
  const needed = facts.sizeBytes * 2 + FREE_SPACE_MARGIN_BYTES;
  const free = await deps.freeBytes(config.paths.backupsDir);
  if (free < needed) {
    throw refuse('database_upgrade_disk', `Not enough free disk: the dump and the new volume need about ${Math.ceil(needed / 1024 / 1024)} MiB, ${Math.floor(free / 1024 / 1024)} MiB is free.`);
  }
  const targetVersion = String(toMajor);
  return { facts, fromImage, toImage: ENGINES.postgres!.image(targetVersion), targetVersion, fromSeries: String(facts.major), toSeries: targetVersion, steps: [targetVersion] };
}

/**
 * MySQL/MariaDB preflight: the real series, an allowed path, accounts the
 * target can still log in, and room for the copy and the safety dump.
 */
async function planCopyUpgrade(d: Database, to: string, fromImage: { id: string; tag: string }, deps: DatabaseUpgradeDeps): Promise<UpgradePlan> {
  const engine = d.engine as UpgradeEngine;
  const container = d.containerName!;
  const fromSeries = await readServerSeries(deps, d, container);
  const steps = upgradeSteps(engine, fromSeries, to);
  if (typeof steps === 'string') throw badRequest(steps, 'database_upgrade_target');
  if (engine === 'mysql' && compareSeries(to, '8.4') >= 0) {
    // 8.4 starts with mysql_native_password off and 9.0 removed it: such an
    // account would no longer log in after the upgrade.
    const native = lines(await deps.sql(d, container, `SELECT CONCAT(user, '@', host) FROM mysql.user WHERE plugin = 'mysql_native_password' AND user NOT IN ${MYSQL_SYSTEM_USERS} ORDER BY 1`));
    if (native.length > 0) {
      throw refuse(
        'database_upgrade_native_password',
        `These accounts use mysql_native_password, which MySQL 8.4 disables and 9.0 removed, so they could not log in after the upgrade: ${native.slice(0, 10).join(', ')}${native.length > 10 ? ` (+${native.length - 10} more)` : ''}. Move each to caching_sha2_password first (ALTER USER … IDENTIFIED WITH caching_sha2_password BY '…').`,
      );
    }
  }
  const sizeBytes = await deps.dataDirBytes(container, MYSQL_DATA_DIR);
  // The copy lands where Docker keeps volumes; the safety dump in the backups
  // directory, which may be the same filesystem: ask room for both there.
  const volumeFree = await deps.freeBytesIn(container, MYSQL_DATA_DIR);
  const volumeNeeded = sizeBytes * 2 + FREE_SPACE_MARGIN_BYTES;
  if (volumeFree < volumeNeeded) {
    throw refuse('database_upgrade_disk', `Not enough free disk where Docker keeps volumes: the copy and the safety dump need about ${Math.ceil(volumeNeeded / 1024 / 1024)} MiB, ${Math.floor(volumeFree / 1024 / 1024)} MiB is free.`);
  }
  const backupsFree = await deps.freeBytes(config.paths.backupsDir);
  if (backupsFree < sizeBytes + FREE_SPACE_MARGIN_BYTES) {
    throw refuse('database_upgrade_disk', `Not enough free disk for the safety dump: about ${Math.ceil((sizeBytes + FREE_SPACE_MARGIN_BYTES) / 1024 / 1024)} MiB is needed, ${Math.floor(backupsFree / 1024 / 1024)} MiB is free.`);
  }
  return {
    facts: { major: majorOf(fromSeries), sizeBytes, otherDatabases: [], otherRoles: [], tablesInPostgresDb: 0 },
    fromImage,
    toImage: ENGINES[engine]!.image(to),
    targetVersion: to,
    fromSeries,
    toSeries: to,
    steps,
  };
}

/** What the options route shows: the live major, the targets, and why none can start now. */
export interface UpgradeOptions {
  /** The PostgreSQL major the running cluster reports (MySQL/MariaDB: the leading number of its series). */
  currentMajor: number | null;
  /** PostgreSQL majors it can move to (empty for MySQL/MariaDB: read `versions`). */
  targets: number[];
  /** The series the running server reports: `16`, `8.0`, `11.4`. */
  currentSeries: string | null;
  /** Every series it can move to, oldest first (a PostgreSQL major as text). */
  versions: string[];
  refusal: { code: string; message: string } | null;
}

/** What the options route shows: the live series, the targets, and why none can start now. */
export async function upgradeOptions(db: DB, d: Database, deps: DatabaseUpgradeDeps = databaseUpgradeDeps): Promise<UpgradeOptions> {
  const none = (refusal: UpgradeOptions['refusal'], current: string | null = null): UpgradeOptions => ({
    currentMajor: current === null ? null : majorOf(current),
    targets: [],
    currentSeries: current,
    versions: [],
    refusal,
  });
  const refusal = upgradeRefusal(d);
  if (refusal) return none(refusal);
  const label = engineLabel(d.engine);
  const open = await openUpgrade(db, d.id);
  if (open?.status === 'running') return none({ code: 'database_upgrade_running', message: `An upgrade to ${label} ${toSeriesOf(open)} is running.` }, fromSeriesOf(open));
  if (open?.status === 'completed') return none({ code: 'database_upgrade_unfinalized', message: `Finalize (or roll back) the upgrade to ${label} ${toSeriesOf(open)} before another one.` }, toSeriesOf(open));
  if (d.status !== 'running' || !(await deps.containerRunning(d.containerName!))) {
    return none({ code: 'database_upgrade_not_running', message: 'Start the database first: the upgrade reads the live cluster.' });
  }
  try {
    let current: string;
    let versions: string[];
    let targets: number[] = [];
    if (d.engine === 'postgres') {
      const versionNum = Number.parseInt((await deps.psql(d.containerName!, `SELECT current_setting('server_version_num')`)).trim(), 10);
      const currentMajor = Math.floor(versionNum / 10_000);
      if (!Number.isFinite(currentMajor)) throw new Error('no server_version_num');
      current = String(currentMajor);
      targets = upgradeTargets(currentMajor);
      versions = targets.map(String);
    } else {
      const engine = d.engine as UpgradeEngine;
      current = await readServerSeries(deps, d, d.containerName!);
      versions = UPGRADE_ENGINES[engine].targets.filter((t) => Array.isArray(upgradeSteps(engine, current, t)));
      if (versions.length === 0) {
        const why = upgradeSteps(engine, current, UPGRADE_ENGINES[engine].targets.at(-1)!);
        if (typeof why === 'string' && compareSeries(current, UPGRADE_ENGINES[engine].floor ?? '0') < 0) {
          return { currentMajor: majorOf(current), targets: [], currentSeries: current, versions: [], refusal: { code: 'database_upgrade_target', message: why } };
        }
      }
    }
    return {
      currentMajor: majorOf(current),
      targets,
      currentSeries: current,
      versions,
      refusal: versions.length === 0 ? { code: 'database_upgrade_latest', message: `${label} ${current} is the newest release offered.` } : null,
    };
  } catch (err) {
    // The details (command output) stay in the panel log: the options route answers viewers.
    logger.warn(`database #${d.id}: could not read the server version: ${err instanceof Error ? err.message : String(err)}`);
    return none({ code: 'database_upgrade_not_running', message: 'Could not read the server version; the panel log has the details.' });
  }
}

/** The API shape of an upgrade row. */
export function serializeUpgrade(r: DatabaseUpgrade) {
  let verification: unknown = null;
  try { verification = r.verification ? JSON.parse(r.verification) : null; } catch { verification = null; }
  const iso = (v: Date | null) => (v ? v.toISOString() : null);
  return {
    id: r.id,
    databaseId: r.databaseId,
    engine: r.engine,
    fromMajor: r.fromMajor,
    toMajor: r.toMajor,
    fromSeries: fromSeriesOf(r),
    toSeries: toSeriesOf(r),
    previousVersion: r.previousVersion,
    targetVersion: r.targetVersion,
    previousVolume: r.previousVolume,
    targetVolume: r.targetVolume,
    status: r.status,
    phase: r.phase,
    safetyBackupId: r.safetyBackupId,
    verification,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    completedAt: iso(r.completedAt),
    rolledBackAt: iso(r.rolledBackAt),
    finalizedAt: iso(r.finalizedAt),
  };
}

/** Admit an upgrade: record it and return the row. The caller starts {@link runDatabaseUpgrade}. */
export async function admitUpgrade(db: DB, d: Database, plan: UpgradePlan, actorId: number | null) {
  const [row] = await db
    .insert(databaseUpgrades)
    .values({
      databaseId: d.id,
      engine: d.engine,
      fromMajor: plan.facts.major,
      toMajor: majorOf(plan.toSeries),
      fromSeries: plan.fromSeries,
      toSeries: plan.toSeries,
      // The row's tag can disagree with the data (a NULL version follows the
      // engine default, which may have moved on since the cluster was made):
      // every way back starts the image this value names, so it must be the
      // series the cluster really runs. For MySQL and MariaDB a wrong one is
      // worse than a crash loop: a newer server upgrades the old volume in
      // place, and there is no way down.
      previousVersion: rowSeries(d.engine, d.version) === plan.fromSeries ? d.version : plan.fromSeries,
      targetVersion: plan.targetVersion,
      fromImage: plan.fromImage.id,
      toImage: plan.toImage,
      previousVolume: d.volumeName!,
      // Named once the id is known (below): unique per upgrade, so a retry never meets a leftover.
      targetVolume: '',
      status: 'running',
      phase: 'pull',
      createdByUserId: actorId,
    })
    .returning();
  const targetVolume = upgradeVolumeName(d.slug, row!.id);
  await db.update(databaseUpgrades).set({ targetVolume }).where(eq(databaseUpgrades.id, row!.id));
  return { ...row!, targetVolume, fromImageTag: plan.fromImage.tag };
}

// ── fingerprint ─────────────────────────────────────────────────────────

const USER_RELATION = `n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp' AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = c.oid AND dep.deptype = 'e')`;

/** What the restored copy must match. Exact counts: slow on huge tables, and that is the point. */
export async function clusterFingerprint(deps: DatabaseUpgradeDeps, container: string): Promise<ClusterFingerprint> {
  const rows: Record<string, string> = {};
  for (const line of lines(await deps.psql(container,
    `SELECT n.nspname || '.' || c.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','m') AND ${USER_RELATION} ORDER BY 1`))) {
    const [name, count] = line.split(SEP);
    rows[name!] = count ?? '';
  }
  const sequences: Record<string, string> = {};
  for (const line of lines(await deps.psql(container,
    `SELECT schemaname || '.' || sequencename, coalesce(last_value::text, 'null') FROM pg_sequences WHERE schemaname NOT IN ${SYSTEM_SCHEMAS} ORDER BY 1`))) {
    const [name, value] = line.split(SEP);
    sequences[name!] = value ?? '';
  }
  // NOT NULL constraints are catalogued in pg_constraint from PostgreSQL 18
  // (contype 'n'), so they are left out: the count would differ by major alone.
  const [o] = lines(await deps.psql(container, `SELECT
    (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_RELATION}),
    (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE k.contype <> 'n' AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname !~ '^pg_'),
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND ${USER_RELATION}),
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND ${USER_RELATION}),
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname !~ '^pg_' AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e')),
    (SELECT coalesce(string_agg(extname, ',' ORDER BY extname), '') FROM pg_extension)`));
  const f = (o ?? '').split(SEP);
  return {
    rows,
    sequences,
    objects: {
      indexes: Number(f[0] ?? 0),
      constraints: Number(f[1] ?? 0),
      views: Number(f[2] ?? 0),
      triggers: Number(f[3] ?? 0),
      functions: Number(f[4] ?? 0),
      extensions: f[5] ?? '',
    },
  };
}

/** Every difference between the old cluster and the restored copy (empty = they match). */
export function compareFingerprints(before: ClusterFingerprint, after: ClusterFingerprint): string[] {
  const out: string[] = [];
  const diffMap = (label: string, a: Record<string, string>, b: Record<string, string>) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) out.push(`${label} ${k} is missing after the restore`);
      else if (!(k in a)) out.push(`${label} ${k} appeared after the restore`);
      else if (a[k] !== b[k]) out.push(`${label} ${k}: ${a[k]} before, ${b[k]} after`);
    }
  };
  diffMap('table', before.rows, after.rows);
  diffMap('sequence', before.sequences, after.sequences);
  for (const key of Object.keys(before.objects) as Array<keyof ClusterFingerprint['objects']>) {
    if (before.objects[key] !== after.objects[key]) out.push(`${key}: ${before.objects[key]} before, ${after.objects[key]} after`);
  }
  // Accounts: each must survive; the new image may add its own system accounts.
  if (before.users) {
    const kept = new Set(after.users ?? []);
    for (const u of before.users) if (!kept.has(u)) out.push(`account ${u} is missing after the upgrade`);
  }
  return out;
}

export function verificationSummary(fp: ClusterFingerprint): UpgradeVerification {
  return {
    tables: Object.keys(fp.rows).length,
    rows: Object.values(fp.rows).reduce((sum, n) => sum + (Number(n) || 0), 0),
    sequences: Object.keys(fp.sequences).length,
    objects: fp.objects,
    ...(fp.users ? { users: fp.users.length } : {}),
  };
}

// ── MySQL / MariaDB fingerprint ─────────────────────────────────────────

const fromHex = (h: string) => Buffer.from(h, 'hex').toString('utf8');
const mysqlIdent = (name: string) => `\`${name.replace(/`/g, '``')}\``;
/** Tables counted per statement: one UNION ALL of exact counts. */
const COUNT_CHUNK = 100;

/**
 * What the upgraded copy must match: every user table's exact row count
 * (COUNT(*), never the TABLE_ROWS estimate), the count of indexes,
 * constraints, views, triggers, routines and events, the databases, and the
 * accounts. Names travel as hex, so no name can break the parsing.
 */
export async function mysqlFingerprint(deps: DatabaseUpgradeDeps, d: Database, container: string): Promise<ClusterFingerprint> {
  const tables = lines(await deps.sql(d, container,
    `SELECT HEX(TABLE_SCHEMA), HEX(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED') AND TABLE_SCHEMA NOT IN ${MYSQL_SYSTEM_SCHEMAS} ORDER BY TABLE_SCHEMA, TABLE_NAME`))
    .map((l) => {
      const [schema, table] = l.split('\t');
      return { schema: fromHex(schema ?? ''), table: fromHex(table ?? '') };
    });
  const rows: Record<string, string> = {};
  for (let i = 0; i < tables.length; i += COUNT_CHUNK) {
    const chunk = tables.slice(i, i + COUNT_CHUNK);
    const sql = chunk.map((t, k) => `SELECT ${i + k}, COUNT(*) FROM ${mysqlIdent(t.schema)}.${mysqlIdent(t.table)}`).join(' UNION ALL ');
    for (const l of lines(await deps.sql(d, container, sql))) {
      const [idx, count] = l.split('\t');
      const t = tables[Number(idx)];
      if (t) rows[`${t.schema}.${t.table}`] = count ?? '';
    }
  }
  const notSystem = (col: string) => `${col} NOT IN ${MYSQL_SYSTEM_SCHEMAS}`;
  const [o] = lines(await deps.sql(d, container, `SELECT
    (SELECT COUNT(*) FROM (SELECT DISTINCT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE ${notSystem('TABLE_SCHEMA')}) x),
    (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE ${notSystem('CONSTRAINT_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.VIEWS WHERE ${notSystem('TABLE_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE ${notSystem('TRIGGER_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ${notSystem('ROUTINE_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.EVENTS WHERE ${notSystem('EVENT_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE ${notSystem('SCHEMA_NAME')})`));
  const f = (o ?? '').split('\t');
  const users = lines(await deps.sql(d, container, `SELECT HEX(CONCAT(user, '@', host)) FROM mysql.user ORDER BY 1`)).map(fromHex);
  return {
    rows,
    sequences: {},
    objects: {
      indexes: Number(f[0] ?? 0),
      constraints: Number(f[1] ?? 0),
      views: Number(f[2] ?? 0),
      triggers: Number(f[3] ?? 0),
      functions: Number(f[4] ?? 0),
      extensions: '',
      events: Number(f[5] ?? 0),
      schemas: Number(f[6] ?? 0),
    },
    users,
  };
}

// ── the run ─────────────────────────────────────────────────────────────

type UpgradeRow = DatabaseUpgrade;

async function attachedSlugs(db: DB, databaseId: number): Promise<string[]> {
  const rows = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.databaseId, databaseId), with: { service: true } });
  return [...new Set(rows.flatMap((r) => (r.service ? [r.service.slug] : [])))];
}

const clip = (s: string) => (s.length > 2000 ? `${s.slice(0, 2000)}…` : s);

/** The per-service bridges are extra: the shared network already serves clients, so a failure only logs. */
async function joinBridges(db: DB, d: Database, deps: DatabaseUpgradeDeps, log: (line: string) => void): Promise<void> {
  try {
    await deps.attachBridges(d, await attachedSlugs(db, d.id), log);
  } catch (err) {
    log(`could not join the service bridges again (the shared network still serves them): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Bring the database back up and report it running (or error when even that fails). */
async function bringUp(db: DB, d: Database, deps: DatabaseUpgradeDeps, log: (line: string) => void): Promise<boolean> {
  try {
    await deps.start(d, log);
    await joinBridges(db, d, deps, log);
    if (!(await deps.waitReady(d.containerName!, d, log))) throw new Error(`${d.containerName} did not accept connections`);
    await db.update(databases).set({ status: 'running' }).where(eq(databases.id, d.id));
    return true;
  } catch (err) {
    log(`could not start ${d.containerName}: ${err instanceof Error ? err.message : String(err)}`);
    await db.update(databases).set({ status: 'error' }).where(eq(databases.id, d.id));
    return false;
  }
}

/**
 * Run an admitted upgrade. Never throws: the outcome lands on the upgrade row
 * and the database row, and in the audit log.
 */
export async function runDatabaseUpgrade(
  db: DB,
  upgradeId: number,
  ctx: { actorId: number | null; fromImageTag: string; log?: (line: string) => void },
  deps: DatabaseUpgradeDeps = databaseUpgradeDeps,
): Promise<void> {
  const up0 = await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, upgradeId) });
  const d0 = up0 ? await db.query.databases.findFirst({ where: eq(databases.id, up0.databaseId) }) : null;
  if (!up0 || !d0) return;
  const log = (line: string) => {
    logger.info(`database #${d0.id} upgrade #${upgradeId}: ${line}`);
    ctx.log?.(line);
  };
  const phase = (p: UpgradePhase) => db.update(databaseUpgrades).set({ phase: p }).where(eq(databaseUpgrades.id, upgradeId));
  const meta = { databaseId: d0.id, upgradeId, fromMajor: up0.fromMajor, toMajor: up0.toMajor };
  const fence = fenceName(d0.slug);
  const staging = stagingName(d0.slug);
  let createdVolume = false;
  let switched = false;
  // Once the new cluster was started on the network it may hold writes: its volume is never deleted after that.
  let everSwitched = false;
  let stopped = false;
  const spec = UPGRADE_ENGINES[up0.engine as UpgradeEngine] ?? UPGRADE_ENGINES.postgres;
  const label = spec.label;
  const fromS = fromSeriesOf(up0);
  const toS = toSeriesOf(up0);
  /** The pre-upgrade dump, kept as an ordinary backup of the database. */
  const safetyDump = async (container: string) => {
    await mkdir(config.paths.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(config.paths.backupsDir, `${d0.slug}-${stamp}-pre-upgrade.dump`);
    const [b] = await db.insert(backups).values({ databaseId: d0.id, scope: 'db', label: 'pre-upgrade', status: 'running', path: file }).returning({ id: backups.id });
    try {
      await deps.dump({ ...d0, containerName: container }, file, log);
    } catch (err) {
      await db.update(backups).set({ status: 'failed' }).where(eq(backups.id, b!.id));
      throw err;
    }
    await db.update(backups).set({ status: 'completed', sizeBytes: await deps.fileSize(file) }).where(eq(backups.id, b!.id));
    await db.update(databaseUpgrades).set({ safetyBackupId: b!.id }).where(eq(databaseUpgrades.id, upgradeId));
    return file;
  };
  const recordVerification = async (before: ClusterFingerprint, after: ClusterFingerprint) => {
    const diff = compareFingerprints(before, after);
    await db.update(databaseUpgrades).set({ verification: JSON.stringify({ ...verificationSummary(before), mismatches: diff.slice(0, 50) }) }).where(eq(databaseUpgrades.id, upgradeId));
    if (diff.length > 0) throw new Error(`the ${spec.method === 'copy' ? 'upgraded' : 'restored'} copy does not match the old cluster: ${diff.slice(0, 5).join('; ')}${diff.length > 5 ? ` (+${diff.length - 5} more)` : ''}`);
  };

  try {
    await deps.maintenance(d0, log, async () => {
      // Admission happened before the lock: re-read, so an upgrade queued
      // behind another (or a rollback) never runs from a stale plan.
      const current = await db.query.databases.findFirst({ where: eq(databases.id, d0.id) });
      if (!current || current.volumeName !== up0.previousVolume || current.status !== 'running') {
        throw new Error('the database changed since the upgrade was admitted; start it again');
      }
      if (spec.method === 'copy') {
        const steps = upgradeSteps(up0.engine as UpgradeEngine, fromS, toS);
        if (typeof steps === 'string') throw new Error(steps);
        const cfg = ENGINES[up0.engine]!;
        await phase('pull');
        for (const step of steps) await deps.pull(cfg.image(step), log);

        // Downtime starts here: nothing writes to the old data directory after the stop.
        await phase('stop');
        await db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, d0.id));
        stopped = true;
        await deps.stopAndRemove(d0.containerName!, log);

        // The fence: the old container's own image on the old volume, no
        // network. It recovers whatever a hard stop left, gives the
        // fingerprint and the safety dump, then shuts down slowly and must
        // exit cleanly: only that data directory is fit to be copied.
        await phase('dump');
        await deps.runIsolated(d0, { name: fence, image: up0.fromImage, volume: up0.previousVolume, mount: MYSQL_DATA_DIR }, log);
        if (!(await deps.waitReady(fence, d0, log))) throw new Error(`the old ${label} server did not come up for the dump`);
        const before = await mysqlFingerprint(deps, d0, fence);
        await safetyDump(fence);
        await deps.sql(d0, fence, 'SET GLOBAL innodb_fast_shutdown = 0');
        const fenceExit = await deps.stopClean(fence, log);
        if (fenceExit !== 0) throw new Error(`the old ${label} server did not shut down cleanly (exit code ${fenceExit ?? 'unknown'}); its data directory was not copied`);

        await phase('copy');
        const target: Database = { ...d0, version: up0.targetVersion, volumeName: up0.targetVolume };
        if (await deps.volumeExists(up0.targetVolume)) throw new Error(`volume ${up0.targetVolume} already exists`);
        await deps.createVolume(up0.targetVolume, databaseVolumeLabels(target), log);
        createdVolume = true;
        await deps.copyVolume(up0.previousVolume, up0.targetVolume, cfg.image(steps[0]!), copierName(d0.slug), log);

        // Each step starts the next release on the COPY, which upgrades it in
        // place; between steps the server shuts down slowly again.
        await phase('upgrade');
        for (const [n, step] of steps.entries()) {
          const stepRow: Database = { ...target, version: step };
          const env: Record<string, string> = up0.engine === 'mariadb' ? { MARIADB_AUTO_UPGRADE: '1' } : {};
          await deps.runIsolated(stepRow, { name: staging, image: cfg.image(step), volume: up0.targetVolume, mount: MYSQL_DATA_DIR, env }, log);
          if (!(await deps.waitReady(staging, stepRow, log))) throw new Error(`${label} ${step} did not come up on the copy (its upgrade on start failed; see the panel log)`);
          if (n < steps.length - 1) {
            await deps.sql(stepRow, staging, 'SET GLOBAL innodb_fast_shutdown = 0');
            const exit = await deps.stopClean(staging, log);
            if (exit !== 0) throw new Error(`${label} ${step} did not shut down cleanly on the copy (exit code ${exit ?? 'unknown'})`);
          }
        }

        await phase('verify');
        const after = await mysqlFingerprint(deps, target, staging);
        await recordVerification(before, after);
        const exit = await deps.stopClean(staging, log);
        if (exit !== 0) throw new Error(`${label} ${toS} did not shut down cleanly after the check (exit code ${exit ?? 'unknown'})`);
      } else {
        await phase('pull');
        await deps.pull(up0.toImage, log);

        // Downtime starts here: nothing writes to the old cluster after the stop.
        await phase('stop');
        await db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, d0.id));
        stopped = true;
        await deps.stopAndRemove(d0.containerName!, log);

        await phase('dump');
        const fromMount = postgresMountForImage(ctx.fromImageTag, up0.previousVersion ?? d0.version);
        await deps.runIsolated(d0, { name: fence, image: up0.fromImage, volume: up0.previousVolume, mount: fromMount }, log);
        if (!(await deps.waitReady(fence, d0, log))) throw new Error('the old cluster did not come up for the dump');
        const before = await clusterFingerprint(deps, fence);
        const file = await safetyDump(fence);
        await deps.stopAndRemove(fence, log);

        await phase('restore');
        const target: Database = { ...d0, version: up0.targetVersion, volumeName: up0.targetVolume };
        if (await deps.volumeExists(up0.targetVolume)) throw new Error(`volume ${up0.targetVolume} already exists`);
        await deps.createVolume(up0.targetVolume, databaseVolumeLabels(target), log);
        createdVolume = true;
        await deps.runIsolated(target, { name: staging, image: up0.toImage, volume: up0.targetVolume, mount: resolveVolumePath(ENGINES.postgres!, up0.targetVersion) }, log);
        if (!(await deps.waitReady(staging, target, log))) throw new Error(`${label} ${toS} did not come up on the new volume`);
        await deps.restore({ ...target, containerName: staging }, file, log);
        await deps.psql(staging, 'ANALYZE').catch(() => undefined);

        await phase('verify');
        const after = await clusterFingerprint(deps, staging);
        await recordVerification(before, after);
        await deps.stopAndRemove(staging, log);

      }

      await phase('switch');
      await db.transaction(async (tx) => {
        await tx.update(databases).set({ version: up0.targetVersion, volumeName: up0.targetVolume }).where(eq(databases.id, d0.id));
        await tx.update(databaseUpgrades).set({ switched: true }).where(eq(databaseUpgrades.id, upgradeId));
      });
      switched = true;
      everSwitched = true;

      await phase('start');
      const fresh = (await db.query.databases.findFirst({ where: eq(databases.id, d0.id) }))!;
      await deps.start(fresh, log);
      await joinBridges(db, fresh, deps, log);
      if (!(await deps.waitReady(fresh.containerName!, fresh, log))) throw new Error(`${label} ${toS} did not accept connections after the switch`);
      await db.update(databases).set({ status: 'running' }).where(eq(databases.id, d0.id));
      await db.update(databaseUpgrades).set({ status: 'completed', phase: null, completedAt: new Date() }).where(eq(databaseUpgrades.id, upgradeId));
    });
    log(`upgraded ${d0.name} to ${label} ${toS}; the previous volume ${up0.previousVolume} is kept until the upgrade is finalized`);
    void audit(db, ctx.actorId, 'database.upgrade.complete', d0.name, meta);
  } catch (err) {
    const message = clip(err instanceof Error ? err.message : String(err));
    log(`upgrade failed: ${message}`);
    // The helpers exist only once the old container is stopped.
    if (stopped) {
      await deps.stopAndRemove(fence, log).catch(() => undefined);
      await deps.stopAndRemove(staging, log).catch(() => undefined);
      // A copy that timed out still runs and holds the new volume.
      if (spec.method === 'copy') await deps.stopAndRemove(copierName(d0.slug), log).catch(() => undefined);
    }
    let outcome: string;
    if (switched) {
      // The switch happened and the new cluster did not come up: point back.
      await deps.stopAndRemove(d0.containerName!, log).catch(() => undefined);
      await db.transaction(async (tx) => {
        await tx.update(databases).set({ version: up0.previousVersion, volumeName: up0.previousVolume }).where(eq(databases.id, d0.id));
        await tx.update(databaseUpgrades).set({ switched: false }).where(eq(databaseUpgrades.id, upgradeId));
      });
      switched = false;
    }
    let kept = '';
    if (createdVolume && !everSwitched) {
      const gone = await deps.removeVolume(up0.targetVolume, log).catch(() => false);
      if (!gone) log(`the new volume ${up0.targetVolume} could not be removed; delete it from the Volumes panel`);
    } else if (everSwitched) {
      kept = ` The upgraded volume ${up0.targetVolume} is kept: it may hold writes made after the switch.`;
    }
    if (stopped) {
      // Back on the major the cluster really ran (a NULL tag would start the engine default).
      await db.update(databases).set({ version: up0.previousVersion, volumeName: up0.previousVolume }).where(eq(databases.id, d0.id));
      const back = (await db.query.databases.findFirst({ where: eq(databases.id, d0.id) }))!;
      const up = await bringUp(db, back, deps, log);
      outcome = (up ? `The database runs on ${label} ${fromS} as before.` : `The database could not be started again on ${label} ${fromS}; start it from the database page.`) + kept;
    } else {
      outcome = 'Nothing was stopped.';
    }
    await db
      .update(databaseUpgrades)
      .set({ status: 'failed', error: clip(`${message}. ${outcome}`), completedAt: new Date() })
      .where(eq(databaseUpgrades.id, upgradeId))
      .catch(() => undefined);
    void audit(db, ctx.actorId, 'database.upgrade.fail', d0.name, { ...meta, error: message });
  }
}

/** Point the row back at the previous volume. Writes made since the upgrade stay on the upgraded volume. */
export async function rollbackDatabaseUpgrade(db: DB, upgrade: UpgradeRow, actorId: number | null, deps: DatabaseUpgradeDeps = databaseUpgradeDeps): Promise<void> {
  const d0 = await db.query.databases.findFirst({ where: eq(databases.id, upgrade.databaseId) });
  if (!d0) throw refuse('database_upgrade_state', 'The database is gone.');
  const log = (line: string) => logger.info(`database #${d0.id} upgrade #${upgrade.id}: ${line}`);
  // Every check runs again under the database's lock: a concurrent rollback,
  // finalize or upgrade must never act on what this call read before it.
  await deps.maintenance(d0, log, async () => {
    const up = await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, upgrade.id) });
    const d = await db.query.databases.findFirst({ where: eq(databases.id, upgrade.databaseId) });
    if (!up || up.status !== 'completed') throw refuse('database_upgrade_state', `Only a completed upgrade can be rolled back (this one is ${up?.status ?? 'gone'}).`);
    if (!d) throw refuse('database_upgrade_state', 'The database is gone.');
    if (d.volumeName !== up.targetVolume) throw refuse('database_upgrade_state', `The database no longer uses ${up.targetVolume}.`);
    if (d.pitrEnabled) throw refuse('database_upgrade_pitr', 'Point-in-time recovery is on: its archive and base backups belong to the upgraded cluster. Turn it off before rolling back.');
    if (!(await deps.volumeExists(up.previousVolume))) throw refuse('database_upgrade_state', `The previous volume ${up.previousVolume} is gone; nothing to roll back to.`);
    // Claim the rollback before anything stops: a racing finalize now finds it is no longer `completed`.
    const claimed = await db.update(databaseUpgrades).set({ status: 'rolled_back', switched: false, rolledBackAt: new Date() })
      .where(and(eq(databaseUpgrades.id, up.id), eq(databaseUpgrades.status, 'completed'))).returning({ id: databaseUpgrades.id });
    if (claimed.length === 0) throw refuse('database_upgrade_state', 'The upgrade changed meanwhile; reload and try again.');
    await db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, d.id));
    await deps.stopAndRemove(d.containerName!, log);
    await db.update(databases).set({ version: up.previousVersion, volumeName: up.previousVolume }).where(eq(databases.id, d.id));
    const back = (await db.query.databases.findFirst({ where: eq(databases.id, d.id) }))!;
    if (!(await bringUp(db, back, deps, log))) {
      throw new HttpError(500, 'database_upgrade_rollback_start', `The row points at ${up.previousVolume} again, but ${engineLabel(up.engine)} ${fromSeriesOf(up)} did not start; start it from the database page.`);
    }
  });
  void audit(db, actorId, 'database.upgrade.rollback', d0.name, { databaseId: d0.id, upgradeId: upgrade.id, fromMajor: upgrade.fromMajor, toMajor: upgrade.toMajor });
}

/**
 * Delete the volume the database no longer uses: the previous one after a
 * completed upgrade, the upgraded one after a rollback.
 */
export async function finalizeDatabaseUpgrade(db: DB, upgrade: UpgradeRow, actorId: number | null, deps: DatabaseUpgradeDeps = databaseUpgradeDeps): Promise<{ removedVolume: string }> {
  const d0 = await db.query.databases.findFirst({ where: eq(databases.id, upgrade.databaseId) });
  const log = (line: string) => logger.info(`database #${upgrade.databaseId} upgrade #${upgrade.id}: ${line}`);
  const work = async (): Promise<{ removedVolume: string; name: string }> => {
    // Re-read under the lock: a rollback may have switched the row since.
    const up = await db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, upgrade.id) });
    if (!up || (up.status !== 'completed' && up.status !== 'rolled_back')) {
      throw refuse('database_upgrade_state', `Only a completed or rolled-back upgrade can be finalized (this one is ${up?.status ?? 'gone'}).`);
    }
    const d = await db.query.databases.findFirst({ where: eq(databases.id, up.databaseId) });
    const unused = up.status === 'completed' ? up.previousVolume : up.targetVolume;
    if (d?.volumeName === unused) throw refuse('database_upgrade_state', `The database still uses ${unused}.`);
    if (await deps.volumeExists(unused)) {
      if (!(await deps.removeVolume(unused, log))) throw refuse('database_upgrade_volume_busy', `Volume ${unused} could not be removed (a container may still mount it).`);
    }
    await db.update(databaseUpgrades).set({ status: 'finalized', finalizedAt: new Date() })
      .where(and(eq(databaseUpgrades.id, up.id), eq(databaseUpgrades.status, up.status)));
    return { removedVolume: unused, name: d?.name ?? `#${up.databaseId}` };
  };
  // The database's lock serializes this with a rollback and an upgrade; a
  // database already deleted has nothing left to race with.
  const out = d0 ? await deps.maintenance(d0, log, work) : await work();
  void audit(db, actorId, 'database.upgrade.finalize', out.name, { databaseId: upgrade.databaseId, upgradeId: upgrade.id, removedVolume: out.removedVolume });
  return { removedVolume: out.removedVolume };
}

/**
 * Boot: an upgrade the panel was running when it stopped. Its helpers go; a
 * database the row never switched starts again on its previous volume (the new
 * one is removed); a switched one gets one start on the new volume, else it
 * is pointed back.
 */
export async function recoverInterruptedUpgrades(db: DB, deps: DatabaseUpgradeDeps = databaseUpgradeDeps): Promise<number> {
  const rows = await db.query.databaseUpgrades.findMany({ where: eq(databaseUpgrades.status, 'running') });
  for (const up of rows) {
    const d = await db.query.databases.findFirst({ where: eq(databases.id, up.databaseId) });
    const log = (line: string) => logger.warn(`database #${up.databaseId} upgrade #${up.id}: ${line}`);
    if (!d) {
      await db.update(databaseUpgrades).set({ status: 'failed', error: 'interrupted by a panel restart; the database is gone', completedAt: new Date() }).where(eq(databaseUpgrades.id, up.id));
      continue;
    }
    await deps.stopAndRemove(fenceName(d.slug), log).catch(() => undefined);
    await deps.stopAndRemove(stagingName(d.slug), log).catch(() => undefined);
    if (up.engine !== 'postgres') await deps.stopAndRemove(copierName(d.slug), log).catch(() => undefined);
    let note: string;
    if (up.switched && d.volumeName === up.targetVolume) {
      if (await bringUp(db, d, deps, log)) {
        await db.update(databaseUpgrades).set({ status: 'completed', phase: null, completedAt: new Date(), error: 'The panel restarted during the final start; the verified copy started afterwards.' }).where(eq(databaseUpgrades.id, up.id));
        continue;
      }
      await deps.stopAndRemove(d.containerName!, log).catch(() => undefined);
      await db.transaction(async (tx) => {
        await tx.update(databases).set({ version: up.previousVersion, volumeName: up.previousVolume }).where(eq(databases.id, d.id));
        await tx.update(databaseUpgrades).set({ switched: false }).where(eq(databaseUpgrades.id, up.id));
      });
      note = `the upgraded cluster did not start, so the database was pointed back; the upgraded volume ${up.targetVolume} is kept`;
    } else if (up.switched) {
      // Switched, yet the row names another volume: touch nothing, start what the row names.
      note = `the row no longer names the upgraded volume ${up.targetVolume}; nothing was deleted`;
    } else {
      note = 'the database was started on its previous volume';
      await db.update(databases).set({ version: up.previousVersion, volumeName: up.previousVolume }).where(eq(databases.id, d.id));
      if (up.targetVolume && (await deps.volumeExists(up.targetVolume))) await deps.removeVolume(up.targetVolume, log).catch(() => false);
    }
    const back = (await db.query.databases.findFirst({ where: eq(databases.id, d.id) }))!;
    const ok = (await deps.containerRunning(back.containerName!)) || (await bringUp(db, back, deps, log));
    if (ok) await db.update(databases).set({ status: 'running' }).where(eq(databases.id, d.id));
    await db.update(databaseUpgrades).set({ status: 'failed', error: `interrupted by a panel restart; ${note}${ok ? '' : ', but it did not start; start it from the database page'}`, completedAt: new Date() }).where(eq(databaseUpgrades.id, up.id));
  }
  return rows.length;
}

/** Housekeeping: failed and finalized upgrade records older than `maxAgeMs`. One that still holds a volume is never pruned. */
export async function pruneFinishedUpgrades(db: DB, maxAgeMs = 180 * 24 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - maxAgeMs);
  // A rolled-back upgrade still holds the upgraded volume until it is finalized.
  const stale = (await db.query.databaseUpgrades.findMany({ where: inArray(databaseUpgrades.status, ['failed', 'finalized']) }))
    .filter((r) => (r.completedAt ?? r.finalizedAt ?? r.createdAt) < cutoff);
  if (stale.length === 0) return 0;
  await db.delete(databaseUpgrades).where(inArray(databaseUpgrades.id, stale.map((r) => r.id)));
  return stale.length;
}
