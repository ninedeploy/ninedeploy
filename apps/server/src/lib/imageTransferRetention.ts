import { sql } from 'drizzle-orm';
import type { DB } from '@ninedeploy/db';
import { getSettingJson } from './settings.js';

/**
 * Retention for `image_transfers` (multi-node, design §8): an event table, one
 * row per image shipped to a host, swept hourly by the housekeeping step
 * `image-transfers` (test/retentionCoverage.test.ts pins the pair).
 */

/** Settings key of the retention in days (absent = 30). Not secret. */
export const IMAGE_TRANSFER_RETENTION_DAYS_KEY = 'image_transfer_retention_days';
export const IMAGE_TRANSFER_RETENTION_DAYS_DEFAULT = 30;
export const IMAGE_TRANSFER_RETENTION_DAYS_MIN = 1;
export const IMAGE_TRANSFER_RETENTION_DAYS_MAX = 400;
/** Deletes run in batches of this many rows, so one sweep never holds the write lock for long. */
export const IMAGE_TRANSFER_PRUNE_BATCH = 5000;

/** The stored retention when it is a valid integer in range, else 30. */
export async function getImageTransferRetentionDays(db: DB): Promise<number> {
  const raw = await getSettingJson<unknown>(db, IMAGE_TRANSFER_RETENTION_DAYS_KEY, null);
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= IMAGE_TRANSFER_RETENTION_DAYS_MIN && n <= IMAGE_TRANSFER_RETENTION_DAYS_MAX
    ? n
    : IMAGE_TRANSFER_RETENTION_DAYS_DEFAULT;
}

/**
 * Delete transfer rows that started more than the retention ago, in batches.
 * Returns the number of rows deleted.
 */
export async function pruneImageTransfers(
  db: DB,
  now: number = Date.now(),
  batch: number = IMAGE_TRANSFER_PRUNE_BATCH,
): Promise<number> {
  const days = await getImageTransferRetentionDays(db);
  const cutoff = Math.floor(now / 1000) - days * 86_400;
  let deleted = 0;
  for (;;) {
    const res = (await db.run(
      sql`DELETE FROM image_transfers WHERE id IN (SELECT id FROM image_transfers WHERE started_at < ${cutoff} LIMIT ${batch})`,
    )) as unknown as { rowsAffected?: number };
    const n = Number(res?.rowsAffected ?? 0);
    deleted += n;
    if (n < batch) break;
  }
  return deleted;
}
