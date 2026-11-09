/**
 * R3: point-in-time recovery over the database rows. engine/postgresPitr.ts
 * does the Docker work; this module decides what may happen, keeps the rows
 * consistent with it, and runs the long parts in the background.
 *
 * - Enabling recreates the running container with archiving and takes the
 *   first base backup; disabling recreates it without and deletes the archive.
 * - Base backups run one at a time per database, under its operation lock.
 * - A recovery creates a NEW database (the source is never touched): a row
 *   and a `pitr_recoveries` row at once (202), then the replay, the start and
 *   a credential probe in the background. A failed recovery removes the new
 *   database again and keeps only the recovery row with a fixed diagnostic.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { databases, pitrRecoveries, type Database, type DB } from '@ninedeploy/db';
import { encrypt, randomToken } from './crypto.js';
import { conflict, HttpError, unprocessable } from './errors.js';
import { slugify } from './slug.js';
import { audit } from './audit.js';
import { probeDatabaseCredentials, removeVolume, startDatabase, stopDatabase, volumeExists, ENGINES, defaultPort } from '../engine/database.js';
import { pitrArchiveVolume } from '../engine/pitrArchive.js';
import {
  archivingFailing,
  PitrRefusal,
  pitrArchiverStats,
  pitrPreflight,
  prunePitrArchive,
  readPitrInventory,
  recoverableRanges,
  recoverPostgresToPoint,
  removePitrArchive,
  takePitrBaseBackup,
  type PitrArchiverStats,
  type PitrInventory,
  type PitrRecoveryOutcome,
} from '../engine/postgresPitr.js';

/** A new base backup once the newest is this old (the scheduler's interval). */
export const PITR_BASE_BACKUP_INTERVAL_MS = 24 * 60 * 60_000;
export const PITR_MAX_RETENTION_DAYS = 35;

/** Databases with a base backup running in this process. */
const baseBackupsRunning = new Set<number>();
/** Source databases with a recovery running in this process (their archive must not be pruned). */
const recoveriesRunning = new Set<number>();
/** One recovery at a time on the panel host: a replay is CPU, memory and disk heavy. */
export const MAX_PITR_RECOVERIES = 1;

export const pitrBusy = {
  baseBackup: (id: number) => baseBackupsRunning.has(id),
  recovery: (id: number) => recoveriesRunning.has(id),
  recoveries: () => recoveriesRunning.size,
};

export interface PitrDeps {
  start(d: Database, log: (line: string) => void): Promise<void>;
  stop(d: Database, log: (line: string) => void): Promise<void>;
  probe(d: Database): Promise<boolean>;
  preflight(d: Database): Promise<string | null>;
  archiveExists(d: Database): Promise<boolean>;
  removeArchive(d: Database, log: (line: string) => void): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  removeVolume(name: string, log: (line: string) => void): Promise<void>;
  baseBackup(d: Database, log: (line: string) => void): Promise<string>;
  prune(d: Database, retentionDays: number, log: (line: string) => void): Promise<{ removedBases: string[] }>;
  inventory(d: Database): Promise<PitrInventory>;
  archiver(d: Database): Promise<PitrArchiverStats | null>;
  recover(source: Database, target: Database, targetTime: Date | null, log: (line: string) => void): Promise<PitrRecoveryOutcome>;
}

// Wrappers, not references: a test that mocks the engine modules sees its mocks.
export const pitrDeps: PitrDeps = {
  start: (d, log) => startDatabase(d, log),
  stop: (d, log) => stopDatabase(d, log),
  probe: (d) => probeDatabaseCredentials(d, 45, 2_000),
  preflight: (d) => pitrPreflight(d),
  archiveExists: (d) => (d.volumeName ? volumeExists(pitrArchiveVolume(d.volumeName)) : Promise.resolve(false)),
  removeArchive: (d, log) => removePitrArchive(d, log),
  volumeExists: (name) => volumeExists(name),
  removeVolume: (name, log) => removeVolume(name, log),
  baseBackup: (d, log) => takePitrBaseBackup(d, log),
  prune: (d, days, log) => prunePitrArchive(d, days, log),
  inventory: (d) => readPitrInventory(d),
  archiver: (d) => pitrArchiverStats(d),
  recover: (source, target, at, log) => recoverPostgresToPoint(source, target, at, log),
};

