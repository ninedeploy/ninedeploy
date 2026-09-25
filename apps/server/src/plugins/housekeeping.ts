import { tmpdir } from 'node:os';
import { and, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import {
  auditLog,
  backupDrills,
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

const swallow = () => {};
const INTERVAL_MS = 60 * 60 * 1000; // hourly
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
      inArray(backupDrills.status, ['passed', 'failed']),
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
 * Periodic housekeeping: prunes deploy-log files, finished deployment rows,
 * scheduled-job run history, dead session rows, time-series/audit tables,
 * finished backup drills and their leftover scratch files, retired
 * invitations and domain transfers, cold build-cache rows, the
 * archived metric-history rows, and dangling Docker images so a long-running
 * instance doesn't slowly fill its disk. Live metric retention is handled by
 * the collector plugin (a 24h ring, matching the 1440-minute cap the
 * `/services/:id/metrics` query accepts).
 */
export default fp(
  async (fastify) => {
    let running = true;
    let timer: NodeJS.Timeout | undefined;

    const tick = async () => {
      try {
        pruneOldLogs(LOG_MAX_AGE_MS, await unsweepableDeploymentIds(fastify.db));
        const now = Date.now();
        await fastify.db.delete(auditLog).where(lt(auditLog.ts, new Date(now - AUDIT_MAX_AGE_MS)));
        await fastify.db.delete(notificationLog).where(lt(notificationLog.ts, new Date(now - NOTIF_MAX_AGE_MS)));
        await pruneOldDeployments(fastify.db, DEPLOY_MAX_AGE_MS);
        await fastify.db.delete(jobRuns).where(lt(jobRuns.createdAt, new Date(now - JOB_RUN_MAX_AGE_MS)));
        await pruneResetTokens(fastify.db);
        await pruneDeadSessions(fastify.db, DEAD_SESSION_GRACE_MS);
        await pruneRetiredRecords(fastify.db, now);
        await pruneDrillLeftovers([config.paths.backupsDir, tmpdir()], DRILL_LEFTOVER_MAX_AGE_MS);
        await pruneMetricHistory(fastify);
        pruneDanglingImages();

        // Disk Auto-Prune check
        const pruneStatus = await getAutoPruneStatus(fastify.db);
        if (pruneStatus.enabled && pruneStatus.diskUsedPercent >= pruneStatus.thresholdPercent) {
          fastify.log.warn(
            { diskUsedPercent: pruneStatus.diskUsedPercent, thresholdPercent: pruneStatus.thresholdPercent },
            'Disk threshold reached — triggering auto-prune',
          );
          await executeAutoPrune(fastify.db);
        }
      } catch (err) {
        fastify.log.error({ err }, 'housekeeping failed');
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

    // Run once shortly after boot, then hourly.
    timer = setTimeout(() => void tick(), 60_000);
    timer.unref();
    fastify.log.info('housekeeping scheduler started');
  },
  { name: 'ninedeploy-housekeeping' },
);
