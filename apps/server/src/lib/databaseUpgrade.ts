/**
 * O2 (competitive roadmap): a one-click major-version upgrade of a managed
 * PostgreSQL database on the panel host, by dump and restore into a NEW volume.
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
import {
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

export type UpgradePhase = 'pull' | 'stop' | 'dump' | 'restore' | 'verify' | 'switch' | 'start';

export interface ClusterFingerprint {
  /** `schema.table` → exact row count, user tables only (extension-owned excluded). */
  rows: Record<string, string>;
  /** `schema.sequence` → last_value (`null` when never called). */
  sequences: Record<string, string>;
  objects: { indexes: number; constraints: number; views: number; triggers: number; functions: number; extensions: string };
}

export interface UpgradeVerification {
  tables: number;
  rows: number;
  sequences: number;
  objects: ClusterFingerprint['objects'];
}

/** Everything that touches Docker, injectable for tests. */
export interface DatabaseUpgradeDeps {
  psql(container: string, sql: string, opts?: { database?: string }): Promise<string>;
  containerImage(container: string): Promise<{ id: string; tag: string } | null>;
  containerRunning(container: string): Promise<boolean>;
  pull(image: string, log: (line: string) => void): Promise<void>;
  /** Graceful stop, then remove (the volume stays). */
  stopAndRemove(container: string, log: (line: string) => void): Promise<void>;
  runIsolated(d: Database, spec: { name: string; image: string; volume: string; mount: string }, log: (line: string) => void): Promise<void>;
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
  waitReady: async (container, _d, log) => {
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
/** The new volume. Resolves to its database in the inventory (lib/inventory.ts). */
export const upgradeVolumeName = (slug: string, upgradeId: number) => `nd-db-${slug}-data-u${upgradeId}`;

const refuse = (code: string, message: string) => new HttpError(409, code, message);

/** Why this database cannot be upgraded at all (before any cluster query), or null. */
export function upgradeRefusal(d: Database): { code: string; message: string } | null {
  if (d.serverId != null) return { code: 'database_upgrade_node', message: 'A major upgrade runs on the panel host only for now; this database lives on a node.' };
  if (d.engine !== 'postgres') return { code: 'database_upgrade_engine', message: `A major upgrade is available for PostgreSQL only for now, not ${d.engine}.` };
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
    throw conflict(`A major upgrade of this database is running (to PostgreSQL ${open.toMajor}); wait for it to finish.`);
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
}

/**
 * Everything checked before an upgrade is admitted — against the RUNNING
 * cluster, so a refusal never costs downtime. Throws an HttpError naming what
 * to change.
 */
export async function planUpgrade(db: DB, d: Database, toMajor: number, deps: DatabaseUpgradeDeps = databaseUpgradeDeps): Promise<UpgradePlan> {
  const refusal = upgradeRefusal(d);
  if (refusal) throw refuse(refusal.code, refusal.message);
  const open = await openUpgrade(db, d.id);
  if (open?.status === 'running') throw refuse('database_upgrade_running', `An upgrade to PostgreSQL ${open.toMajor} is already running.`);
  if (open?.status === 'completed') {
    throw refuse('database_upgrade_unfinalized', `The upgrade to PostgreSQL ${open.toMajor} still keeps the previous volume ${open.previousVolume}. Finalize it (or roll it back) before another upgrade.`);
  }
  if (d.status !== 'running' || !(await deps.containerRunning(d.containerName!))) {
    throw refuse('database_upgrade_not_running', 'The database must be running: the upgrade reads the live cluster before it stops anything.');
  }
  const fromImage = await deps.containerImage(d.containerName!);
  if (!fromImage) throw refuse('database_upgrade_not_running', `Could not inspect ${d.containerName}.`);
  const facts = await readClusterFacts(deps, d.containerName!);
  if (!(POSTGRES_UPGRADE_MAJORS as readonly number[]).includes(toMajor)) {
    throw badRequest(`PostgreSQL ${toMajor} is not a supported target (supported: ${POSTGRES_UPGRADE_MAJORS.join(', ')}).`, 'database_upgrade_target');
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
  return { facts, fromImage, toImage: ENGINES.postgres!.image(targetVersion), targetVersion };
}

/** What the options route shows: the live major, the targets, and why none can start now. */
export async function upgradeOptions(db: DB, d: Database, deps: DatabaseUpgradeDeps = databaseUpgradeDeps): Promise<{ currentMajor: number | null; targets: number[]; refusal: { code: string; message: string } | null }> {
  const refusal = upgradeRefusal(d);
  if (refusal) return { currentMajor: null, targets: [], refusal };
  const open = await openUpgrade(db, d.id);
  if (open?.status === 'running') return { currentMajor: open.fromMajor, targets: [], refusal: { code: 'database_upgrade_running', message: `An upgrade to PostgreSQL ${open.toMajor} is running.` } };
  if (open?.status === 'completed') return { currentMajor: open.toMajor, targets: [], refusal: { code: 'database_upgrade_unfinalized', message: `Finalize (or roll back) the upgrade to PostgreSQL ${open.toMajor} before another one.` } };
  if (d.status !== 'running' || !(await deps.containerRunning(d.containerName!))) {
    return { currentMajor: null, targets: [], refusal: { code: 'database_upgrade_not_running', message: 'Start the database first: the upgrade reads the live cluster.' } };
  }
  try {
    const versionNum = Number.parseInt((await deps.psql(d.containerName!, `SELECT current_setting('server_version_num')`)).trim(), 10);
    const currentMajor = Math.floor(versionNum / 10_000);
    const targets = upgradeTargets(currentMajor);
    return { currentMajor, targets, refusal: targets.length === 0 ? { code: 'database_upgrade_latest', message: `PostgreSQL ${currentMajor} is the newest major offered.` } : null };
  } catch (err) {
    return { currentMajor: null, targets: [], refusal: { code: 'database_upgrade_not_running', message: `Could not read the server version: ${err instanceof Error ? err.message : String(err)}` } };
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
      toMajor: Number.parseInt(plan.targetVersion, 10),
      // The row's tag can disagree with the data (a NULL version follows the
      // engine default, which may have moved on since the cluster was made):
      // every way back starts the image this value names, so it must be the
      // major the cluster really runs.
      previousVersion: postgresMajor(d.version) === plan.facts.major ? d.version : String(plan.facts.major),
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
  return out;
}

export function verificationSummary(fp: ClusterFingerprint): UpgradeVerification {
  return {
    tables: Object.keys(fp.rows).length,
    rows: Object.values(fp.rows).reduce((sum, n) => sum + (Number(n) || 0), 0),
    sequences: Object.keys(fp.sequences).length,
    objects: fp.objects,
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

  try {
    await deps.maintenance(d0, log, async () => {
      // Admission happened before the lock: re-read, so an upgrade queued
      // behind another (or a rollback) never runs from a stale plan.
      const current = await db.query.databases.findFirst({ where: eq(databases.id, d0.id) });
      if (!current || current.volumeName !== up0.previousVolume || current.status !== 'running') {
        throw new Error('the database changed since the upgrade was admitted; start it again');
      }
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
      await mkdir(config.paths.backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(config.paths.backupsDir, `${d0.slug}-${stamp}-pre-upgrade.dump`);
      const [b] = await db.insert(backups).values({ databaseId: d0.id, scope: 'db', label: 'pre-upgrade', status: 'running', path: file }).returning({ id: backups.id });
      try {
        await deps.dump({ ...d0, containerName: fence }, file, log);
      } catch (err) {
        await db.update(backups).set({ status: 'failed' }).where(eq(backups.id, b!.id));
        throw err;
      }
      await db.update(backups).set({ status: 'completed', sizeBytes: await deps.fileSize(file) }).where(eq(backups.id, b!.id));
      await db.update(databaseUpgrades).set({ safetyBackupId: b!.id }).where(eq(databaseUpgrades.id, upgradeId));
      await deps.stopAndRemove(fence, log);

      await phase('restore');
      const target: Database = { ...d0, version: up0.targetVersion, volumeName: up0.targetVolume };
      if (await deps.volumeExists(up0.targetVolume)) throw new Error(`volume ${up0.targetVolume} already exists`);
      await deps.createVolume(up0.targetVolume, databaseVolumeLabels(target), log);
      createdVolume = true;
      await deps.runIsolated(target, { name: staging, image: up0.toImage, volume: up0.targetVolume, mount: resolveVolumePath(ENGINES.postgres!, up0.targetVersion) }, log);
      if (!(await deps.waitReady(staging, target, log))) throw new Error(`PostgreSQL ${up0.toMajor} did not come up on the new volume`);
      await deps.restore({ ...target, containerName: staging }, file, log);
      await deps.psql(staging, 'ANALYZE').catch(() => undefined);

      await phase('verify');
      const after = await clusterFingerprint(deps, staging);
      const diff = compareFingerprints(before, after);
      await db.update(databaseUpgrades).set({ verification: JSON.stringify({ ...verificationSummary(before), mismatches: diff.slice(0, 50) }) }).where(eq(databaseUpgrades.id, upgradeId));
      if (diff.length > 0) throw new Error(`the restored copy does not match the old cluster: ${diff.slice(0, 5).join('; ')}${diff.length > 5 ? ` (+${diff.length - 5} more)` : ''}`);
      await deps.stopAndRemove(staging, log);

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
      if (!(await deps.waitReady(fresh.containerName!, fresh, log))) throw new Error(`PostgreSQL ${up0.toMajor} did not accept connections after the switch`);
      await db.update(databases).set({ status: 'running' }).where(eq(databases.id, d0.id));
      await db.update(databaseUpgrades).set({ status: 'completed', phase: null, completedAt: new Date() }).where(eq(databaseUpgrades.id, upgradeId));
    });
    log(`upgraded ${d0.name} to PostgreSQL ${up0.toMajor}; the previous volume ${up0.previousVolume} is kept until the upgrade is finalized`);
    void audit(db, ctx.actorId, 'database.upgrade.complete', d0.name, meta);
  } catch (err) {
    const message = clip(err instanceof Error ? err.message : String(err));
    log(`upgrade failed: ${message}`);
    // The helpers exist only once the old container is stopped.
    if (stopped) {
      await deps.stopAndRemove(fence, log).catch(() => undefined);
      await deps.stopAndRemove(staging, log).catch(() => undefined);
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
      outcome = (up ? `The database runs on PostgreSQL ${up0.fromMajor} as before.` : `The database could not be started again on PostgreSQL ${up0.fromMajor}; start it from the database page.`) + kept;
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
  if (upgrade.status !== 'completed') throw refuse('database_upgrade_state', `Only a completed upgrade can be rolled back (this one is ${upgrade.status}).`);
  const d = await db.query.databases.findFirst({ where: eq(databases.id, upgrade.databaseId) });
  if (!d) throw refuse('database_upgrade_state', 'The database is gone.');
  if (d.volumeName !== upgrade.targetVolume) throw refuse('database_upgrade_state', `The database no longer uses ${upgrade.targetVolume}.`);
  if (d.pitrEnabled) throw refuse('database_upgrade_pitr', 'Point-in-time recovery is on: its archive and base backups belong to the upgraded cluster. Turn it off before rolling back.');
  if (!(await deps.volumeExists(upgrade.previousVolume))) throw refuse('database_upgrade_state', `The previous volume ${upgrade.previousVolume} is gone; nothing to roll back to.`);
  const log = (line: string) => logger.info(`database #${d.id} upgrade #${upgrade.id}: ${line}`);
  await deps.maintenance(d, log, async () => {
    await db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, d.id));
    await deps.stopAndRemove(d.containerName!, log);
    await db.transaction(async (tx) => {
      await tx.update(databases).set({ version: upgrade.previousVersion, volumeName: upgrade.previousVolume }).where(eq(databases.id, d.id));
      await tx.update(databaseUpgrades).set({ status: 'rolled_back', switched: false, rolledBackAt: new Date() }).where(eq(databaseUpgrades.id, upgrade.id));
    });
    const back = (await db.query.databases.findFirst({ where: eq(databases.id, d.id) }))!;
    if (!(await bringUp(db, back, deps, log))) {
      throw new HttpError(500, 'database_upgrade_rollback_start', `The row points at ${upgrade.previousVolume} again, but PostgreSQL ${upgrade.fromMajor} did not start; start it from the database page.`);
    }
  });
  void audit(db, actorId, 'database.upgrade.rollback', d.name, { databaseId: d.id, upgradeId: upgrade.id, fromMajor: upgrade.fromMajor, toMajor: upgrade.toMajor });
}

/**
 * Delete the volume the database no longer uses: the previous one after a
 * completed upgrade, the upgraded one after a rollback.
 */
export async function finalizeDatabaseUpgrade(db: DB, upgrade: UpgradeRow, actorId: number | null, deps: DatabaseUpgradeDeps = databaseUpgradeDeps): Promise<{ removedVolume: string }> {
  if (upgrade.status !== 'completed' && upgrade.status !== 'rolled_back') {
    throw refuse('database_upgrade_state', `Only a completed or rolled-back upgrade can be finalized (this one is ${upgrade.status}).`);
  }
  const d = await db.query.databases.findFirst({ where: eq(databases.id, upgrade.databaseId) });
  const unused = upgrade.status === 'completed' ? upgrade.previousVolume : upgrade.targetVolume;
  if (d?.volumeName === unused) throw refuse('database_upgrade_state', `The database still uses ${unused}.`);
  const log = (line: string) => logger.info(`database #${upgrade.databaseId} upgrade #${upgrade.id}: ${line}`);
  if (await deps.volumeExists(unused)) {
    if (!(await deps.removeVolume(unused, log))) throw refuse('database_upgrade_volume_busy', `Volume ${unused} could not be removed (a container may still mount it).`);
  }
  await db.update(databaseUpgrades).set({ status: 'finalized', finalizedAt: new Date() }).where(eq(databaseUpgrades.id, upgrade.id));
  void audit(db, actorId, 'database.upgrade.finalize', d?.name ?? `#${upgrade.databaseId}`, { databaseId: upgrade.databaseId, upgradeId: upgrade.id, removedVolume: unused });
  return { removedVolume: unused };
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
