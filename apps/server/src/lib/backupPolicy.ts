import { EventEmitter } from 'node:events';
import { Cron } from 'croner';
import type { DatabaseBackupPolicy, DB } from '@ninedeploy/db';
import { DEFAULT_BACKUP_RETAIN_COUNT, type BackupPolicy } from '@ninedeploy/schemas';
import { badRequest } from './errors.js';

/**
 * Per-database backup policy (0.12) — the pieces shared by the
 * `/databases/:id/backup-policy` routes and the backup scheduler.
 *
 * A database without a policy row keeps the built-in schedule exactly: one
 * daily tick, the newest {@link DEFAULT_BACKUP_RETAIN_COUNT} completed
 * scheduled dumps kept, remote copies on the active destination pruned with
 * their rows (r542).
 */

/** Failed scheduled attempts kept per database — diagnostics, never recovery
 *  points, so they have their own bound whatever the policy says. */
export const FAILED_ATTEMPTS_KEPT = DEFAULT_BACKUP_RETAIN_COUNT;

/**
 * Same rule as scheduled jobs (`modules/jobs.ts` assertCron, F240/F102):
 * croner in strict '5-part' mode, so a 6-field pattern with a seconds field
 * is refused instead of firing every second.
 */
export function assertBackupCron(expr: string): void {
  try {
    new Cron(expr, { paused: true, unref: true, mode: '5-part' });
  } catch {
    throw badRequest('Invalid cron expression (expected 5 fields: minute hour day month weekday)');
  }
}

/** Next run of a 5-field cron after `from`, or null (invalid / never fires). */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  try {
    return new Cron(expr, { paused: true, unref: true, mode: '5-part' }).nextRun(from);
  } catch {
    return null;
  }
}

/** Gap between the next two runs — the cadence the missed-backup watchdog
 *  scales its threshold by. Null when the cron does not fire twice. */
export function cronPeriodMs(expr: string, from: Date = new Date()): number | null {
  try {
    const [a, b] = new Cron(expr, { paused: true, unref: true, mode: '5-part' }).nextRuns(2, from);
    return a && b ? b.getTime() - a.getTime() : null;
  } catch {
    return null;
  }
}

/**
 * In-process signal: a policy row changed (saved). The scheduler re-arms that
 * database's cron at once instead of waiting for a restart.
 */
export const backupPolicyEvents = new EventEmitter();
backupPolicyEvents.setMaxListeners(0);
export function notifyBackupPolicyChanged(databaseId: number): void {
  backupPolicyEvents.emit('changed', databaseId);
}

/**
 * Every policy row, keyed by database id.
 *
 * Returns an EMPTY map only when the table is not there to read (a mocked
 * DB without it, or a database the 0067 migration has not reached) — then
 * every database is on the built-in schedule, which is exactly the pre-0.12
 * behaviour. Any OTHER read error is rethrown: treating a policy database as
 * built-in for one tick would prune it to 7 dumps against its policy.
 */
export async function loadBackupPolicies(db: DB): Promise<Map<number, DatabaseBackupPolicy>> {
  const table = (db as unknown as { query?: Record<string, { findMany?: () => Promise<DatabaseBackupPolicy[]> } | undefined> })
    .query?.['databaseBackupPolicies'];
  if (!table?.findMany) return new Map();
  let rows: DatabaseBackupPolicy[];
  try {
    rows = await table.findMany();
  } catch (err) {
    if (isMissingTable(err)) return new Map();
    throw err;
  }
  return new Map((rows ?? []).map((r) => [r.databaseId, r]));
}

