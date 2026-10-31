import { createReadStream } from 'node:fs';
import { and, desc, eq } from 'drizzle-orm';
import { ciAttempts, ciJobs } from '@ninedeploy/db';
import { ciJobCreate, ciPipeline, ciRunnerClaim, ciRunnerCreate, ciRunnerFinish, ciRunnerLog } from '@ninedeploy/schemas';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../lib/audit.js';
import {
  approveJob,
  attemptForLease,
  attemptViews,
  authenticateRunner,
  CiError,
  cancelJob,
  claimJob,
  createJob,
  createRunner,
  finishAttempt,
  getPipeline,
  heartbeat,
  jobView,
  listRunners,
  appendLog,
  readLog,
  revokeRunner,
  setPipeline,
} from '../lib/ci.js';
import { buildSourceArchive } from '../lib/ciSource.js';
import { badRequest, conflict, HttpError, notFound, parseId, unauthorized } from '../lib/errors.js';
import { maySeeLaneSecrets } from '../lib/protectedLanes.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';

const LEASE_HEADER = 'x-nd-lease';

const asHttp = (err: unknown): unknown =>
  err instanceof CiError ? new HttpError(err.status, err.status === 409 ? 'conflict' : err.status === 404 ? 'not_found' : 'unauthorized', err.message) : err;

/** `/v1/ci/runners` — enrol, list and revoke runners (operators). */
export const ciRunnerAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async () => listRunners(app.db));

  app.post('/', async (req) => {
    const input = ciRunnerCreate.parse(req.body ?? {});
    const { runner, token } = await createRunner(app.db, input, req.user!.id);
    void audit(app.db, req.user!.id, 'ci.runner_create', runner.name, { runnerId: runner.id });
    // The token is shown once; only its hash is kept.
    return { id: runner.id, name: runner.name, token };
  });

  app.delete('/:runnerId', async (req) => {
    const id = parseId((req.params as { runnerId: string }).runnerId);
    if (!(await revokeRunner(app.db, id))) throw notFound('No such active runner');
    void audit(app.db, req.user!.id, 'ci.runner_revoke', undefined, { runnerId: id });
    return { ok: true };
  });
};

/** `/v1/services/:id/ci…` — a service's pipeline and its jobs. */
export const ciServiceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const service = async (req: FastifyRequest) => {
    const id = parseId((req.params as { id: string }).id);
    return loadServiceForUser(app.db, id, req.user!);
  };
  const jobOf = async (serviceId: number, req: FastifyRequest) => {
    const jobId = parseId((req.params as { jobId: string }).jobId);
    const job = await app.db.query.ciJobs.findFirst({ where: and(eq(ciJobs.id, jobId), eq(ciJobs.serviceId, serviceId)) });
    if (!job) throw notFound('Job not found');
    return job;
  };

  app.get('/:id/ci', async (req) => {
    const svc = await service(req);
    return { pipeline: await getPipeline(app.db, svc.id) };
  });

  // The pipeline decides which service variables leave the panel: admins only.
  app.put('/:id/ci', async (req) => {
    const svc = await service(req);
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    const pipeline = ciPipeline.parse(req.body ?? {});
    await setPipeline(app.db, svc.id, pipeline);
    void audit(app.db, req.user!.id, 'ci.pipeline_set', svc.name, { serviceId: svc.id, secrets: pipeline.secrets });
    return { pipeline };
  });

  app.delete('/:id/ci', async (req) => {
    const svc = await service(req);
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    await setPipeline(app.db, svc.id, null);
    void audit(app.db, req.user!.id, 'ci.pipeline_delete', svc.name, { serviceId: svc.id });
    return { ok: true };
  });

  app.get('/:id/ci/jobs', async (req) => {
    const svc = await service(req);
    const rows = await app.db.query.ciJobs.findMany({ where: eq(ciJobs.serviceId, svc.id), orderBy: [desc(ciJobs.id)], limit: 50 });
    return rows.map(jobView);
  });

  app.post('/:id/ci/jobs', async (req) => {
    const svc = await service(req);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const input = ciJobCreate.parse(req.body ?? {});
    const pipeline = await getPipeline(app.db, svc.id);
    if (!pipeline) throw badRequest('This service has no CI pipeline', 'no_pipeline');
    const job = await createJob(app.db, svc, pipeline, { ref: input.ref, trigger: 'manual', userId: req.user!.id });
    void audit(app.db, req.user!.id, 'ci.job_create', svc.name, { serviceId: svc.id, jobId: job.id });
    return jobView(job);
  });

  app.get('/:id/ci/jobs/:jobId', async (req) => {
    const svc = await service(req);
    const job = await jobOf(svc.id, req);
    return { job: jobView(job), attempts: await attemptViews(app.db, job.id) };
  });

  app.post('/:id/ci/jobs/:jobId/approve', async (req) => {
    const svc = await service(req);
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    const job = await jobOf(svc.id, req);
    if (!(await approveJob(app.db, job.id, req.user!.id))) throw conflict('The job is not waiting for approval');
    void audit(app.db, req.user!.id, 'ci.job_approve', svc.name, { serviceId: svc.id, jobId: job.id });
    return { ok: true };
  });

  app.post('/:id/ci/jobs/:jobId/cancel', async (req) => {
    const svc = await service(req);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const job = await jobOf(svc.id, req);
    if (!(await cancelJob(app.db, job.id, req.user!.id))) throw conflict('The job has already finished');
    void audit(app.db, req.user!.id, 'ci.job_cancel', svc.name, { serviceId: svc.id, jobId: job.id });
    return { ok: true };
  });

  // Logs can echo the variables the job was given: a protected lane keeps them for its admins.
  app.get('/:id/ci/jobs/:jobId/attempts/:number/log', async (req) => {
    const svc = await service(req);
    if (!(await maySeeLaneSecrets(app.db, svc, req.user!))) throw new HttpError(403, 'forbidden', 'Job logs on a protected lane are for its admins');
    const job = await jobOf(svc.id, req);
    const number = parseId((req.params as { number: string }).number);
    const attempt = await app.db.query.ciAttempts.findFirst({ where: and(eq(ciAttempts.jobId, job.id), eq(ciAttempts.number, number)) });
    if (!attempt) throw notFound('Attempt not found');
    const offset = Math.max(0, Number((req.query as { offset?: string }).offset ?? 0) || 0);
    const text = Buffer.from(readLog(job.id, number));
    // `size` is the next offset: chunks are appended whole, so it never splits a character.
    return { data: text.subarray(offset).toString(), size: text.length, done: attempt.status !== 'running' };
  });
};

