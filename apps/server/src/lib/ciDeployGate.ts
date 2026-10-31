import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import { ciJobs, type DB, type Deployment, deployments, type Service, services } from '@ninedeploy/db';
import type { CiPipeline } from '@ninedeploy/schemas';
import { cancelJob, createJob, getPipeline, hasSource } from './ci.js';
import type { CiGateTransition } from './ciGate.js';
import type { PushEvent } from './webhooks.js';

/**
 * R5: deploys gated on a NineDeploy CI job.
 *
 * A pipeline with `gateDeploys` holds every queued deploy of its service (and
 * of the service's PR previews) in `awaiting_ci` while a job runs at the
 * deploy's commit. The job pins the commit it tested; a pass writes that
 * commit onto the deploy and queues it again, so the build checks out exactly
 * what the job passed. A failed or cancelled job fails the deploy.
 *
 * The link is `ci_jobs.deployment_id`. A gated deploy carries no `ciGate`
 * (that column belongs to the GitHub workflow gate, which runs after this one
 * and skips rows without it).
 */

const LIVE = ['awaiting_approval', 'queued', 'running'] as const;

/** The pipeline that gates this service's deploys: its own, or its PR preview parent's. */
export async function gatingPipeline(db: DB, service: Service): Promise<CiPipeline | null> {
  const pipeline = await getPipeline(db, service.previewParentServiceId ?? service.id);
  return pipeline?.gateDeploys ? pipeline : null;
}

const latestJob = (db: DB, deploymentId: number) =>
  db.query.ciJobs.findFirst({ where: eq(ciJobs.deploymentId, deploymentId), orderBy: [desc(ciJobs.id)] });

/** A passed job counts for exactly the commit it tested; without source there is no commit to match. */
const passedFor = (job: typeof ciJobs.$inferSelect, dep: Deployment, service: Service): boolean =>
  job.status === 'succeeded' && (hasSource(service) ? !!job.commitSha && job.commitSha === dep.commitSha : true);

/**
 * Called from the worker's claim path for a queued deploy. True when the
 * deploy must not start now (it was moved to `awaiting_ci` or is no longer
 * queued).
 */
export async function holdForRunnerCiIfNeeded(db: DB, deploymentId: number): Promise<boolean> {
  const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
  if (!dep || dep.status !== 'queued') return true;
  const service = await db.query.services.findFirst({ where: eq(services.id, dep.serviceId) });
  if (!service) return true;
  const pipeline = await gatingPipeline(db, service);
  if (!pipeline) return false;
  let job = await latestJob(db, dep.id);
  if (job && passedFor(job, dep, service)) return false;
  if (!job || !(LIVE as readonly string[]).includes(job.status)) {
    job = await createJob(db, service, pipeline, {
      ref: dep.commitSha ?? undefined,
      trigger: 'deploy',
      userId: null,
      deploymentId: dep.id,
      // Code from a fork runs on a runner only after an admin looked at it.
      requireApproval: service.previewFromFork === true,
    });
    if (service.previewFromFork === true && !dep.commitSha && hasSource(service)) {
      // The approval would cover whatever the fork branch holds when a runner
      // fetches it, not code an admin saw: fail the job, and with it the deploy.
      await db
        .update(ciJobs)
        .set({ status: 'failed', finishedAt: new Date(), error: 'A pull request from a fork is tested only at a known commit; redeploy it from the pull request' })
        .where(and(eq(ciJobs.id, job.id), inArray(ciJobs.status, [...LIVE])));
    }
  }
  const held = await db
    .update(deployments)
    .set({
      status: 'awaiting_ci',
      // An approval given for "the branch" cannot approve a commit the job pins later.
      ...(!dep.commitSha ? { reviewedBy: null, reviewedAt: null } : {}),
    })
    .where(and(eq(deployments.id, dep.id), eq(deployments.status, 'queued')))
    .returning({ id: deployments.id });
  if (!held.length) await cancelJob(db, job.id, null);
  return true;
}

/**
 * Move gated deploys on once their job is over, and stop jobs whose deploy
 * went away (cancelled, or replaced by a newer one).
 */