/** Why `d` cannot use point-in-time recovery at all, or null. */
export function pitrUnavailable(d: Pick<Database, 'engine' | 'serverId' | 'previewCopyOf' | 'previewServiceId'>): string | null {
  if (d.engine !== 'postgres') return 'Point-in-time recovery is available for PostgreSQL databases.';
  if (d.serverId != null) return 'Point-in-time recovery is available for databases on the panel host, not yet on nodes.';
  if (d.previewCopyOf != null || d.previewServiceId != null) return "A preview's database copy does not archive its WAL.";
  return null;
}

async function reload(db: DB, id: number): Promise<Database> {
  const row = await db.query.databases.findFirst({ where: eq(databases.id, id) });
  if (!row) throw new HttpError(404, 'not_found', 'Database not found');
  return row;
}

/** Stop and start `d` so its container picks up (or drops) the archiving flags; a failed start marks it `error`. */
async function recreate(d: Database, log: (line: string) => void, deps: PitrDeps): Promise<void> {
  await deps.stop(d, log);
  await deps.start(d, log);
}

/**
 * Turn PITR on or off, or change its retention. Enabling needs the database
 * running (the preflight asks the server itself); the first base backup runs
 * in the background and its outcome lands on the row.
 */
export async function setPitr(
  db: DB,
  d: Database,
  input: { enabled: boolean; retentionDays?: number },
  actor: number | null,
  log: (line: string) => void,
  deps: PitrDeps = pitrDeps,
): Promise<Database> {
  const unavailable = pitrUnavailable(d);
  if (unavailable) throw unprocessable(unavailable, 'pitr_unavailable');
  const retentionDays = input.retentionDays ?? d.pitrRetentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > PITR_MAX_RETENTION_DAYS) {
    throw unprocessable(`retentionDays must be between 1 and ${PITR_MAX_RETENTION_DAYS}`, 'pitr_retention_invalid');
  }
  if (input.enabled === d.pitrEnabled) {
    if (retentionDays !== d.pitrRetentionDays) {
      await db.update(databases).set({ pitrRetentionDays: retentionDays }).where(eq(databases.id, d.id));
      void audit(db, actor, 'database.pitr_retention', `${d.name}: ${retentionDays} day(s)`);
    }
    return reload(db, d.id);
  }
  if (input.enabled) {
    if (d.status !== 'running') throw conflict('The database must be running to enable point-in-time recovery');
    const why = await deps.preflight(d);
    if (why) throw unprocessable(why, 'pitr_preflight');
    if (await deps.archiveExists(d)) {
      throw new HttpError(
        409,
        'pitr_archive_exists',
        `A WAL archive volume ${pitrArchiveVolume(d.volumeName ?? '')} is left from an earlier database; delete it (Volumes) before enabling point-in-time recovery.`,
      );
    }
    await db.update(databases).set({ pitrEnabled: true, pitrRetentionDays: retentionDays, pitrBaseBackupAt: null, pitrLastError: null }).where(eq(databases.id, d.id));
    const on = await reload(db, d.id);
    try {
      await recreate(on, log, deps);
    } catch (err) {
      // Put the database back the way it ran: without archiving.
      await db.update(databases).set({ pitrEnabled: false }).where(eq(databases.id, d.id));
      const off = await reload(db, d.id);
      try { await deps.start(off, log); } catch { await db.update(databases).set({ status: 'error' }).where(eq(databases.id, d.id)); }
      throw unprocessable(`The database did not start with WAL archiving: ${err instanceof Error ? err.message : String(err)}`, 'pitr_start_failed');
    }
    void audit(db, actor, 'database.pitr_enable', `${d.name}: retention ${retentionDays} day(s)`);
    void runPitrBaseBackup(db, on, actor, log, deps).catch(() => undefined);
    return reload(db, d.id);
  }
  // Disabling: the archive goes with it.
  if (recoveriesRunning.has(d.id) || baseBackupsRunning.has(d.id)) {
    throw new HttpError(409, 'pitr_busy', 'A recovery or a base backup is using the WAL archive; try again when it finishes.');
  }
  await db.update(databases).set({ pitrEnabled: false, pitrBaseBackupAt: null, pitrLastError: null, pitrRetentionDays: retentionDays }).where(eq(databases.id, d.id));
  const off = await reload(db, d.id);
  if (off.status === 'running') {
    try {
      await recreate(off, log, deps);
    } catch (err) {
      await db.update(databases).set({ status: 'error' }).where(eq(databases.id, d.id));
      throw err;
    }
  }
  await deps.removeArchive(off, log);
  void audit(db, actor, 'database.pitr_disable', `${d.name}: WAL archive deleted`);
  return reload(db, d.id);
}

