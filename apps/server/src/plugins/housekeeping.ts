import { tmpdir } from 'node:os';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import {
  auditLog,
  backupDrills,
  backups,
  cacheRegistryBlobs,
  deployments,
  domainTransfers,
  jobRuns,
  notificationLog,
  sessions,
  workspaceInvitations,
} from '@ninedeploy/db';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { pruneDrillLeftovers } from '../lib/backupDrill.js';
import { run } from '../lib/exec.js';
import { deleteLog, pruneOldLogs } from '../engine/logs.js';
import { pruneResetTokens } from '../lib/passwordReset.js';
import { executeAutoPrune, getAutoPruneStatus } from '../engine/autoPrune.js';
import { audit } from '../lib/audit.js';

const swallow = () => {};
const INTERVAL_MS = 60 * 60 * 1000; // hourly
/** Export artifacts (secret-bearing archives + scratch files) older than this
 * are crash leftovers — a live export cleans up within seconds. */
const EXPORT_LEFTOVER_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
/** Deploy-log files older than this are deleted. */
const LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Audit rows older than this are deleted. */
const AUDIT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
/** Notification-log rows older than this are deleted. */
const NOTIF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/**
 * Finished deployment rows older than this are deleted.
 *
 * Deliberately the SAME window as `LOG_MAX_AGE_MS`. Log files were swept at 30
 * days and the rows they belonged to were never swept at all, so the older half
 * of every service's Deploys tab listed builds whose logs had already been
 * deleted — a history entry you can click and learn nothing from. Ageing the
 * row out with its log keeps the two in step.
 */
const DEPLOY_MAX_AGE_MS = LOG_MAX_AGE_MS;
/**
 * Scheduled-job run rows older than this are deleted.
 *
 * `job_runs` had no retention at all, and each row stores up to 60 KB of the
 * command's captured output (`lib/jobRunner.ts`) inside the SQLite file that
 * gets backed up whole. A per-minute cron job writes ~525 000 rows a year, and
 * the panel only ever renders the newest 20 per job — everything older was
 * unreadable weight. Same window as the other logs.
 */
const JOB_RUN_MAX_AGE_MS = LOG_MAX_AGE_MS;
/**
 * Dead session rows are deleted this long after they stopped being usable.
 *
 * `sessions` had no retention at all: `issueSessionTokens` inserts one row per
 * login and nothing ever deleted one. `GET /v1/auth/sessions` filters expired
 * and revoked rows out of its RESPONSE, so the growth was invisible in the
 * panel while every login added a row — with a per-user IP and User-Agent
 * string — to the SQLite file that gets backed up whole.
 *
 * Deleting a dead row cannot resurrect a session: `findLiveSession` treats a
 * missing row exactly like a revoked one, and `refreshSessionTokens` requires
 * the row to still be live. The grace period only keeps the rows readable for
 * a while after the fact for incident review.
 */
const DEAD_SESSION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * r302: finished backup-drill rows older than this are deleted — except the
 * newest finished drill of each database, which is the "last verified" answer
 * the drill history exists to give. `backup_drills` had no retention; its rows
 * only went when their backup did (FK cascade), and a database whose backups
 * are kept forever kept every drill with them. `pending`/`running` rows are
 * never swept: a `running` row is the only trace of a drill that died mid-run.
 */
const DRILL_MAX_AGE_MS = AUDIT_MAX_AGE_MS;
/**
 * r302: workspace invitations and domain transfers are deleted this long after
 * they stopped being usable (revoked / accepted / expired). Neither table had
 * retention; since r301 a revoke → re-invite adds a row instead of failing, so
 * invitation history now grows with use. A live (pending, unexpired) row is
 * never touched — every condition below is on a terminal timestamp.
 */
const RETIRED_INVITE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * r302: registry build-cache rows not hit or stored for this long are deleted.
 * Safe by the driver's contract (`kernel/drivers/registryBuildCache.ts`): a row
 * is bookkeeping (digest, hit counter), not the cache — a key with no row is
 * looked up against the registry itself, which still holds the layers.
 */
const COLD_CACHE_ROW_MAX_AGE_MS = AUDIT_MAX_AGE_MS;
/**
 * r302: drill scratch files (a PLAINTEXT decryption of a backup, or a fetched
 * copy) older than this are leftovers of a drill whose process died before its
 * cleanup ran. Short, but far longer than any drill validates a dump.
 */