export async function settleRunnerCiGates(db: DB, now = Date.now()): Promise<CiGateTransition[]> {
  const transitions: CiGateTransition[] = [];
  // Every waiting deploy, a page at a time: rows whose job still runs stay in
  // the set, so a fixed first page could hide a passed job behind them.
  for (let after = 0; ; ) {
    const page = await db.query.deployments.findMany({
      where: and(eq(deployments.status, 'awaiting_ci'), isNull(deployments.ciGate), gt(deployments.id, after)),
      orderBy: [asc(deployments.id)],
      limit: 50,
    });
    for (const dep of page) await settleOne(db, dep, now, transitions);
    if (page.length < 50) break;
    after = page[page.length - 1]!.id;
  }

  // Jobs still running for a deploy that is no longer waiting on them. Each
  // one leaves the set once cancelled, so a page per tick drains them.
  const orphaned = await db
    .select({ jobId: ciJobs.id })
    .from(ciJobs)
    .innerJoin(deployments, eq(deployments.id, ciJobs.deploymentId))
    .where(and(isNotNull(ciJobs.deploymentId), inArray(ciJobs.status, [...LIVE]), inArray(deployments.status, ['cancelled', 'failed', 'superseded'])))
    .limit(50);
  for (const { jobId } of orphaned) await cancelJob(db, jobId, null);
  return transitions;
}

async function settleOne(db: DB, dep: Deployment, now: number, transitions: CiGateTransition[]): Promise<void> {
  const job = await latestJob(db, dep.id);
  const guard = and(eq(deployments.id, dep.id), eq(deployments.status, 'awaiting_ci'), isNull(deployments.ciGate));
  if (!job) {
    // Held without a job (a crash between the two writes): the claim path decides again.
    await db.update(deployments).set({ status: 'queued' }).where(guard);
    return;
  }
  const service = await db.query.services.findFirst({ where: eq(services.id, dep.serviceId) });
  if (!service) return;
  if (!(await gatingPipeline(db, service))) {
    // The gate was removed while the deploy waited: let it go, and stop its job.
    const released = await db.update(deployments).set({ status: 'queued' }).where(guard).returning({ id: deployments.id });
    if ((LIVE as readonly string[]).includes(job.status)) await cancelJob(db, job.id, null);
    if (released.length) transitions.push({ deploymentId: dep.id, serviceId: dep.serviceId, status: 'queued', reason: 'The CI gate was removed' });
    return;
  }
  if ((LIVE as readonly string[]).includes(job.status)) return;
  let status: 'queued' | 'failed';
  let reason: string;
  if (job.status !== 'succeeded') {
    status = 'failed';
    reason = `CI job #${job.id} ${job.status === 'cancelled' ? 'was cancelled' : `failed${job.error ? `: ${job.error}` : ''}`}`;
  } else if (hasSource(service) && !job.commitSha) {
    status = 'failed';
    reason = `CI job #${job.id} passed without a recorded commit`;
  } else if (dep.commitSha && job.commitSha !== dep.commitSha) {
    status = 'failed';
    reason = `CI job #${job.id} tested another commit`;
  } else {
    status = 'queued';
    reason = `CI job #${job.id} passed${job.commitSha ? ` at ${job.commitSha.slice(0, 7)}` : ''}`;
  }
  const moved = await db
    .update(deployments)
    .set(status === 'queued' ? { status, commitSha: job.commitSha } : { status, finishedAt: new Date(now) })
    .where(guard)
    .returning({ id: deployments.id });
  if (moved.length) transitions.push({ deploymentId: dep.id, serviceId: dep.serviceId, status, reason });
}

/** The pipeline's last guard: a gated deploy builds only the commit its job passed. */
export async function assertRunnerCiForBuild(db: DB, dep: Deployment, service: Service): Promise<void> {
  if (!(await gatingPipeline(db, service))) return;
  const job = await latestJob(db, dep.id);
  if (!job || !passedFor(job, dep, service)) throw new Error('The CI job for this deploy has not passed at this commit');
}

/**
 * A push to the service branch runs the pipeline when it asks for that. A
 * gating pipeline is left alone: the deploy the push queues runs its own job.
 * A replayed delivery for a commit that already has a job adds none.
 */
export async function runCiOnPush(db: DB, serviceId: number, push: PushEvent): Promise<number | null> {
  const pipeline = await getPipeline(db, serviceId);
  if (!pipeline?.runOnPush || pipeline.gateDeploys || !/^[0-9a-f]{40}$/i.test(push.sha)) return null;
  const sha = push.sha.toLowerCase();
  const existing = await db.query.ciJobs.findFirst({
    where: and(eq(ciJobs.serviceId, serviceId), eq(ciJobs.commitSha, sha), eq(ciJobs.trigger, 'push')),
  });
  if (existing) return null;
  const job = await createJob(db, { id: serviceId }, pipeline, { ref: sha, trigger: 'push', userId: null });
  return job.id;
}