/** Take one base backup now; the row records the outcome. 409 while one runs. */
export async function runPitrBaseBackup(db: DB, d: Database, actor: number | null, log: (line: string) => void, deps: PitrDeps = pitrDeps): Promise<string> {
  if (baseBackupsRunning.has(d.id)) throw new HttpError(409, 'pitr_base_backup_running', 'A base backup of this database is already running.');
  baseBackupsRunning.add(d.id);
  try {
    const label = await deps.baseBackup(d, log);
    await db.update(databases).set({ pitrBaseBackupAt: new Date(), pitrLastError: null }).where(eq(databases.id, d.id));
    void audit(db, actor, 'database.pitr_base_backup', `${d.name}: ${label}`);
    return label;
  } catch (err) {
    await db.update(databases).set({ pitrLastError: 'The last base backup failed; see the panel log.' }).where(eq(databases.id, d.id));
    void audit(db, actor, 'database.pitr_failure', `${d.name}: base backup failed (${err instanceof Error ? err.message : String(err)})`);
    throw err;
  } finally {
    baseBackupsRunning.delete(d.id);
  }
}

export interface PitrStatus {
  available: boolean;
  unavailableReason: string | null;
  enabled: boolean;
  retentionDays: number;
  lastBaseBackupAt: string | null;
  lastError: string | null;
  baseBackupRunning: boolean;
  recoveryRunning: boolean;
  /** pg_stat_archiver of the running database. */
  archiving: { failing: boolean; archivedCount: number; lastArchivedAt: string | null; failedCount: number; lastFailedAt: string | null } | null;
  /** What a recovery can reach right now (a gap in the archive splits it). */
  recoverable: Array<{ from: string; to: string }>;
  baseBackups: Array<{ label: string; startedAt: string; finishedAt: string; sizeBytes: number }>;
  archiveBytes: number;
  segmentCount: number;
}

export async function pitrStatus(d: Database, deps: PitrDeps = pitrDeps): Promise<PitrStatus> {
  const unavailableReason = pitrUnavailable(d);
  const status: PitrStatus = {
    available: unavailableReason === null,
    unavailableReason,
    enabled: d.pitrEnabled,
    retentionDays: d.pitrRetentionDays,
    lastBaseBackupAt: d.pitrBaseBackupAt ? d.pitrBaseBackupAt.toISOString() : null,
    lastError: d.pitrLastError,
    baseBackupRunning: baseBackupsRunning.has(d.id),
    recoveryRunning: recoveriesRunning.has(d.id),
    archiving: null,
    recoverable: [],
    baseBackups: [],
    archiveBytes: 0,
    segmentCount: 0,
  };
  if (!d.pitrEnabled || unavailableReason) return status;
  const [inv, stats] = await Promise.all([deps.inventory(d), deps.archiver(d).catch(() => null)]);
  status.recoverable = recoverableRanges(inv).map((r) => ({ from: r.from.toISOString(), to: r.to.toISOString() }));
  status.baseBackups = inv.baseBackups.map((b) => ({ label: b.label, startedAt: b.startedAt.toISOString(), finishedAt: b.finishedAt.toISOString(), sizeBytes: b.sizeBytes }));
  status.archiveBytes = inv.archiveBytes;
  status.segmentCount = inv.segments.length;
  if (stats) {
    status.archiving = {
      failing: archivingFailing(stats),
      archivedCount: stats.archivedCount,
      lastArchivedAt: stats.lastArchivedAt?.toISOString() ?? null,
      failedCount: stats.failedCount,
      lastFailedAt: stats.lastFailedAt?.toISOString() ?? null,
    };
  }
  return status;
}

/** A recovery's fixed diagnostic: an operator-actionable refusal as is, anything else generic. */
function recoveryError(err: unknown): string {
  return err instanceof PitrRefusal ? err.message : 'The recovery failed; the panel log has the details.';
}

/**
 * Admit a recovery of `source` into a new database named `name`: insert both
 * rows and return at once; the replay runs in the background. `onSettled`
 * (tests) resolves when it is done.
 */