const DRILL_LEFTOVER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * Never swept, whatever their age:
 *   • the in-flight statuses — the worker and the pipeline still write to them;
 *   • `running` — that row records what is serving traffic right now, carries
 *     the image digest a rollback re-deploys, and is the baseline the next
 *     deploy's config diff is taken against.
 */
const UNSWEEPABLE_STATUSES = ['queued', 'building', 'deploying', 'running'] as const;
/**
 * r543: a backup or drill still `running` this long after it started is
 * treated as interrupted by the hourly sweep. Far beyond any real dump (the
 * boot sweep below catches crashes immediately); this backstop covers a
 * process that hung. A row marked early heals itself: every backup and drill
 * path finishes with an UPDATE by id that writes its real outcome.
 */
const INTERRUPTED_OPERATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INTERRUPTED_DRILL_ERROR =
  'Drill interrupted: the panel stopped (restart, crash or update) before it finished — no verdict on the backup. Run it again.';

/**
 * r543: mark backups and backup drills that were left `running` by a process
 * that is gone. A manual database backup, a volume backup and a drill each
 * insert a `running` row and flip it when they finish; a crash or restart in
 * between left that row `running` forever — the backups list showed a backup
 * "in progress" for good, and nothing ever said it had failed.
 *
 * Backups become `failed` (the table has no message column; the audit entry
 * carries the explanation and fans out to the notification channels). Drills
 * become `unverifiable` with an error: the check never ran to a verdict, so
 * `failed` would wrongly blame the backup (r356).
 */
export async function failInterruptedOperations(
  db: import('@ninedeploy/db').DB,
  startedBefore: Date,
): Promise<{ backups: number[]; drills: number[] }> {
  const stuckBackups = await db
    .update(backups)
    .set({ status: 'failed' })
    .where(and(eq(backups.status, 'running'), lt(backups.createdAt, startedBefore)))
    .returning({ id: backups.id });
  const stuckDrills = await db
    .update(backupDrills)
    .set({ status: 'unverifiable', error: INTERRUPTED_DRILL_ERROR, completedAt: Math.floor(Date.now() / 1000) })
    .where(and(eq(backupDrills.status, 'running'), lt(backupDrills.startedAt, startedBefore)))
    .returning({ id: backupDrills.id });
  const result = { backups: stuckBackups.map((r) => r.id), drills: stuckDrills.map((r) => r.id) };
  if (result.backups.length > 0 || result.drills.length > 0) {
    void audit(
      db,
      null,
      'backup.interrupted',
      `${result.backups.length} backup(s) and ${result.drills.length} drill(s) left running by a stopped process were marked failed`,
      { backupIds: result.backups, drillIds: result.drills },
    );
  }
  return result;
}

/**
 * Delete finished deployment rows past the retention window, and the log file
 * of each one. Returns the number of rows removed.
 *
 * The ids are read first so the matching log files can be removed too:
 * `pruneOldLogs` only judges files by mtime, and a deployment that produced no
 * output in its final 30 days would otherwise leave its row deleted and its
 * file behind (or the reverse).
 */
async function pruneOldDeployments(db: import('@ninedeploy/db').DB, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const doomed = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(lt(deployments.createdAt, cutoff), notInArray(deployments.status, [...UNSWEEPABLE_STATUSES])));
  if (doomed.length === 0) return 0;
  await db
    .delete(deployments)
    .where(and(lt(deployments.createdAt, cutoff), notInArray(deployments.status, [...UNSWEEPABLE_STATUSES])));
  for (const row of doomed) deleteLog(row.id);
  return doomed.length;
}

/**
 * r302: ids of the deployments whose rows are never swept — their log files
 * must not be swept either. `pruneOldLogs` judges by mtime alone, and a
 * `running` deployment stops writing its log once it is up, so after 30 days
 * the build log of the deploy currently serving traffic was deleted.
 */
export async function unsweepableDeploymentIds(db: import('@ninedeploy/db').DB): Promise<Set<number>> {
  const rows = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.status, [...UNSWEEPABLE_STATUSES]));
  return new Set(rows.map((r) => r.id));
}

/**
 * r302: retention for the tables that had none — finished backup drills,
 * retired workspace invitations and domain transfers, and cold registry
 * build-cache rows. See the window constants above for what each keeps.
 */
