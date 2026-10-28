import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { backupDestinations, type DB } from '@ninedeploy/db';
import { backupReplica, type BackupReplica, type BackupReplicasView } from '@ninedeploy/schemas';
import { decrypt } from './crypto.js';
import { s3Delete, s3PutFile, type S3Config } from './s3.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G3.3 backup replica destinations. A database's scheduled dumps are copied,
 * after the primary upload, to up to three more destinations, each keeping
 * its own number of copies (newest first). The copy is the same encrypted
 * envelope the primary holds, at the same `<prefix>/<file>` key.
 *
 * No migration: one settings row per database, `backup_replicas:<id>`,
 * holds the list and a log of the copies made (bounded by the retention
 * counts), which is what retention prunes from.
 */

const key = (databaseId: number) => `backup_replicas:${databaseId}`;

interface Copy {
  destinationId: number;
  key: string;
  at: string;
}

interface Stored {
  replicas: BackupReplica[];
  copies: Copy[];
  errors?: Record<string, string>;
}

async function read(db: DB, databaseId: number): Promise<Stored> {
  const raw = await getSettingJson<Partial<Stored>>(db, key(databaseId), null);
  const replicas = Array.isArray(raw?.replicas) ? raw.replicas.filter((r) => backupReplica.safeParse(r).success) : [];
  const copies = Array.isArray(raw?.copies)
    ? raw.copies.filter((c): c is Copy => !!c && Number.isInteger(c.destinationId) && typeof c.key === 'string' && typeof c.at === 'string')
    : [];
  return { replicas, copies, errors: raw?.errors && typeof raw.errors === 'object' ? raw.errors : {} };
}

export async function getBackupReplicas(db: DB, databaseId: number): Promise<BackupReplicasView> {
  const stored = await read(db, databaseId);
  return {
    databaseId,
    replicas: stored.replicas.map((r) => {
      const mine = stored.copies.filter((c) => c.destinationId === r.destinationId);
      return {
        ...r,
        copies: mine.length,
        lastCopyAt: mine.length ? mine.map((c) => c.at).sort().at(-1)! : null,
        lastError: stored.errors?.[String(r.destinationId)] ?? null,
      };
    }),
  };
}

/**
 * Replace the list. Copies at a destination taken off the list stay in its
 * bucket and leave the log (they are no longer pruned).
 */
export async function setBackupReplicas(db: DB, databaseId: number, replicas: BackupReplica[]): Promise<void> {
  const stored = await read(db, databaseId);
  const ids = new Set(replicas.map((r) => r.destinationId));
  await setSettingJson<Stored>(db, key(databaseId), {
    replicas,
    copies: stored.copies.filter((c) => ids.has(c.destinationId)),
    errors: Object.fromEntries(Object.entries(stored.errors ?? {}).filter(([id]) => ids.has(Number(id)))),
  });
}

type ResolvedDestination = S3Config & { prefix: string };

export interface ReplicaDeps {
  put?: (cfg: S3Config, key: string, file: string) => Promise<void>;
  remove?: (cfg: S3Config, key: string) => Promise<void>;
  now?: () => Date;
}

async function destination(db: DB, id: number): Promise<ResolvedDestination | null> {
  const row = await db.query.backupDestinations.findFirst({ where: eq(backupDestinations.id, id) });
  if (!row) return null;
  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    accessKeyId: row.accessKeyId,
    secretAccessKey: decrypt(row.secretKeyEncrypted),
  };
}

/**
 * Copy one completed dump to every replica destination of its database, then
 * prune each to its retention. Best-effort per destination: a failure is
 * logged and recorded on the view, and never fails the backup. Returns how
 * many copies were made.
 */
export async function replicateBackup(db: DB, databaseId: number, file: string, log: (line: string) => void, deps: ReplicaDeps = {}): Promise<number> {
  const stored = await read(db, databaseId);
  if (stored.replicas.length === 0) return 0;
  const put = deps.put ?? ((cfg, k, f) => s3PutFile(cfg, k, f));
  const remove = deps.remove ?? s3Delete;
  const errors: Record<string, string> = { ...(stored.errors ?? {}) };
  let copies = [...stored.copies];
  let made = 0;
  for (const replica of stored.replicas) {
    const id = String(replica.destinationId);
    try {
      const dest = await destination(db, replica.destinationId);
      if (!dest) throw new Error(`backup destination #${replica.destinationId} no longer exists`);
      const { prefix, ...cfg } = dest;
      const objectKey = `${prefix.replace(/\/$/, '')}/${basename(file)}`.replace(/^\/+/, '');
      await put(cfg, objectKey, file);
      copies.push({ destinationId: replica.destinationId, key: objectKey, at: (deps.now?.() ?? new Date()).toISOString() });
      made++;
      log(`☁ Replica copy to ${dest.bucket}/${objectKey}`);
      // Retention: the newest `retainCount` copies stay; an older one leaves the log only once it is deleted.
      const mine = copies.filter((c) => c.destinationId === replica.destinationId).sort((a, b) => b.at.localeCompare(a.at));
      for (const old of mine.slice(replica.retainCount)) {
        await remove(cfg, old.key);
        copies = copies.filter((c) => c !== old);
      }
      delete errors[id];
    } catch (err) {
      errors[id] = err instanceof Error ? err.message : String(err);
      log(`warning: replica copy to destination #${id} failed: ${errors[id]}`);
    }
  }
  // Re-read the list so a PUT that landed during the uploads is not undone.
  const latest = await read(db, databaseId);
  const listed = new Set(latest.replicas.map((r) => r.destinationId));
  await setSettingJson<Stored>(db, key(databaseId), {
    replicas: latest.replicas,
    copies: copies.filter((c) => listed.has(c.destinationId)),
    errors: Object.fromEntries(Object.entries(errors).filter(([d]) => listed.has(Number(d)))),
  });
  return made;
}
