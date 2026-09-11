import { and, desc, eq } from 'drizzle-orm';
import { buildConfigs, jobRuns, scheduledJobs, type DB } from '@ninedeploy/db';
import { jobCreate, jobPatch } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { Cron } from 'croner';
import { audit } from '../lib/audit.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { assertMayUseHostPrivilege } from '../lib/hostPrivilege.js';
import { badRequest, forbidden, notFound, parseId } from '../lib/errors.js';
import { runJob } from '../lib/jobRunner.js';

/** Validate a 5-field cron expression up front (croner is the runtime parser). */
function assertCron(expr: string): void {
  try {
    new Cron(expr, { paused: true, unref: true });
  } catch {
    throw badRequest('Invalid cron expression (expected 5 fields: minute hour day month weekday)');
  }
}

/**
 * A `deploy` job re-runs the service's build on a schedule. On a
 * host-privileged service (PM2 / compose / lifecycle hooks / docker socket)
 * that means host execution — operator-only, consistent with the manual and
 * webhook deploy paths. runJob re-checks the same boundary against the service
 * OWNER, covering the cron sweep, legacy jobs and role changes after creation.
 */
async function assertMayScheduleDeploy(
  db: DB,
  user: { id: number; isOperator: boolean },
  svc: { id: number; type: string; dockerSocket?: boolean | null },
): Promise<void> {
  const build = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, svc.id) });
  assertMayUseHostPrivilege(user, { type: svc.type, dockerSocket: svc.dockerSocket ?? false, build: build ?? null });
}

function serializeJob(j: typeof scheduledJobs.$inferSelect) {
  return {
    id: j.id,
    serviceId: j.serviceId,
    name: j.name,
    cron: j.cron,
    kind: j.kind,
    command: j.command ?? '',
    enabled: j.enabled,
    lastRunAt: j.lastRunAt ? j.lastRunAt.toISOString() : null,
    createdAt: j.createdAt.toISOString(),
  };
}

/** Scheduled jobs (cron) for a service: redeploys or container commands. */
export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/jobs', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const rows = await app.db.query.scheduledJobs.findMany({
      where: eq(scheduledJobs.serviceId, id),
      orderBy: desc(scheduledJobs.createdAt),
    });
    return rows.map(serializeJob);
  });

  app.post('/:id/jobs', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const input = jobCreate.parse(req.body ?? {});
    assertCron(input.cron);
    if (input.kind === 'exec' && !input.command) throw badRequest('command is required for exec jobs');
    // Exec jobs run arbitrary commands inside the container — admin-only,
    // consistent with the exec WS route and the volume file manager. Backup
    // jobs too (r097): PATCH and run-now already treat them as operator-only
    // (host-level tar files, optional remote push), but create did not, and
    // the cron sweep then ran a member's `* * * * *` backup every minute.
    if ((input.kind === 'exec' || input.kind === 'backup') && !req.user?.isOperator) {
      throw forbidden('Operator access required');
    }
    if (input.kind === 'deploy') {
      await assertMayScheduleDeploy(app.db, req.user!, svc);
    }

    const [row] = await app.db
      .insert(scheduledJobs)
      .values({
        serviceId: id,
        name: input.name,
        cron: input.cron,
        kind: input.kind,
        command: input.kind === 'exec' ? input.command : null,
        enabled: input.enabled,
      })
      .returning();
    if (!row) throw badRequest('Could not create job');
    void audit(app.db, req.user!.id, 'job.create', input.name);
    return serializeJob(row);
  });

  app.patch('/:id/jobs/:jobId', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const jobId = parseId((req.params as { jobId: string }).jobId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const input = jobPatch.parse(req.body ?? {});
    // The admin gate must consider the STORED job too: patching only `command`
    // on an existing exec job (no `kind` in the request body) is still editing
    // an arbitrary-container-command job.
    const existingJob = await app.db.query.scheduledJobs.findFirst({
      where: and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.serviceId, id)),
    });
    if (!existingJob) throw notFound('Job not found');
    const values: Partial<typeof scheduledJobs.$inferInsert> = {};
    if (input.name?.trim()) values.name = input.name.trim();
    if (input.cron?.trim()) {
      assertCron(input.cron.trim());
      values.cron = input.cron.trim();
    }
    if (input.kind !== undefined) values.kind = input.kind;
    if (input.command !== undefined) values.command = input.command.trim() || null;
    if (input.enabled !== undefined) values.enabled = input.enabled;
    // Creating, switching to, or editing an exec job means arbitrary container
    // commands — admin-only. Backup jobs are also admin-only: they create
    // host-level files (`sibling container + tar` to the data dir) and
    // optionally push to remote storage.
    const isExecLike = values.kind === 'exec' || existingJob.kind === 'exec';
    const isBackup = values.kind === 'backup' || existingJob.kind === 'backup';
    if ((isExecLike || isBackup) && !req.user?.isOperator) {
      throw forbidden('Operator access required');
    }
    // Switching a job TO deploy re-evaluates the host-privilege boundary
    // (creating a deploy job directly is gated the same way).
    if (values.kind === 'deploy') {
      await assertMayScheduleDeploy(app.db, req.user!, svc);
    }
    const [row] = await app.db
      .update(scheduledJobs)
      .set(values)
      .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.serviceId, id)))
      .returning();
    if (!row) throw notFound('Job not found');
    void audit(app.db, req.user!.id, 'job.update', row.name);
    return serializeJob(row);
  });

  app.delete('/:id/jobs/:jobId', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const jobId = parseId((req.params as { jobId: string }).jobId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await app.db.delete(scheduledJobs).where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.serviceId, id)));
    void audit(app.db, req.user!.id, 'job.delete', `#${jobId}`);
    return { ok: true };
  });

  // Run immediately, ignoring the cron schedule.
  app.post('/:id/jobs/:jobId/run', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const jobId = parseId((req.params as { jobId: string }).jobId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const job = await app.db.query.scheduledJobs.findFirst({
      where: and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.serviceId, id)),
    });
    if (!job) throw notFound('Job not found');
    if ((job.kind === 'exec' || job.kind === 'backup') && !req.user?.isOperator) {
      throw forbidden('Operator access required');
    }
    if (job.kind === 'deploy') {
      await assertMayScheduleDeploy(app.db, req.user!, svc);
    }
    await runJob(app.db, jobId);
    void audit(app.db, req.user!.id, 'job.run', job.name);
    return { ok: true };
  });

  // Run history for one job (latest 20).
  app.get('/:id/jobs/:jobId/runs', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const jobId = parseId((req.params as { jobId: string }).jobId);
    // Owning the service is not enough: `jobId` must belong to THIS service.
    // Without this, any member who owns any service could read every job's
    // captured output by iterating jobId — including admin-only `exec` jobs,
    // whose output is up to 60 KB of arbitrary in-container command results.
    const job = await app.db.query.scheduledJobs.findFirst({
      where: and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.serviceId, id)),
    });
    if (!job) throw notFound('Job not found');
    const rows = await app.db.query.jobRuns.findMany({
      where: eq(jobRuns.jobId, jobId),
      orderBy: desc(jobRuns.createdAt),
      limit: 20,
    });
    return rows.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      status: r.status,
      output: r.output,
      exitCode: r.exitCode,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
};
