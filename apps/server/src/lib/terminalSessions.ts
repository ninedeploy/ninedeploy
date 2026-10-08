import type { DB } from '@ninedeploy/db';

/**
 * Terminal session engine (0.15). Owner: task T2a (DESIGN §1.2, §1.6).
 *
 * T1 lands only the retention entry point the housekeeping sweep calls
 * (step `terminal-sessions`, mount point M5), as a stub, so the step is wired
 * and covered by `test/retentionCoverage.test.ts` before the table has rows.
 */

/** Default for the `terminal_retention_days` setting. */
export const TERMINAL_RETENTION_DAYS_DEFAULT = 180;

/**
 * Retention for `terminal_sessions` (DESIGN §5), run hourly by housekeeping:
 * - `ended` / `failed` / `expired` rows older than `terminal_retention_days`
 *   (default 180) are deleted;
 * - `pending` rows whose ticket expired more than one day ago are deleted.
 * Live (`active`) rows are never touched. Returns the number of rows deleted.
 *
 * T1 stub: deletes nothing. T2a implements it.
 */
export async function pruneTerminalSessions(_db: DB, _now: number = Date.now()): Promise<number> {
  return 0;
}