export async function startPitrRecovery(
  db: DB,
  source: Database,
  input: { name: string; targetTime: Date | null },
  actor: number,
  log: (line: string) => void,
  deps: PitrDeps = pitrDeps,
  onSettled?: (outcome: { status: 'completed' | 'failed'; error: string | null }) => void,
): Promise<{ recoveryId: number; databaseId: number }> {
  const unavailable = pitrUnavailable(source);
  if (unavailable) throw unprocessable(unavailable, 'pitr_unavailable');
  if (!source.pitrEnabled) throw unprocessable('Point-in-time recovery is not enabled for this database.', 'pitr_disabled');
  if (input.targetTime && input.targetTime.getTime() > Date.now()) throw unprocessable('The target time is in the future.', 'pitr_target_future');
  if (recoveriesRunning.size >= MAX_PITR_RECOVERIES) {
    throw new HttpError(409, 'pitr_recovery_busy', 'Another point-in-time recovery is running on this panel. Try again when it finishes.');
  }
  // slugify falls back to a fixed word for a name without letters or digits.
  if (!/[a-z0-9]/i.test(input.name)) throw unprocessable('The name must contain letters or digits.', 'pitr_name_invalid');
  const slug = slugify(input.name);
  const volumeName = `nd-db-${slug}-data`;
  const cfg = ENGINES.postgres!;
  recoveriesRunning.add(source.id);
  let target: Database;
  let recoveryId: number;
  try {
    if (await db.query.databases.findFirst({ where: eq(databases.slug, slug) })) throw conflict('A database already uses this name');
    if (await deps.volumeExists(volumeName)) throw conflict(`A retained volume ${volumeName} already exists; pick another name.`);
    const [row] = await db
      .insert(databases)
      .values({
        projectId: source.projectId,
        ownerUserId: actor,
        name: input.name,
        slug,
        engine: 'postgres',
        version: source.version,
        status: 'creating',
        containerName: `nd-db-${slug}`,
        volumeName,
        username: source.username ?? cfg.username() ?? null,
        passwordEncrypted: encrypt(randomToken(18)),
        dbName: source.dbName ?? cfg.dbName() ?? null,
        extensions: source.extensions ?? [],
        cpuShares: source.cpuShares,
        cpuLimitMilli: source.cpuLimitMilli,
        memLimitMb: source.memLimitMb,
      })
      .returning();
    target = row!;
    const [recovery] = await db
      .insert(pitrRecoveries)
      .values({ sourceDatabaseId: source.id, databaseId: target.id, targetTime: input.targetTime, status: 'running', requestedBy: actor })
      .returning({ id: pitrRecoveries.id });
    recoveryId = recovery!.id;
  } catch (err) {
    recoveriesRunning.delete(source.id);
    throw err;
  }
  const what = input.targetTime ? input.targetTime.toISOString() : 'the latest archived point';
  void audit(db, actor, 'database.pitr_recover', `${source.name} → ${target.name}: recovery to ${what} started (#${recoveryId})`);
  const tag = `pitr-${randomUUID().slice(0, 8)}`;
  const runLog = (line: string) => log(`[${tag}] ${line}`);

  void (async () => {
    let started = false;
    try {
      const outcome = await deps.recover(source, target, input.targetTime, runLog);
      await deps.start(target, runLog);
      started = true;
      if (!(await deps.probe(target))) throw new Error(`${target.containerName} did not accept its credentials after the recovery`);
      await db
        .update(databases)
        .set({ status: 'running', internalHost: target.containerName, internalPort: defaultPort('postgres'), initializedAt: new Date() })
        .where(eq(databases.id, target.id));
      await db
        .update(pitrRecoveries)
        .set({ status: 'completed', baseBackup: outcome.baseBackup, recoveredTo: outcome.recoveredTo, restoreMs: outcome.restoreMs, completedAt: new Date() })
        .where(eq(pitrRecoveries.id, recoveryId));
      void audit(db, actor, 'database.pitr_recover', `${source.name} → ${target.name}: recovered to ${outcome.recoveredTo} (#${recoveryId})`);
      onSettled?.({ status: 'completed', error: null });
    } catch (err) {
      runLog(`recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      if (started) await deps.stop(target, runLog).catch(() => undefined);
      await deps.removeVolume(volumeName, runLog).catch(() => undefined);
      const error = recoveryError(err);
      await db.update(pitrRecoveries).set({ status: 'failed', error, databaseId: null, completedAt: new Date() }).where(eq(pitrRecoveries.id, recoveryId)).catch(() => undefined);
      await db.delete(databases).where(eq(databases.id, target.id)).catch(() => undefined);
      void audit(db, actor, 'database.pitr_failure', `${source.name} → ${target.name}: recovery failed (#${recoveryId}): ${error}`);
      onSettled?.({ status: 'failed', error });
    } finally {
      recoveriesRunning.delete(source.id);
    }
  })();
  return { recoveryId, databaseId: target.id };
}

export const INTERRUPTED_RECOVERY_ERROR = 'The panel restarted during the recovery.';

/**
 * Boot: a recovery row still `running` belongs to a process that is gone.
 * Mark it failed and remove the half-made database it was creating (its row
 * is still `creating`; a database that already reached `running` is kept).
 */
export async function failInterruptedPitrRecoveries(db: DB, log: (line: string) => void, deps: PitrDeps = pitrDeps): Promise<number> {
  const stuck = await db.select().from(pitrRecoveries).where(eq(pitrRecoveries.status, 'running'));
  for (const r of stuck) {
    const target = r.databaseId != null ? await db.query.databases.findFirst({ where: eq(databases.id, r.databaseId) }) : undefined;
    if (target && target.status === 'creating') {
      await deps.stop(target, log).catch(() => undefined);
      if (target.volumeName) await deps.removeVolume(target.volumeName, log).catch(() => undefined);
      await db.delete(databases).where(eq(databases.id, target.id));
    }
    await db
      .update(pitrRecoveries)
      .set({ status: 'failed', error: INTERRUPTED_RECOVERY_ERROR, databaseId: target && target.status !== 'creating' ? target.id : null, completedAt: new Date() })
      .where(and(eq(pitrRecoveries.id, r.id), eq(pitrRecoveries.status, 'running')));
  }
  if (stuck.length) void audit(db, null, 'database.pitr_failure', `${stuck.length} point-in-time recovery(ies) interrupted by a panel restart were marked failed`);
  return stuck.length;
}

/**
 * The scheduler's pass over one database: report failing archiving, take a
 * base backup when the newest is a day old, then apply the retention. Errors
 * land on the row (`pitr_last_error`) and in the audit log, once per incident.
 */
export async function pitrMaintenance(db: DB, d: Database, log: (line: string) => void, deps: PitrDeps = pitrDeps, now = Date.now()): Promise<void> {
  if (!d.pitrEnabled || pitrUnavailable(d) || d.status !== 'running') return;
  const stats = await deps.archiver(d).catch(() => null);
  if (archivingFailing(stats)) {
    const message = `WAL archiving is failing (last failure ${stats!.lastFailedAt!.toISOString()}); see the database log.`;
    if (d.pitrLastError !== message) {
      await db.update(databases).set({ pitrLastError: message }).where(eq(databases.id, d.id));
      void audit(db, null, 'database.pitr_failure', `${d.name}: ${message}`);
    }
    // A base backup would wait for an archive that does not move.
    return;
  }
  if (!baseBackupsRunning.has(d.id) && (!d.pitrBaseBackupAt || now - d.pitrBaseBackupAt.getTime() >= PITR_BASE_BACKUP_INTERVAL_MS)) {
    await runPitrBaseBackup(db, d, null, log, deps).catch(() => undefined);
  }
  if (!recoveriesRunning.has(d.id) && !baseBackupsRunning.has(d.id)) {
    const current = await db.query.databases.findFirst({ where: eq(databases.id, d.id) });
    if (current?.pitrEnabled && !pitrUnavailable(current) && current.status === 'running' && !recoveriesRunning.has(d.id) && !baseBackupsRunning.has(d.id)) {
      await deps.prune(current, current.pitrRetentionDays, log).catch((err: unknown) => log(`WAL archive retention failed for ${d.name}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  const fresh = await db.query.databases.findFirst({ where: eq(databases.id, d.id) });
  if (fresh?.pitrLastError?.startsWith('WAL archiving is failing')) {
    await db.update(databases).set({ pitrLastError: null }).where(eq(databases.id, d.id));
  }
}

/** The databases the scheduler looks after. */
export async function pitrDatabases(db: DB): Promise<Database[]> {
  return db.select().from(databases).where(and(eq(databases.pitrEnabled, true), eq(databases.engine, 'postgres'), inArray(databases.status, ['running'])));
}

export { PITR_RECOVERY_MAX_AGE_MS, prunePitrRecoveries } from './pitrHousekeeping.js';
