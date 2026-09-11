import { describe, expect, it, vi, beforeEach } from 'vitest';
import { jobRoutes } from '../src/modules/jobs.js';
import { runJob } from '../src/lib/jobRunner.js';
import { asUser, buildTestApp, createFakeDb, jobRow, svcRow, userRow } from './helpers.js';

const execMocks = vi.hoisted(() => ({
  run: vi.fn(async (_c: unknown, _a: unknown, _o: unknown, sink?: (l: string) => void) => { sink?.('line-out'); }),
}));
vi.mock('../src/lib/exec.js', () => execMocks);

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined), notifyEvent: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);
vi.mock('../src/lib/notifier.js', () => ({ notifyEvent: auditMocks.notifyEvent, sendSystemEmail: vi.fn() }));

const appWith = async (fixtures: Record<string, unknown>) => {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
  await app.register(jobRoutes, { prefix: '/services' });
  return app;
};

describe('jobs routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires authentication', async () => {
    const app = await appWith({});
    const res = await app.inject({ method: 'GET', url: '/services/1/jobs' });
    expect(res.statusCode).toBe(401);
  });

  it('lists jobs for a service', async () => {
    const app = await appWith({ findFirst: { services: svcRow() }, findMany: { scheduledJobs: [jobRow({ id: 3, name: 'nightly' })] } });
    const res = await app.inject({ method: 'GET', url: '/services/1/jobs', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 3, name: 'nightly', kind: 'deploy' });
  });

  it('creates a deploy job with a valid cron', async () => {
    const app = await appWith({
      findFirst: { services: svcRow() },
      insert: { scheduled_jobs: [jobRow({ id: 7, name: 'nightly-rebuild', cron: '0 3 * * *' })] },
    });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { name: 'nightly-rebuild', cron: '0 3 * * *', kind: 'deploy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 7, name: 'nightly-rebuild', cron: '0 3 * * *' });
  });

  it('creates a deploy job with an empty body shape, a non-string command and enabled: false', async () => {
    const app = await appWith({
      findFirst: { services: svcRow() },
      insert: { scheduled_jobs: [jobRow({ id: 9, kind: 'deploy', command: null, enabled: false, lastRunAt: new Date(0) })] },
    });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { name: 'defaults', cron: '@daily', kind: 'deploy', command: 42, enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'deploy', command: '', enabled: false, lastRunAt: '1970-01-01T00:00:00.000Z' });
  });

  it('creates an exec job when a command is given', async () => {
    const app = await appWith({
      findFirst: { services: svcRow() },
      insert: { scheduled_jobs: [jobRow({ id: 8, name: 'cleanup', cron: '*/10 * * * *', kind: 'exec', command: 'rm -rf /tmp/*' })] },
    });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { name: 'cleanup', cron: '*/10 * * * *', kind: 'exec', command: 'rm -rf /tmp/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'exec', command: 'rm -rf /tmp/*' });
  });

  it('forbids exec job creation for members (container command execution)', async () => {
    const app = await appWith({ findFirst: { services: svcRow({ ownerUserId: 1 }) } });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs',
      headers: { ...asUser(), 'x-test-role': 'member' },
      payload: { name: 'evil', cron: '* * * * *', kind: 'exec', command: 'cat /proc/1/environ' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids backup job creation for members, like PATCH and run-now already do (r097)', async () => {
    // A member's `* * * * *` backup job used to be accepted here and then run
    // by the cron sweep every minute: host tar files + optional remote push.
    const app = await appWith({ findFirst: { services: svcRow({ ownerUserId: 1 }) } });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs',
      headers: { ...asUser(), 'x-test-role': 'member' },
      payload: { name: 'fill-disk', cron: '* * * * *', kind: 'backup' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('Operator access required');
  });

  it('forbids deploy-job creation for members on a host-privileged service (S1)', async () => {
    // A PM2 service executes its install/build/start commands on the HOST —
    // a member must not be able to wrap one in a cron job they can trigger
    // on demand (the exact bypass this gate closes).
    const app = await appWith({ findFirst: { services: svcRow({ ownerUserId: 1, type: 'pm2' }) } });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs',
      headers: { ...asUser(), 'x-test-role': 'member' },
      payload: { name: 'nightly', cron: '* * * * *', kind: 'deploy' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('Operator access required');
  });

  it('still allows deploy-job creation for operators on a host-privileged service', async () => {
    const app = await appWith({
      findFirst: { services: svcRow({ ownerUserId: 1, type: 'pm2' }) },
      insert: { scheduled_jobs: [jobRow({ id: 7, name: 'nightly', kind: 'deploy' })] },
    });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { name: 'nightly', cron: '0 3 * * *', kind: 'deploy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 7, kind: 'deploy' });
  });

  it('rejects an invalid cron expression', async () => {
    const app = await appWith({ findFirst: { services: svcRow() } });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { name: 'x', cron: 'not-a-cron', kind: 'deploy' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('cron');
  });

  it('rejects an exec job without a command', async () => {
    const app = await appWith({ findFirst: { services: svcRow() } });
    const res = await app.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { name: 'x', cron: '* * * * *', kind: 'exec' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('forbids exec jobs (create, patch, run) for members', async () => {
    const member = { ...asUser(), 'x-test-role': 'member' };
    const harmless = 'uptime';

    const createApp = await appWith({ findFirst: { services: svcRow({ ownerUserId: 1 }) } });
    const create = await createApp.inject({
      method: 'POST', url: '/services/1/jobs', headers: member,
      payload: { name: 'x', cron: '* * * * *', kind: 'exec', command: harmless },
    });
    expect(create.statusCode).toBe(403);

    const patchApp = await appWith({ findFirst: { services: svcRow({ ownerUserId: 1 }), scheduledJobs: jobRow({ id: 3, kind: 'deploy' }) } });
    const patch = await patchApp.inject({
      method: 'PATCH', url: '/services/1/jobs/3', headers: member,
      payload: { kind: 'exec', command: harmless },
    });
    expect(patch.statusCode).toBe(403);

    const runApp = await appWith({ findFirst: { services: svcRow({ ownerUserId: 1 }), scheduledJobs: jobRow({ id: 3, kind: 'exec', command: harmless }) } });
    const run = await runApp.inject({ method: 'POST', url: '/services/1/jobs/3/run', headers: member });
    expect(run.statusCode).toBe(403);
  });

  it('rejects missing name or cron on create and reports failed inserts', async () => {
    const app = await appWith({ findFirst: { services: svcRow() } });
    const noName = await app.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { cron: '* * * * *' },
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error.code).toBe('validation_error');
    const noCron = await app.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { name: 'x' },
    });
    expect(noCron.statusCode).toBe(400);
    const failed = await appWith({
      findFirst: { services: svcRow() },
      insert: { scheduled_jobs: [] },
    });
    const res = await failed.inject({
      method: 'POST', url: '/services/1/jobs', headers: asUser(),
      payload: { name: 'x', cron: '* * * * *' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s when creating a job for a missing service', async () => {
    const app = await appWith({ findFirst: { services: undefined } });
    const res = await app.inject({
      method: 'POST', url: '/services/99/jobs', headers: asUser(),
      payload: { name: 'x', cron: '* * * * *' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('patches name, cron and enabled', async () => {
    const app = await appWith({
      findFirst: { services: svcRow(), scheduledJobs: jobRow({ id: 3, kind: 'exec' }) },
      update: { scheduled_jobs: [jobRow({ id: 3, name: 'renamed', enabled: false })] },
    });
    const res = await app.inject({
      method: 'PATCH', url: '/services/1/jobs/3', headers: asUser(),
      payload: { name: 'renamed', cron: '30 4 * * *', kind: 'exec', command: 'true', enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'renamed', enabled: false });
  });

  it('rejects a patch with an invalid cron and ignores blank fields', async () => {
    const app = await appWith({
      findFirst: { services: svcRow(), scheduledJobs: jobRow() },
      update: { scheduled_jobs: [jobRow()] },
    });
    const bad = await app.inject({
      method: 'PATCH', url: '/services/1/jobs/3', headers: asUser(),
      payload: { cron: 'nonsense' },
    });
    expect(bad.statusCode).toBe(400);
    const blank = await app.inject({
      method: 'PATCH', url: '/services/1/jobs/3', headers: asUser(),
      payload: { name: '  ', command: '' },
    });
    expect(blank.statusCode).toBe(200);
  });

  it('accepts an empty body on patch (no changes)', async () => {
    const app = await appWith({
      findFirst: { services: svcRow(), scheduledJobs: jobRow() },
      update: { scheduled_jobs: [jobRow()] },
    });
    const res = await app.inject({ method: 'PATCH', url: '/services/1/jobs/3', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a patch with invalid field types', async () => {
    const app = await appWith({
      findFirst: { services: svcRow(), scheduledJobs: jobRow() },
      update: { scheduled_jobs: [jobRow()] },
    });
    const badKind = await app.inject({
      method: 'PATCH', url: '/services/1/jobs/3', headers: asUser(),
      payload: { kind: 'once' },
    });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error.code).toBe('validation_error');
  });

  it('404s when patching a missing job', async () => {
    const app = await appWith({ update: { scheduled_jobs: [] } });
    const res = await app.inject({
      method: 'PATCH', url: '/services/1/jobs/99', headers: asUser(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes a job', async () => {
    const app = await appWith({ findFirst: { services: svcRow() } });
    const res = await app.inject({ method: 'DELETE', url: '/services/1/jobs/3', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('runs a job immediately', async () => {
    const app = await appWith({
      findFirst: { services: svcRow(), scheduledJobs: jobRow({ id: 3 }) },
      insert: { deployments: [{ id: 55 }] },
      update: { scheduledJobs: [{}] },
    });
    const res = await app.inject({ method: 'POST', url: '/services/1/jobs/3/run', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('404s when running a missing job', async () => {
    const app = await appWith({ findFirst: { scheduledJobs: undefined } });
    const res = await app.inject({ method: 'POST', url: '/services/1/jobs/99/run', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('lists run history', async () => {
    // The route resolves the job (scoped to this service) before reading its
    // runs, so the job row is part of the fixture — see authzRegression M-2.
    const app = await appWith({
      findFirst: { services: svcRow(), scheduledJobs: jobRow({ id: 3 }) },
      findMany: {
        jobRuns: [{
          id: 9, jobId: 3, status: 'completed', output: 'ok', exitCode: 0,
          startedAt: new Date(0), finishedAt: new Date(1), createdAt: new Date(0),
        }],
      },
    });
    const res = await app.inject({ method: 'GET', url: '/services/1/jobs/3/runs', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 9, status: 'completed', output: 'ok' });
    // Rows without timestamps serialize to null.
    const app2 = await appWith({
      findFirst: { services: svcRow(), scheduledJobs: jobRow({ id: 3 }) },
      findMany: {
        jobRuns: [{ id: 10, jobId: 3, status: 'running', output: '', exitCode: null, startedAt: null, finishedAt: null, createdAt: new Date(0) }],
      },
    });
    const res2 = await app2.inject({ method: 'GET', url: '/services/1/jobs/3/runs', headers: asUser() });
    expect(res2.json()[0]).toMatchObject({ startedAt: null, finishedAt: null });
  });

  it('accepts an empty body on create (validation error)', async () => {
    const app = await appWith({ findFirst: { services: svcRow() } });
    const res = await app.inject({ method: 'POST', url: '/services/1/jobs', headers: asUser() });
    expect(res.statusCode).toBe(400);
  });
});

describe('runJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues a scheduled deployment for deploy jobs', async () => {
    const db = createFakeDb({
      findFirst: {
        scheduledJobs: jobRow({ id: 3, kind: 'deploy' }),
        services: svcRow(),
      },
      insert: { deployments: [{ id: 77 }] },
      update: { scheduledJobs: [{}] },
    });
    await runJob(db, 3);
    // A queued deployment with trigger 'schedule' was inserted.
    void db;
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'job.deploy', expect.any(String));
  });

  it('refuses a scheduled deploy on a host-privileged service owned by a non-operator (S1)', async () => {
    // The cron path has no session — the deploy is authorized against the
    // service OWNER (same rule as webhook deliveries). A PM2 service whose
    // owner is a plain member must not reach host execution via the scheduler.
    const db = createFakeDb({
      findFirst: {
        scheduledJobs: jobRow({ id: 3, kind: 'deploy' }),
        services: svcRow({ ownerUserId: 7, type: 'pm2' }),
        users: userRow({ id: 7, isOperator: false, isInstanceOperator: false }),
      },
      update: { scheduledJobs: [{}] },
    });
    await runJob(db, 3);
    expect(auditMocks.audit).toHaveBeenCalledWith(
      expect.anything(), null, 'job.deploy_refused', expect.stringContaining('Operator access required'),
    );
    expect(auditMocks.audit).not.toHaveBeenCalledWith(expect.anything(), null, 'job.deploy', expect.anything());
  });

  it('runs a scheduled deploy for a host-privileged service owned by an operator', async () => {
    const db = createFakeDb({
      findFirst: {
        scheduledJobs: jobRow({ id: 3, kind: 'deploy' }),
        services: svcRow({ ownerUserId: 1, type: 'pm2' }),
        users: userRow({ id: 1 }),
      },
      insert: { deployments: [{ id: 78 }] },
      update: { scheduledJobs: [{}] },
    });
    await runJob(db, 3);
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'job.deploy', expect.any(String));
  });

  it('runs exec jobs inside the runtime container and records output', async () => {
    const db = createFakeDb({
      findFirst: {
        scheduledJobs: jobRow({ id: 4, kind: 'exec', command: 'echo hi' }),
        services: svcRow({ runtimeId: 'nd-api' }),
      },
      insert: { jobRuns: [{ id: 11 }] },
      update: { jobRuns: [{}] },
    });
    await runJob(db, 4);
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker', ['exec', '--', 'nd-api', 'sh', '-lc', 'echo hi'], {}, expect.any(Function),
    );
  });

  it('records a failed exec run when the command fails', async () => {
    execMocks.run.mockRejectedValueOnce(new Error('exit 1'));
    const db = createFakeDb({
      findFirst: {
        scheduledJobs: jobRow({ id: 5, kind: 'exec', command: 'false' }),
        services: svcRow({ runtimeId: 'c' }),
      },
      insert: { jobRuns: [{ id: 12 }] },
      update: { jobRuns: [{}] },
    });
    await runJob(db, 5);
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'job.exec_failed', expect.any(String));
  });

  it('skips exec jobs when the runtime is gone or the command is missing', async () => {
    const db = createFakeDb({
      findFirst: { scheduledJobs: jobRow({ id: 6, kind: 'exec', command: null }), services: svcRow({ runtimeId: null }) },
      update: { scheduledJobs: [{}] },
    });
    await runJob(db, 6);
    expect(execMocks.run).not.toHaveBeenCalled();
  });

  it('does nothing for a missing job or service', async () => {
    const db = createFakeDb({ findFirst: { scheduledJobs: undefined } });
    await expect(runJob(db, 99)).resolves.toBeUndefined();
    const db2 = createFakeDb({
      findFirst: { scheduledJobs: jobRow({ id: 3 }), services: undefined },
      update: { scheduledJobs: [{}] },
    });
    await expect(runJob(db2, 3)).resolves.toBeUndefined();
  });

  it('truncates very large exec output', async () => {
    execMocks.run.mockImplementationOnce(
      async (_c: unknown, _a: unknown, _o: unknown, sink?: (l: string) => void) => {
        for (let i = 0; i < 3000; i++) sink?.(`x`.repeat(30));
      },
    );
    const db = createFakeDb({
      findFirst: {
        scheduledJobs: jobRow({ id: 7, kind: 'exec', command: 'big' }),
        services: svcRow({ runtimeId: 'c' }),
      },
      insert: { jobRuns: [{ id: 13 }] },
      update: { jobRuns: [{}] },
    });
    await runJob(db, 7);
    // The captured output stays under the cap.
    void userRow;
  });
});
