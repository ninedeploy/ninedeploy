import { and, eq } from 'drizzle-orm';
import { deployments, jobRuns, scheduledJobs, services, type DB } from '@ninedeploy/db';
import { run } from './exec.js';
import { audit } from './audit.js';
import { MAX_QUEUED_PER_SERVICE } from './deployQueue.js';
import { assertMayDeployStoredService } from './hostPrivilege.js';
import { isOperator } from './resourceAccess.js';
import { backupServiceVolumes } from '../modules/volumeBackups.js';
import { localSwarmTaskFor, swarmRuntimeOf } from './swarm.js';

const MAX_OUTPUT = 60_000; // ~60 KB of captured output per run

/**
 * Scheduled deploys carry no panel session — the same rule as webhook
 * deliveries (assertWebhookMayDeploy): authorize against the service OWNER's
 * privileges, so a `deploy` job for a host-executing service (PM2 / compose /
 * lifecycle hooks / docker socket) cannot use the job path to run a deploy its
 * owner could not have started from the UI themselves.
 */
async function assertJobMayDeploy(
  db: DB,
  svc: { id: number; type: string; dockerSocket?: boolean | null; ownerUserId: number | null },
): Promise<void> {
  const ownerId = svc.ownerUserId;
  // Legacy rows created before ownership existed have no owner to authorize
  // against (same convention as assertWebhookMayDeploy): they predate members
  // entirely, so defer instead of breaking their schedules.
  if (!ownerId) return;
  const ownerIsOperator = await isOperator(db, { id: ownerId });
  await assertMayDeployStoredService(db, { id: ownerId, isOperator: ownerIsOperator }, svc);
}

/**
 * r523: why an `exec` job cannot run against this service, or null.
 *
 * The runner shells out to the PANEL host's `docker exec` on `runtimeId`.
 * That is right for a local docker or compose service (a compose runtimeId is
 * its main container's name) and wrong for everything else: a PM2 runtime is
 * a process name, not a container, and a node-pinned service's container
 * lives on the node — the agent has no exec operation. Both used to fail every
 * run with a bare docker "No such container" error.
 */
export function execJobUnsupportedReason(svc: { type?: string | null; serverId?: number | null }): string | null {
  if (svc.serverId != null) {
    return "Exec jobs are not available for a service on a remote server: the command would run through the panel host's Docker, and the node agent has no exec operation. Delete or disable this job, or clear the service's target server.";
  }
  // A missing type is a docker service (the column's default), as in lib/remoteDeploy.
  const type = svc.type ?? 'docker';
  if (type !== 'docker' && type !== 'compose') {
    return `Exec jobs run inside a container, and a ${type} service has none. Delete or disable this job.`;
  }
  return null;
}

/**
 * One execution at a time per job, process-wide. Both the cron scheduler and
 * the run-now route funnel through `runJob`, so this covers every entry: a
 * cron tick landing while the previous run is still going (long backup, slow
 * container) — or a double-clicked run-now — must not run the same job
 * twice concurrently. Two parallel volume backups of one service are worse
 * than a skipped tick.
 */
const runningJobIds = new Set<number>();

export interface RunJobOptions {
  /**
   * True when a cron tick (plugins/jobScheduler.ts) fired this run, false /
   * absent for the run-now route. See the r303 check in `runJobInner`.
   */
  scheduled?: boolean;
}

/**
 * Execute one scheduled job now (used by both the cron scheduler and the
 * run-now route). `deploy` jobs enqueue a deployment (trigger: schedule);
 * `exec` jobs run a command inside the service's runtime container with the
 * output + exit code recorded on a job_runs row; `backup` jobs snapshot
 * every volume currently attached to the service.
 */
export async function runJob(db: DB, jobId: number, opts: RunJobOptions = {}): Promise<void> {
  if (runningJobIds.has(jobId)) return;
  runningJobIds.add(jobId);
  try {
    await runJobInner(db, jobId, opts);
  } finally {
    runningJobIds.delete(jobId);
  }
}

