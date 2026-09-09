import { beforeEach, describe, expect, it, vi } from 'vitest';

const execMocks = vi.hoisted(() => ({ run: vi.fn() }));
const mocks = vi.hoisted(() => ({
  backupServiceVolumes: vi.fn(),
  audit: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/exec.js', () => ({ run: execMocks.run }));
vi.mock('../../src/lib/audit.js', () => ({ audit: mocks.audit }));
// The deploy/backup branches pull heavy modules the exec path never touches.
vi.mock('../../src/lib/hostPrivilege.js', () => ({ assertMayDeployStoredService: vi.fn() }));
vi.mock('../../src/lib/resourceAccess.js', () => ({ isOperator: vi.fn(async () => false) }));
vi.mock('../../src/modules/volumeBackups.js', () => ({ backupServiceVolumes: mocks.backupServiceVolumes }));

import { runJob } from '../../src/lib/jobRunner.js';

const JOB = { id: 7, serviceId: 5, kind: 'exec', command: 'echo hi', name: 'nightly echo' };
const SVC = { id: 5, name: 'web', runtimeId: 'nd-app-web' };

/** Minimal db stub: scheduledJobs/services lookups + jobRuns insert/update
 *  recording, which is the entire surface the exec path touches. */
function makeDb(opts: { job?: Record<string, unknown> | null; svc?: Record<string, unknown> | null } = {}) {
  const jobRunUpdates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const db = {
    query: {
      scheduledJobs: { findFirst: vi.fn(async () => ('job' in opts ? opts.job : JOB)) },
      services: { findFirst: vi.fn(async () => ('svc' in opts ? opts.svc : SVC)) },
    },
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          jobRunUpdates.push({ values });
          return [];
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserts.push(values);
          return [{ id: 1, ...values }];
        },
      }),
    })),
  };
  return { db, jobRunUpdates, inserts };
}

/** Minimal fake for the shapes runJobInner touches on the backup path:
 *  the same lookups plus the `update(...).set(...).where(...)` chain.
 *  The audit + backup collaborators are module-mocked above. */
function fakeDb(job: Record<string, unknown> | undefined, svc: Record<string, unknown> | undefined) {
  return {
    query: {
      scheduledJobs: { findFirst: vi.fn(async () => job) },
      services: { findFirst: vi.fn(async () => svc) },
    },
    update: vi.fn(() => {
      const chain: Record<string, unknown> = {
        set: vi.fn(() => chain),
        where: vi.fn(async () => undefined),
      };
      return chain;
    }),
  } as never;
}

describe('runJob — exec jobs', () => {
  beforeEach(() => {
    execMocks.run.mockReset();
    mocks.audit.mockReset();
  });

  it('runs the command inside the runtime container and records success', async () => {
    execMocks.run.mockImplementation(async (_cmd, _args, _opts, sink) => {
      (sink as (line: string) => void)('hello');
      (sink as (line: string) => void)('world');
    });
    const { db, jobRunUpdates } = makeDb();
    await runJob(db as never, 7);

    // `--` before the container name: a dash-leading runtimeId is an operand.
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker',
      ['exec', '--', 'nd-app-web', 'sh', '-lc', 'echo hi'],
      {},
      expect.any(Function),
    );
    expect(jobRunUpdates.filter((u) => u.values.status !== undefined)).toHaveLength(1);
    expect(jobRunUpdates.find((u) => u.values.status !== undefined).values).toMatchObject({
      status: 'completed',
      exitCode: 0,
      output: 'hello\nworld',
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'job.exec', 'nightly echo');
  });

  it('records a coarse failure when the exec layer throws', async () => {
    execMocks.run.mockRejectedValue(new Error('container gone'));
    const { db, jobRunUpdates } = makeDb();
    await runJob(db as never, 7);
    expect(jobRunUpdates.find((u) => u.values.status !== undefined).values).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'job.exec_failed', 'nightly echo');
  });

  it('skips a second concurrent run of the same job (per-job lock)', async () => {
    // Hold the first execution in-flight: the run mock resolves only when
    // this test releases the deferred.
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    execMocks.run.mockImplementationOnce(() => inFlight.then(() => undefined));

    const db = makeDb().db;
    const first = runJob(db as never, 7);
    const second = runJob(db as never, 7);
    release();
    await Promise.all([first, second]);

    // The second call must return without executing anything.
    expect(execMocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it('returns quietly when the job row is gone', async () => {
    const { db } = makeDb({ job: null });
    await expect(runJob(db as never, 999)).resolves.toBeUndefined();
    expect(execMocks.run).not.toHaveBeenCalled();
  });

  it('returns quietly when the service row is gone', async () => {
    const { db } = makeDb({ job: JOB, svc: null });
    await expect(runJob(db as never, 7)).resolves.toBeUndefined();
  });
});

describe('runJob — backup jobs (r039 coverage)', () => {
  beforeEach(() => {
    mocks.backupServiceVolumes.mockReset();
    mocks.audit.mockReset();
  });

  const job = { id: 5, serviceId: 9, name: 'nightly backup', kind: 'backup' };
  const svc = { id: 9, runtimeId: 'nd-svc-app' };

  it('audits job.backup after a fully successful volume backup', async () => {
    mocks.backupServiceVolumes.mockResolvedValue({ created: 3, failed: 0 });
    await runJob(fakeDb(job, svc) as never, 5);
    expect(mocks.backupServiceVolumes).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      null,
      'job.backup',
      expect.stringContaining('(3 ok, 0 failed)'),
    );
  });

  it('audits job.backup_failed when any volume backup fails', async () => {
    mocks.backupServiceVolumes.mockResolvedValue({ created: 1, failed: 2 });
    await runJob(fakeDb(job, svc) as never, 5);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      null,
      'job.backup_failed',
      expect.stringContaining('(1 ok, 2 failed)'),
    );
  });

  it('records the thrown error message when the backup explodes', async () => {
    mocks.backupServiceVolumes.mockRejectedValue(new Error('disk full'));
    await runJob(fakeDb(job, svc) as never, 5);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      null,
      'job.backup_failed',
      expect.stringContaining('disk full'),
    );
  });

  it('returns silently when an exec job has no runtimeId or command', async () => {
    const db = fakeDb({ id: 6, serviceId: 9, name: 'e', kind: 'exec' }, { id: 9 });
    await expect(runJob(db, 6)).resolves.toBeUndefined();
  });
});