export async function pruneRetiredRecords(db: import('@ninedeploy/db').DB, now: number = Date.now()): Promise<void> {
  const drillCutoff = new Date(now - DRILL_MAX_AGE_MS);
  await db.delete(backupDrills).where(
    and(
      // r356: an old `unverifiable` row goes too, but never counts as the
      // database's kept "last verified" answer — it verified nothing.
      inArray(backupDrills.status, ['passed', 'failed', 'unverifiable']),
      lt(backupDrills.startedAt, drillCutoff),
      sql`${backupDrills.id} NOT IN (SELECT MAX(${backupDrills.id}) FROM ${backupDrills} WHERE ${backupDrills.status} IN ('passed', 'failed') GROUP BY ${backupDrills.databaseId})`,
    ),
  );

  const inviteCutoff = new Date(now - RETIRED_INVITE_GRACE_MS);
  await db
    .delete(workspaceInvitations)
    .where(
      or(
        lt(workspaceInvitations.revokedAt, inviteCutoff),
        lt(workspaceInvitations.acceptedAt, inviteCutoff),
        lt(workspaceInvitations.expiresAt, inviteCutoff),
      ),
    );

  // `expires_at` is unix SECONDS here. Every transfer — pending, accepted or
  // cancelled — is past any state change once it is past its expiry (accept
  // and cancel both require a pending, unexpired row), so expiry + grace is
  // the terminal timestamp for all of them.
  const transferCutoffSec = Math.floor((now - RETIRED_INVITE_GRACE_MS) / 1000);
  await db.delete(domainTransfers).where(lt(domainTransfers.expiresAt, transferCutoffSec));

  await db.delete(cacheRegistryBlobs).where(lt(cacheRegistryBlobs.lastHitAt, new Date(now - COLD_CACHE_ROW_MAX_AGE_MS)));
}

/**
 * Run the metric-history plugin's built-in retention sweep.
 *
 * `plugin:metric-history:retention_days` documents itself as trimmed by "a
 * /v1/housekeeping pass", but nothing outside the manual
 * `POST /v1/metric-history/flush` route ever called it — an operator who
 * lowered the window saw no effect until they clicked the button. Best-effort:
 * a missing kernel or a backend error must not abort the rest of the sweep.
 */
async function pruneMetricHistory(fastify: import('fastify').FastifyInstance): Promise<void> {
  const kernel = fastify.kernel;
  if (!kernel) return;
  const plugin = kernel.getPlugin?.('metric-history') as
    | { runRetention?: (ctx: unknown) => Promise<number> }
    | undefined;
  if (typeof plugin?.runRetention !== 'function') return;
  try {
    await plugin.runRetention(kernel);
  } catch (err) {
    fastify.log.warn({ err }, 'metric-history retention sweep failed');
  }
}

/**
 * Delete session rows that can no longer authenticate anything: expired ones,
 * and revoked ones, both past the grace period. Returns the rows removed.
 */
async function pruneDeadSessions(db: import('@ninedeploy/db').DB, graceMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const res = (await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, cutoff), lt(sessions.revokedAt, cutoff)))) as
    | { rowsAffected?: number }
    | undefined;
  return res?.rowsAffected ?? 0;
}

/**
 * Remove dangling (untagged) Docker images — the orphaned layers left behind by
 * failed/interrupted builds. Tagged images (incl. `ninedeploy/<slug>:<sha>` used
 * for rollback) and images referenced by a running container are never dangling,
 * so this is safe and never evicts something in use.
 */
function pruneDanglingImages(): void {
  void run('docker', ['image', 'prune', '-f'], {}, swallow).catch(() => undefined);
}

/**
 * Sweep crash-orphaned export artifacts from the data dir: the secret-bearing
 * `ninedeploy-backup-*.tar.gz` (DB + master key + .env) and its scratch files
 * (`_db-*.db`, `_env-*`, `_meta-*.json`). A live export cleans up in seconds,
 * so anything older than an hour belongs to a crashed run. Without this, a
 * crash-looping instance slowly fills its disk with plaintext secrets.
 */
function pruneExportLeftovers(maxAgeMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(config.paths.dataDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (
      !entry.startsWith('ninedeploy-backup-')
      && !entry.startsWith('_db-')
      && !entry.startsWith('_env-')
      && !entry.startsWith('_meta-')
    ) continue;
    const full = path.join(config.paths.dataDir, entry);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch { /* raced or unreadable — next sweep retries */ }
  }
}