async function runJobInner(db: DB, jobId: number, opts: RunJobOptions): Promise<void> {
  const job = await db.query.scheduledJobs.findFirst({ where: eq(scheduledJobs.id, jobId) });
  if (!job) return;
  // r303: the scheduler arms its crons from a snapshot it reloads only every
  // 5 minutes, so a job the operator just disabled kept firing — deploying,
  // exec'ing, backing up — until the next reload. The row read above is
  // current: a scheduled run of a disabled job stops here. A manual run-now
  // is an explicit request and still runs a disabled job.
  if (opts.scheduled && !job.enabled) return;

  await db.update(scheduledJobs).set({ lastRunAt: new Date() }).where(eq(scheduledJobs.id, job.id));
  const svc = await db.query.services.findFirst({ where: eq(services.id, job.serviceId) });
  if (!svc) return;

  if (job.kind === 'deploy') {
    // A scheduled deploy must obey the same host-privilege boundary as every
    // other unattended deploy path. Refusals are audited rather than thrown:
    // the job stays listed and the sweep skips it, while the audit trail says
    // WHY it never fires.
    try {
      await assertJobMayDeploy(db, svc);
    } catch (err) {
      void audit(db, null, 'job.deploy_refused', `${job.name}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // F103: the same per-service queued cap as every user-triggered enqueue
    // (lib/deployQueue). An every-minute deploy job behind a slow or stalled
    // worker used to stack one queued row per tick without limit.
    const queued = await db.query.deployments.findMany({
      where: and(eq(deployments.serviceId, job.serviceId), eq(deployments.status, 'queued')),
      columns: { id: true },
    });
    if (queued.length >= MAX_QUEUED_PER_SERVICE) {
      void audit(
        db,
        null,
        'job.deploy_skipped',
        `${job.name}: the service already has ${queued.length} queued deploys (max ${MAX_QUEUED_PER_SERVICE})`,
      );
      return;
    }
    // Delegated to the deployments table; the worker picks it up like any other.
    await db.insert(deployments).values({
      serviceId: job.serviceId,
      status: 'queued',
      trigger: 'schedule',
      message: `Scheduled job: ${job.name}`,
    });
    void audit(db, null, 'job.deploy', job.name);
    return;
  }

  if (job.kind === 'backup') {
    // Snapshot the service's primary volume (when set) plus every row in
    // `service_volume_attachments`. The route path takes a single volume;
    // the scheduled sweep iterates the full set.
    const sink = (line: string) => console.log(`[scheduled backup] ${line}`);
    try {
      const result = await backupServiceVolumes({ db } as never, svc.id, sink);
      void audit(db, null, result.failed > 0 ? 'job.backup_failed' : 'job.backup', `${job.name} (${result.created} ok, ${result.failed} failed)`);
    } catch (err) {
      void audit(db, null, 'job.backup_failed', `${job.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // exec: run inside the runtime container — output + exit code recorded.
  // r523: a service the panel cannot exec into records a FAILED run that says
  // why, instead of a docker error (or nothing at all).
  let unsupported = execJobUnsupportedReason(svc);
  // ── 0.16 T7 swarm ── a Swarm service runs the job in one of its tasks on the panel host (design §7.4), or records why not.
  let execContainer = svc.runtimeId;
  const swarmRuntime = swarmRuntimeOf(svc);
  if (!unsupported && job.command && swarmRuntime) {
    const task = await localSwarmTaskFor(swarmRuntime);
    if ('refusal' in task) unsupported = task.refusal;
    else execContainer = task.container;
  }
  // ── end 0.16 T7 ──
  if (unsupported && job.command) {
    const now = new Date();
    await db
      .insert(jobRuns)
      .values({ jobId: job.id, status: 'failed', exitCode: 1, output: unsupported, startedAt: now, finishedAt: now });
    void audit(db, null, 'job.exec_failed', `${job.name}: ${unsupported}`);
    return;
  }
  if (!svc.runtimeId || !execContainer || !job.command) return;
  const [runRow] = await db
    .insert(jobRuns)
    .values({ jobId: job.id, status: 'running', startedAt: new Date() })
    .returning();
  const chunks: string[] = [];
  // F100: `length` is the size of `chunks.join('\n')`. Keep the HEAD of the
  // output up to MAX_OUTPUT chars, cutting the line that crosses the cap
  // instead of dropping it — one long line (minified JSON) used to record
  // an empty output.
  let length = 0;
  const sink = (line: string) => {
    const sep = chunks.length > 0 ? 1 : 0;
    const room = MAX_OUTPUT - length - sep;
    if (room <= 0) return;
    let piece = line.length > room ? line.slice(0, room) : line;
    // Never end on half of a surrogate pair.
    if (piece.length < line.length && /[\uD800-\uDBFF]$/.test(piece)) piece = piece.slice(0, -1);
    chunks.push(piece);
    length += sep + piece.length;
  };
  let exitOk = true;
  let failure: string | null = null;
  try {
    // `--` before the container name: a runtimeId starting with `-` must be
    // treated as an operand, not a flag (same hardening as the exec WS route).
    await run('docker', ['exec', '--', execContainer, 'sh', '-lc', job.command], {}, sink);
  } catch (err) {
    // The exec layer reports success/failure only (not the command's exit
    // status) — recorded coarsely as 0/1.
    exitOk = false;
    // F101: say WHY (timeout, docker missing, exit code) — the bare catch
    // left a failed run with empty or partial output. The command line is
    // masked: it routinely carries credentials (r280).
    failure = (err instanceof Error ? err.message : String(err)).split(`-lc ${job.command}`).join('-lc <command>');
  }
  const output = failure === null ? chunks.join('\n') : [...chunks, `Failed: ${failure}`].join('\n');
  await db
    .update(jobRuns)
    .set({
      status: exitOk ? 'completed' : 'failed',
      exitCode: exitOk ? 0 : 1,
      output,
      finishedAt: new Date(),
    })
    .where(eq(jobRuns.id, runRow!.id));
  void audit(db, null, exitOk ? 'job.exec' : 'job.exec_failed', job.name);
}