/** `/v1/ci/runner/…` — what runners call, with their own token (not a user session). */
export const ciRunnerProtocolRoutes: FastifyPluginAsync = async (app) => {
  const runnerOf = async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const runner = await authenticateRunner(app.db, header.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!runner) throw unauthorized('Unknown or revoked runner');
    return runner;
  };
  const leaseOf = async (req: FastifyRequest) => {
    const runner = await runnerOf(req);
    const attemptId = parseId((req.params as { attemptId: string }).attemptId);
    const lease = req.headers[LEASE_HEADER];
    try {
      return { runner, ...(await attemptForLease(app.db, runner, attemptId, typeof lease === 'string' ? lease : undefined)) };
    } catch (err) {
      throw asHttp(err);
    }
  };

  app.post('/claim', async (req, reply: FastifyReply) => {
    const runner = await runnerOf(req);
    const input = ciRunnerClaim.parse(req.body ?? {});
    const claim = await claimJob(app.db, runner, input);
    if (!claim) return reply.code(204).send();
    void audit(app.db, null, 'ci.attempt_start', undefined, { runnerId: runner.id, jobId: claim.jobId, attempt: claim.number });
    return claim;
  });

  app.post('/attempts/:attemptId/heartbeat', async (req) => {
    const { runner, attempt, job } = await leaseOf(req);
    return heartbeat(app.db, runner, attempt, job);
  });

  app.post('/attempts/:attemptId/log', async (req) => {
    const { attempt } = await leaseOf(req);
    const input = ciRunnerLog.parse(req.body ?? {});
    try {
      return await appendLog(app.db, attempt, input.seq, input.data);
    } catch (err) {
      throw asHttp(err);
    }
  });

  app.post('/attempts/:attemptId/finish', async (req) => {
    const { runner, attempt, job } = await leaseOf(req);
    const input = ciRunnerFinish.parse(req.body ?? {});
    try {
      await finishAttempt(app.db, attempt, job, input);
    } catch (err) {
      throw asHttp(err);
    }
    void audit(app.db, null, `ci.job_${input.status}`, undefined, { runnerId: runner.id, jobId: job.id, attempt: attempt.number, exitCode: input.exitCode });
    return { ok: true };
  });

  app.get('/attempts/:attemptId/source', async (req, reply) => {
    const { attempt, job } = await leaseOf(req);
    if (attempt.status !== 'running') throw conflict('The attempt is over');
    const svc = await app.db.query.services.findFirst({ where: (s, { eq: e }) => e(s.id, job.serviceId) });
    if (!svc) throw notFound('Service not found');
    const fresh = await app.db.query.ciJobs.findFirst({ where: eq(ciJobs.id, job.id) });
    const archive = await buildSourceArchive(app.db, svc, fresh ?? job).catch((err: unknown) => {
      throw new HttpError(502, 'source_unavailable', `The panel could not check out the source: ${err instanceof Error ? err.message : String(err)}`);
    });
    const stream = createReadStream(archive.file);
    stream.on('close', archive.cleanup);
    return reply.header('content-type', 'application/gzip').header('x-nd-commit', archive.sha).send(stream);
  });
};
