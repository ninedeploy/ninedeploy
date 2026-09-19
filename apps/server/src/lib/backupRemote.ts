import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { backups, type BackupDestination, type DB } from '@ninedeploy/db';
import { decrypt } from './crypto.js';
import { s3Delete, s3GetToFile, s3PutFile, type S3Config } from './s3.js';

type ResolvedDestination = S3Config & { prefix: string; id: number };

/** Resolve a destination row into an S3 client config. */
function toDestination(row: BackupDestination): ResolvedDestination {
  return {
    id: row.id,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    accessKeyId: row.accessKeyId,
    secretAccessKey: decrypt(row.secretKeyEncrypted),
  };
}

/**
 * Resolve the destination for a remote operation: the destination recorded
 * on the backup row first (the bucket that actually holds the object, even
 * after the ACTIVE destination changed), falling back to the active one for
 * legacy rows and rows whose destination was deleted. Returns null when the
 * table is unreadable (pre-migration) or nothing matches.
 */
async function resolveDestination(
  db: DB,
  preferredId: number | null | undefined,
): Promise<ResolvedDestination | null> {
  let rows: BackupDestination[];
  try {
    rows = await db.query.backupDestinations.findMany();
  } catch {
    return null; // table might not exist yet
  }
  const preferred = preferredId != null ? rows.find((d) => d.id === preferredId) : undefined;
  const row = preferred ?? rows.find((d) => d.active);
  return row ? toDestination(row) : null;
}

/** Resolve the first active destination into an S3 client config (or null). */
export async function activeDestination(db: DB): Promise<(S3Config & { prefix: string }) | null> {
  return resolveDestination(db, null);
}

/**
 * Upload a completed backup's ENCRYPTED envelope to the active destination and
 * stamp `remoteKey` + the destination on the row. Best-effort: an upload
 * failure is logged via the callback but never fails the backup itself (the
 * local copy remains). Streams from disk (multipart, bounded memory) — a
 * multi-GB dump must never enter the heap of the panel that also hosts the
 * deploy worker.
 */
export async function uploadBackup(
  db: DB,
  backupId: number,
  localPath: string,
  log: (line: string) => void,
): Promise<void> {
  const dest = await resolveDestination(db, null);
  if (!dest) return;
  const { prefix, ...cfg } = dest;
  const key = `${prefix.replace(/\/$/, '')}/${basename(localPath)}`.replace(/^\/+/, '');
  try {
    // The on-disk file is already the encrypted envelope, so a stolen bucket
    // alone can't leak database contents.
    await s3PutFile(cfg, key, localPath);
    await db.update(backups).set({ remoteKey: key, destinationId: dest.id }).where(eq(backups.id, backupId));
    log(`☁ Uploaded to ${dest.bucket}/${key}`);
  } catch (err) {
    log(`warning: remote upload failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** The remote coordinates a backup row records. */
export interface RemoteBackupRef {
  remoteKey: string | null;
  destinationId?: number | null;
}

/** Fetch a remote-only backup to a local path (returns the path to use). */
export async function fetchRemoteBackup(
  db: DB,
  backup: RemoteBackupRef,
  localPath: string,
): Promise<string> {
  if (!backup.remoteKey) throw new Error('No remote key recorded for this backup');
  const dest = await resolveDestination(db, backup.destinationId);
  if (!dest) throw new Error('No backup destination configured');
  const { prefix: _p, ...cfg } = dest;
  // Stream straight to disk — never buffer the whole dump in memory.
  await s3GetToFile(cfg, backup.remoteKey, localPath);
  return localPath;
}

/** Delete the remote object for a backup row (missing objects are fine). */
export async function deleteRemoteBackup(db: DB, backup: RemoteBackupRef): Promise<void> {
  if (!backup.remoteKey) return;
  const dest = await resolveDestination(db, backup.destinationId);
  if (!dest) return;
  const { prefix: _p, ...cfg } = dest;
  await s3Delete(cfg, backup.remoteKey).catch(() => undefined);
}
