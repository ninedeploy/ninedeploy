/**
 * A1 step 3: service volume import. A gzipped tar of another platform's
 * volume, uploaded in ordered chunks (modules/volumeImports.ts), is restored
 * into the service's data volume `nd-svc-<slug>-data` through the same
 * staged swap a volume backup restore uses (engine/database.ts
 * restoreVolume): the archive is listed, extracted into a staging directory
 * inside the volume and only then swapped in, so a corrupt archive or a full
 * disk leaves the volume as it was.
 *
 * - The declared sha256 is checked before anything else.
 * - A volume that already exists is snapshotted first (a `pre-import`
 *   volume backup), so an import can be undone with an ordinary restore.
 * - Staging lives in `<backupsDir>/volume-imports`, never in the database
 *   import directory: that sweep deletes any `<id>.part` no live database
 *   import owns, and the two id sequences overlap.
 *
 * Recovery and retention mirror database imports and run from the same
 * housekeeping plugin (plugins/databaseImports.ts).
 */
import { mkdirSync, statSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { backups, type DB, volumeImports } from '@ninedeploy/db';
import { config } from '../config.js';
import { backupVolume as engineBackupVolume, restoreVolume as engineRestoreVolume, volumeExists as engineVolumeExists } from '../engine/database.js';
import { audit } from './audit.js';
import { removeStaging, sha256File as hashFile } from './databaseImport.js';

export const VOLUME_IMPORT_SUBDIR = 'volume-imports';
export const STALE_VOLUME_IMPORT_MS = 24 * 60 * 60 * 1000;
export const FINISHED_VOLUME_IMPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const INTERRUPTED_VOLUME_IMPORT_ERROR = 'interrupted by panel restart';
const FINISHED = ['completed', 'failed', 'cancelled', 'expired'] as const;
const LIVE = ['uploading', 'pending', 'running'] as const;

export const volumeImportStagingDir = (): string => path.join(config.paths.backupsDir, VOLUME_IMPORT_SUBDIR);

type Row = typeof volumeImports.$inferSelect;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function serializeVolumeImport(r: Row) {
  return {
    id: r.id,
    serviceId: r.serviceId,
    volumeName: r.volumeName,
    status: r.status,
    sizeBytes: r.sizeBytes,
    receivedBytes: r.receivedBytes,
    chunkSize: r.chunkSize,
    sha256: r.sha256,
    filename: r.filename ?? null,
    safetyBackupId: r.safetyBackupId ?? null,
    error: r.error ?? null,
    createdByUserId: r.createdByUserId ?? null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
  };
}

export function volumeImportAuditMeta(r: Pick<Row, 'id' | 'serviceId' | 'volumeName' | 'sizeBytes'>) {
  return { importId: r.id, serviceId: r.serviceId, volumeName: r.volumeName, sizeBytes: r.sizeBytes };
}

/** Where a pre-import snapshot goes: the volume backups' own layout, so it lists, downloads and restores like any other. */
export function safetySnapshotFile(volumeName: string, now = new Date()): string {
  const safe = volumeName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dir = path.join(config.paths.backupsDir, 'volumes', safe);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${volumeName}-${now.toISOString().replace(/[:.]/g, '-')}-pre-import.tar.gz`);
}

export interface VolumeImportJobDeps {
  sha256File: (file: string) => Promise<string>;
  volumeExists: (name: string) => Promise<boolean>;
  backupVolume: (name: string, dest: string, log: (line: string) => void) => Promise<void>;
  restoreVolume: (name: string, src: string, log: (line: string) => void) => Promise<void>;
  snapshotFile: (name: string) => string;
}
const defaultDeps: VolumeImportJobDeps = {
  sha256File: hashFile,
  volumeExists: engineVolumeExists,
  backupVolume: engineBackupVolume,
  restoreVolume: engineRestoreVolume,
  snapshotFile: (name) => safetySnapshotFile(name),
};

class VolumeImportRefusal extends Error {}

const clip = (s: string): string => (s.length > 2000 ? `${s.slice(0, 2000)}…` : s);

/** Check, snapshot and restore one `running` import. Never throws: the row records the outcome. */
export async function runVolumeImportJob(
  db: DB,
  importId: number,
  ctx: { actorId: number | null; log?: (line: string) => void },
  deps: VolumeImportJobDeps = defaultDeps,
): Promise<void> {
  const tail: string[] = [];
  const log = (line: string) => {
    tail.push(line);
    if (tail.length > 20) tail.shift();
    ctx.log?.(line);
  };
  const row = await db.query.volumeImports.findFirst({ where: eq(volumeImports.id, importId) }).catch(() => undefined);
  if (!row) return;
  const meta = volumeImportAuditMeta(row);
  try {
    if (!row.stagingPath) throw new VolumeImportRefusal('the uploaded file is gone');
    const got = await deps.sha256File(row.stagingPath);
    if (got !== row.sha256) throw new VolumeImportRefusal(`sha256 mismatch: the upload hashes to ${got}, not the ${row.sha256} it was declared with`);

    if (await deps.volumeExists(row.volumeName)) {
      const file = deps.snapshotFile(row.volumeName);
      const [b] = await db
        .insert(backups)
        .values({ databaseId: null, volumeName: row.volumeName, scope: 'volumes', status: 'running', path: file, label: 'pre-import' })
        .returning({ id: backups.id });
      try {
        await deps.backupVolume(row.volumeName, file, log);
      } catch (err) {
        await db.update(backups).set({ status: 'failed' }).where(eq(backups.id, b!.id));
        throw new Error(`the snapshot before the import failed, so the volume was not touched: ${err instanceof Error ? err.message : String(err)}`);
      }
      const sizeBytes = (() => {
        try {
          return statSync(file).size;
        } catch {
          return 0;
        }
      })();
      await db.update(backups).set({ status: 'completed', sizeBytes }).where(eq(backups.id, b!.id));
      await db.update(volumeImports).set({ safetyBackupId: b!.id }).where(eq(volumeImports.id, row.id));
      void audit(db, ctx.actorId, 'volume.import.safety_backup', row.volumeName, { ...meta, backupId: b!.id, backupSizeBytes: sizeBytes });
    }

    log(`Restoring the uploaded archive into ${row.volumeName}`);
    try {
      await deps.restoreVolume(row.volumeName, row.stagingPath, log);
    } catch (err) {
      const lines = tail.slice(-5).join(' | ');
      throw new Error(`${err instanceof Error ? err.message : String(err)}${lines ? ` — ${lines}` : ''}`);
    }
    await db
      .update(volumeImports)
      .set({ status: 'completed', error: null, completedAt: new Date(), stagingPath: null })
      .where(eq(volumeImports.id, row.id));
    void audit(db, ctx.actorId, 'volume.import.complete', row.volumeName, meta);
  } catch (err) {
    const message = clip(err instanceof Error ? err.message : String(err));
    await db
      .update(volumeImports)
      .set({ status: 'failed', error: message, completedAt: new Date(), stagingPath: null })
      .where(eq(volumeImports.id, row.id))
      .catch(() => undefined);
    void audit(db, ctx.actorId, 'volume.import.fail', row.volumeName, { ...meta, error: message });
  } finally {
    await removeStaging(row.stagingPath);
  }
}

// ── recovery and retention (plugins/databaseImports.ts) ────────────────────

/** Boot: every `running` row is the previous process's. The volume is untouched or fully swapped (the restore is staged). */
export async function recoverInterruptedVolumeImports(db: DB): Promise<number[]> {
  const running = await db.query.volumeImports.findMany({ where: eq(volumeImports.status, 'running') });
  const stuck: number[] = [];
  for (const r of running) {
    const [hit] = await db
      .update(volumeImports)
      .set({ status: 'failed', error: INTERRUPTED_VOLUME_IMPORT_ERROR, completedAt: new Date(), stagingPath: null })
      .where(and(eq(volumeImports.id, r.id), eq(volumeImports.status, 'running')))
      .returning({ id: volumeImports.id });
    if (!hit) continue;
    await removeStaging(r.stagingPath);
    stuck.push(hit.id);
  }
  if (stuck.length > 0) {
    void audit(db, null, 'volume.import.fail', `${stuck.length} volume import(s) interrupted by a panel restart`, { importIds: stuck, error: INTERRUPTED_VOLUME_IMPORT_ERROR });
  }
  return stuck;
}

/** `uploading` / `pending` imports idle for 24h become `expired`; their staging is deleted. */
export async function expireStaleVolumeImports(db: DB, now = Date.now()): Promise<number[]> {
  const stale = await db.query.volumeImports.findMany({
    where: and(inArray(volumeImports.status, ['uploading', 'pending']), lt(volumeImports.updatedAt, new Date(now - STALE_VOLUME_IMPORT_MS))),
  });
  const expired: number[] = [];
  for (const r of stale) {
    const [hit] = await db
      .update(volumeImports)
      .set({ status: 'expired', error: 'expired: no activity for 24 hours', completedAt: new Date(now), stagingPath: null })
      .where(and(eq(volumeImports.id, r.id), inArray(volumeImports.status, ['uploading', 'pending'])))
      .returning({ id: volumeImports.id });
    if (!hit) continue;
    await removeStaging(r.stagingPath);
    expired.push(r.id);
  }
  return expired;
}

/** Retention: finished rows older than 90 days are deleted. */
export async function pruneFinishedVolumeImports(db: DB, now = Date.now()): Promise<number> {
  const gone = await db
    .delete(volumeImports)
    .where(and(inArray(volumeImports.status, [...FINISHED]), lt(volumeImports.createdAt, new Date(now - FINISHED_VOLUME_IMPORT_RETENTION_MS))))
    .returning({ id: volumeImports.id });
  return gone.length;
}

/** `<id>.part` files in the volume staging directory that no live volume import owns, older than 24h. */
export async function pruneOrphanVolumeStaging(db: DB, dir = volumeImportStagingDir(), now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const live = new Set(
    (await db.select({ id: volumeImports.id }).from(volumeImports).where(inArray(volumeImports.status, [...LIVE]))).map((r) => r.id),
  );
  let removed = 0;
  for (const name of names) {
    const m = /^(\d+)\.part$/.exec(name);
    if (!m || live.has(Number(m[1]))) continue;
    const file = path.join(dir, name);
    try {
      const st = await stat(file);
      if (!st.isFile() || now - st.mtimeMs < STALE_VOLUME_IMPORT_MS) continue;
      await rm(file, { force: true });
      removed++;
    } catch {
      /* raced with another sweep */
    }
  }
  return removed;
}