function isMissingTable(err: unknown): boolean {
  const texts = [err, err instanceof Error ? err.cause : undefined].map((e) =>
    e instanceof Error ? e.message : String(e ?? ''),
  );
  return texts.some((t) => /no such table:\s*`?database_backup_policies/i.test(t));
}

/** API view of a database's policy (or of the built-in default). */
export function serializeBackupPolicy(databaseId: number, row: DatabaseBackupPolicy | null | undefined, now = new Date()): BackupPolicy {
  if (!row) {
    return {
      databaseId,
      configured: false,
      enabled: true,
      cron: null,
      retainCount: DEFAULT_BACKUP_RETAIN_COUNT,
      retainRemoteCount: null,
      destinationId: null,
      localOnly: false,
      nextRunAt: null,
      updatedAt: null,
    };
  }
  const next = row.enabled ? nextCronRun(row.cron, now) : null;
  return {
    databaseId,
    configured: true,
    enabled: row.enabled,
    cron: row.cron,
    retainCount: row.retainCount,
    retainRemoteCount: row.retainRemoteCount ?? null,
    destinationId: row.destinationId ?? null,
    localOnly: row.localOnly,
    nextRunAt: next ? next.toISOString() : null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
  };
}

// ── retention ──────────────────────────────────────────────────────────────

/** What retention does to one scheduled backup row. */
export type RetentionAction =
  /** Unlink the local dump, delete the remote copy, then the row (r542 order). */
  | 'drop'
  /** Unlink the local dump only; the row stays as a remote-only recovery point. */
  | 'trim-local'
  /** Delete the remote copy only; the row and its local dump stay. */
  | 'trim-remote';

export interface RetentionRow {
  id: number;
  scope: string;
  status: string;
  remoteKey?: string | null;
}

export interface RetentionLimits {
  /** Completed dumps whose local file is kept (≥ 1). */
  retainCount: number;
  /** Remote copies kept, counted over rows that have one; null = the
   *  built-in rule (a row's remote copy goes with the row). */
  retainRemoteCount: number | null;
}

/**
 * Decide retention for one database's backup rows (any order in, newest
 * first assumed — callers pass `ORDER BY created_at DESC`). Pure.
 *
 * Built-in rule (no policy, or `retainRemoteCount: null`): every completed
 * scheduled row past `retainCount` is dropped, remote copy included — the
 * pre-0.12 behaviour with `retainCount` = 7.
 *
 * With `retainRemoteCount` the two sides are counted separately: the newest
 * `retainCount` completed rows keep their local dump, the newest
 * `retainRemoteCount` rows that HAVE a remote copy keep it, and a row is
 * dropped only once it keeps neither.
 *
 * F97/F288 rule: failed attempts are bounded on their own and can never
 * evict a completed dump; the newest completed dump (and the newest remote
 * copy) is never touched — both counts are clamped to at least 1. Manual
 * backups (scope 'db') and running rows are never considered.
 */
export function planRetention(rows: RetentionRow[], limits: RetentionLimits): Map<number, RetentionAction> {
  const keepLocal = Math.max(1, Math.floor(limits.retainCount) || 1);
  const keepRemote = limits.retainRemoteCount == null ? null : Math.max(1, Math.floor(limits.retainRemoteCount) || 1);
  const scheduled = rows.filter((r) => r.scope === 'scheduled');
  const completed = scheduled.filter((r) => r.status === 'completed');
  const failed = scheduled.filter((r) => r.status === 'failed');
  const out = new Map<number, RetentionAction>();

  if (keepRemote == null) {
    for (const r of completed.slice(keepLocal)) out.set(r.id, 'drop');
  } else {
    let remoteRank = 0;
    completed.forEach((r, i) => {
      const localKept = i < keepLocal;
      const hasRemote = Boolean(r.remoteKey);
      const remoteKept = hasRemote && remoteRank++ < keepRemote;
      if (localKept) {
        if (hasRemote && !remoteKept) out.set(r.id, 'trim-remote');
      } else if (remoteKept) {
        out.set(r.id, 'trim-local');
      } else {
        out.set(r.id, 'drop');
      }
    });
  }
  for (const r of failed.slice(FAILED_ATTEMPTS_KEPT)) out.set(r.id, 'drop');
  return out;
}
