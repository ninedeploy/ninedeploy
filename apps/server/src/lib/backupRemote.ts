import { unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { backups, type BackupDestination, type DB } from '@ninedeploy/db';
import { readBackupHeader } from './backupCrypto.js';
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
  /** 0.12 backup policy: upload to this destination instead of the active
   *  one (a missing row falls back to the active destination, like reads). */
  opts: { destinationId?: number | null } = {},
): Promise<void> {
  try {
    // F288: resolving the destination decrypts its secret, which throws for a
    // key version this process does not hold — that is an upload failure too.
    const dest = await resolveDestination(db, opts.destinationId ?? null);
    if (!dest) return;
    const { prefix, ...cfg } = dest;
    const key = `${prefix.replace(/\/$/, '')}/${basename(localPath)}`.replace(/^\/+/, '');
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
  /** r645: provenance for the plaintext decision in {@link assertRemoteObjectSealed}.
   *  Callers pass the backup row; a ref without them is treated as "must be sealed". */
  scope?: string | null;
  createdAt?: Date | null;
}

/** Fetch a remote-only backup to a local path (returns the path to use).
 *  r645: the object must carry NineDeploy's backup encryption unless the row
 *  is a legacy plaintext volume snapshot — see {@link assertRemoteObjectSealed}.
 *  A refused object — or a partial one from a failed download (F289) — is
 *  removed from disk before the error propagates. */
export async function fetchRemoteBackup(
  db: DB,
  backup: RemoteBackupRef,
  localPath: string,
): Promise<string> {
  if (!backup.remoteKey) throw new Error('No remote key recorded for this backup');
  const dest = await resolveDestination(db, backup.destinationId);
  if (!dest) throw new Error('No backup destination configured');
  const { prefix: _p, ...cfg } = dest;
  try {
    // Stream straight to disk — never buffer the whole dump in memory.
    await s3GetToFile(cfg, backup.remoteKey, localPath);
    await assertRemoteObjectSealed(db, backup, localPath);
  } catch (err) {
    try { unlinkSync(localPath); } catch { /* absent */ }
    throw err;
  }
  return localPath;
}

/** The single-line `v<n>:` at-rest envelope database dumps used before the
 *  streaming `NDBK1:` format (0.3.0). Also AES-GCM under the master key. */
const LEGACY_ENVELOPE_RE = /^v\d+:/;

async function fileHead(file: string, bytes = 32): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(head, 0, bytes, 0);
    return head.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * r645: refuse a fetched remote object that is not sealed with the backup
 * encryption, unless the row is one that may legitimately be plaintext.
 *
 * The restore path accepts plaintext as "legacy" and feeds it straight to
 * `pg_restore` / `mysql` / `tar`. For a LOCAL file that is fine — writing the
 * backups directory already means owning the host. A REMOTE object is
 * different: anyone with write access to the bucket could swap in a crafted
 * plaintext dump and have the panel run its SQL on the next restore. Both
 * envelopes (`NDBK1:` streaming and the older `v<n>:`) are AES-GCM under the
 * master key, so a forged sealed object fails authentication instead.
 *
 * Which rows may be plaintext — recognised from the row itself, since no
 * schema column records "written encrypted":
 *  • database dumps (scope `db` / `scheduled`): never. Dumps have been sealed
 *    at rest since before the first tagged release, and off-site copies were
 *    added after that and upload the on-disk file as-is;
 *  • volume snapshots: sealed since 0.10.3, the same release whose migration
 *    0062 started stamping `destinationId` on every upload. A row WITH a
 *    destination was therefore written sealed. A row without one is either a
 *    pre-0.10.3 upload or a newer one whose destination was deleted since; it
 *    may be plaintext only if it predates the earliest destination-stamped
 *    upload on this server — i.e. it was taken before this server ran 0.10.3,
 *    however late it upgraded.
 */
export async function assertRemoteObjectSealed(db: DB, backup: RemoteBackupRef, file: string): Promise<void> {
  if (await readBackupHeader(file)) return;
  if (LEGACY_ENVELOPE_RE.test(await fileHead(file))) return;
  if (await mayBeLegacyPlaintext(db, backup)) return;
  throw new Error(
    `Refusing to restore the remote object '${backup.remoteKey}': it is not encrypted, but NineDeploy uploads every database dump — and every volume snapshot since 0.10.3 — sealed with the instance master key. ` +
      'A plaintext object under this key was not written by this server (someone with write access to the bucket may have replaced it). ' +
      'Download and inspect it before restoring anything from it by hand.',
  );
}

async function mayBeLegacyPlaintext(db: DB, backup: RemoteBackupRef): Promise<boolean> {
  if (backup.scope !== 'volumes') return false;
  if (backup.destinationId != null) return false;
  if (!(backup.createdAt instanceof Date)) return false;
  const firstStamped = await db.query.backups.findFirst({
    where: isNotNull(backups.destinationId),
    orderBy: asc(backups.createdAt),
    columns: { createdAt: true },
  });
  return !firstStamped || backup.createdAt.getTime() < firstStamped.createdAt.getTime();
}

/** Delete the remote object for a backup row (missing objects are fine). */
export async function deleteRemoteBackup(db: DB, backup: RemoteBackupRef): Promise<void> {
  if (!backup.remoteKey) return;
  const dest = await resolveDestination(db, backup.destinationId);
  if (!dest) return;
  const { prefix: _p, ...cfg } = dest;
  await s3Delete(cfg, backup.remoteKey).catch(() => undefined);
}

/**
 * r542: delete a backup's remote object for RETENTION, reporting the outcome
 * so the caller drops the row only once the object is really gone.
 * `deleteRemoteBackup` above is best-effort because its callers delete the row
 * regardless; a retention sweep that did the same would leak an object for
 * every transient S3 failure and lose the only pointer to it.
 *
 *   'deleted'             the destination the row RECORDS confirmed the delete
 *                         (S3 answers 404 for an object already gone — fine)
 *   'unknown-destination' the row records no destination (pre-0062 rows), or
 *                         that destination was since removed. There is no
 *                         fallback to the active destination here: it may be a
 *                         different bucket, and a delete there "succeeds"
 *                         without touching the real object.
 *
 * Throws when the destination could not be read or refused the delete
 * (network, auth, 5xx) — the caller keeps the row and retries next sweep.
 */
export async function deleteRemoteBackupForRetention(
  db: DB,
  backup: RemoteBackupRef,
): Promise<'deleted' | 'unknown-destination'> {
  if (!backup.remoteKey) return 'deleted';
  if (backup.destinationId == null) return 'unknown-destination';
  const rows = await db.query.backupDestinations.findMany();
  const row = rows.find((d) => d.id === backup.destinationId);
  if (!row) return 'unknown-destination';
  const { prefix: _p, ...cfg } = toDestination(row);
  await s3Delete(cfg, backup.remoteKey);
  return 'deleted';
}