/**
 * Periodic housekeeping: prunes deploy-log files, finished deployment rows,
 * scheduled-job run history, dead session rows, time-series/audit tables,
 * finished backup drills and their leftover scratch files, retired
 * invitations and domain transfers, cold build-cache rows, the
 * archived metric-history rows, and dangling Docker images so a long-running
 * instance doesn't slowly fill its disk. Live metric retention is handled by
 * the collector plugin (a 24h ring, matching the 1440-minute cap the
 * `/services/:id/metrics` query accepts). It also marks backups and drills a
 * stopped process left `running` as failed (r543) — once at boot, then hourly.
 */
export default fp(
  async (fastify) => {
    let running = true;
    let timer: NodeJS.Timeout | undefined;

    const tick = async () => {
      // r544: every step is isolated. The sweep used to be one try/catch, so
      // the first failing delete (a locked table, one bad row) skipped every
      // step after it — including the disk auto-prune check — every hour
      // until the cause went away.
      const step = async (name: string, fn: () => unknown): Promise<void> => {
        try {
          await fn();
        } catch (err) {
          fastify.log.error({ err, step: name }, `housekeeping step failed: ${name}`);
        }
      };
      try {
        const now = Date.now();
        await step('deploy-logs', async () => pruneOldLogs(LOG_MAX_AGE_MS, await unsweepableDeploymentIds(fastify.db)));
        await step('audit-log', () => fastify.db.delete(auditLog).where(lt(auditLog.ts, new Date(now - AUDIT_MAX_AGE_MS))));
        await step('notification-log', () =>
          fastify.db.delete(notificationLog).where(lt(notificationLog.ts, new Date(now - NOTIF_MAX_AGE_MS))),
        );
        await step('deployments', () => pruneOldDeployments(fastify.db, DEPLOY_MAX_AGE_MS));
        await step('job-runs', () => fastify.db.delete(jobRuns).where(lt(jobRuns.createdAt, new Date(now - JOB_RUN_MAX_AGE_MS))));
        await step('reset-tokens', () => pruneResetTokens(fastify.db));
        await step('sessions', () => pruneDeadSessions(fastify.db, DEAD_SESSION_GRACE_MS));
        await step('retired-records', () => pruneRetiredRecords(fastify.db, now));
        await step('interrupted-backups', () =>
          failInterruptedOperations(fastify.db, new Date(now - INTERRUPTED_OPERATION_MAX_AGE_MS)),
        );
        await step('drill-leftovers', () => pruneDrillLeftovers([config.paths.backupsDir, tmpdir()], DRILL_LEFTOVER_MAX_AGE_MS));
        await step('export-leftovers', () => pruneExportLeftovers(EXPORT_LEFTOVER_MAX_AGE_MS));
        await step('metric-history', () => pruneMetricHistory(fastify));
        await step('dangling-images', () => pruneDanglingImages());

        await step('disk-auto-prune', async () => {
          const pruneStatus = await getAutoPruneStatus(fastify.db);
          if (pruneStatus.enabled && pruneStatus.diskUsedPercent >= pruneStatus.thresholdPercent) {
            fastify.log.warn(
              { diskUsedPercent: pruneStatus.diskUsedPercent, thresholdPercent: pruneStatus.thresholdPercent },
              'Disk threshold reached — triggering auto-prune',
            );
            await executeAutoPrune(fastify.db);
          }
        });
      } finally {
        if (running) {
          timer = setTimeout(() => void tick(), INTERVAL_MS);
          timer.unref();
        }
      }
    };

    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
    });

    // r543: at boot nothing this process started can be running yet, so every
    // `running` backup or drill row is the leftover of the process before it.
    // Backups and drills only ever run inside the panel process; a second
    // panel process sharing this database is not a supported topology. Must
    // never block startup.
    try {
      const healed = await failInterruptedOperations(fastify.db, new Date());
      if (healed.backups.length > 0 || healed.drills.length > 0) {
        fastify.log.warn(healed, 'interrupted backups/drills from the previous run marked failed');
      }
    } catch (err) {
      fastify.log.warn({ err }, 'interrupted backup sweep skipped at boot');
    }

    // Run once shortly after boot, then hourly.
    timer = setTimeout(() => void tick(), 60_000);
    timer.unref();
    fastify.log.info('housekeeping scheduler started');
  },
  { name: 'ninedeploy-housekeeping' },
);
