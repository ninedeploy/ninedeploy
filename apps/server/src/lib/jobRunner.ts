import { eq } from 'drizzle-orm';
import { deployments, jobRuns, scheduledJobs, services, type DB } from '@ninedeploy/db';
import { run } from './exec.js';
import { audit } from './audit.js';
import { assertMayDeployStoredService } from './hostPrivilege.js';
import { isOperator } from './resourceAccess.js';
import { backupServiceVolumes } from '../modules/volumeBackups.js';

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
 * One execution at a time per job, process-wide. Both the cron scheduler and
 * the run-now route funnel through `runJob`, so this covers every entry: a
 * cron tick landing while the previous run is still going (long backup, slow
 * container) — or a double-clicked run-now — must not run the same job
 * twice concurrently. Two parallel volume backups of one service are worse
 * than a skipped tick.
 */
const runningJobIds = new Set<number>();

/**
 * Execute one scheduled job now (used by both the cron scheduler and the
 * run-now route). `deploy` jobs enqueue a deployment (trigger: schedule);
 * `exec` jobs run a command inside the service's runtime container with the
 * output + exit code recorded on a job_runs row; `backup` jobs snapshot
 * every volume currently attached to the service.
 */
export async function runJob(db: DB, jobId: number): Promise<void> {
  if (runningJobIds.has(jobId)) return;
  runningJobIds.add(jobId);
  try {
    await runJobInner(db, jobId);
  } finally {
    runningJobIds.delete(jobId);
  }
}

async function runJobInner(db: DB, jobId: number): Promise<void> {
  const job = await db.query.scheduledJobs.findFirst({ where: eq(scheduledJobs.id, jobId) });
  if (!job) return;

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
  if (!svc.runtimeId || !job.command) return;
  const [runRow] = await db
    .insert(jobRuns)
    .values({ jobId: job.id, status: 'running', startedAt: new Date() })
    .returning();
  const chunks: string[] = [];
  let length = 0;
  const sink = (line: string) => {
    length += line.length + 1;
    if (length <= MAX_OUTPUT) chunks.push(line);
  };
  let exitOk = true;
  try {
    // `--` before the container name: a runtimeId starting with `-` must be
    // treated as an operand, not a flag (same hardening as the exec WS route).
    await run('docker', ['exec', '--', svc.runtimeId, 'sh', '-lc', job.command], {}, sink);
  } catch {
    // The exec layer reports success/failure only (not the command's exit
    // status) — recorded coarsely as 0/1.
    exitOk = false;
  }
  await db
    .update(jobRuns)
    .set({
      status: exitOk ? 'completed' : 'failed',
      exitCode: exitOk ? 0 : 1,
      output: chunks.join('\n'),
      finishedAt: new Date(),
    })
    .where(eq(jobRuns.id, runRow!.id));
  void audit(db, null, exitOk ? 'job.exec' : 'job.exec_failed', job.name);
}
