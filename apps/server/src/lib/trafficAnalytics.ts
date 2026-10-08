import type { DB } from '@ninedeploy/db';

/**
 * Traffic analytics: access-log parser, aggregator and rollup writer (0.15).
 * Owner: task T3 (DESIGN §2.3).
 *
 * T1 lands only the retention entry point the housekeeping sweep calls
 * (step `traffic-rollups`, mount point M5), as a stub, so the step is wired
 * and covered by `test/retentionCoverage.test.ts` before the table has rows.
 */

/** Minute rows (granularity 60) are kept this long. */
export const TRAFFIC_MINUTE_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * Retention for `traffic_rollups` (DESIGN §2.3, §5), run hourly by
 * housekeeping: minute rows older than 48h, and hour rows older than
 * `traffic_retention_days` (default 30, 1–400), deleted in batches of 5000.
 * Returns the number of rows deleted.
 *
 * T1 stub: deletes nothing. T3 implements it.
 */
export async function pruneTrafficRollups(_db: DB, _now: number = Date.now()): Promise<number> {
  return 0;
}
