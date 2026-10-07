import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const runnerMock = vi.hoisted(() => ({ runJob: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/jobRunner.js', () => runnerMock);

const CronMock = vi.hoisted(() => {
  // Minimal croner stand-in: records expressions, fires immediately.
  const instances: Array<{ stop: () => void; expr: string }> = [];
  const Ctor = vi.fn(function (this: { stop: () => void; expr: string }, expr: string, _opts: unknown, fn: () => void) {
    this.expr = expr;
    this.stop = vi.fn();
    instances.push(this as never);
    queueMicrotask(fn);
  });
  return { Cron: Ctor, instances };
});
vi.mock('croner', () => ({ Cron: CronMock.Cron }));

const jobSchedulerPlugin = (await import('../../src/plugins/jobScheduler.js')).default;

function makeDb(jobs: Array<Record<string, unknown>>) {
  return {
    query: { scheduledJobs: { findMany: vi.fn(async () => jobs) } },
  } as never;
}

describe('job scheduler plugin', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    CronMock.instances.length = 0;
  });

  it('arms a cron per enabled job and fires it', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', makeDb([
      { id: 1, cron: '0 3 * * *', enabled: true },
      { id: 2, cron: '* * * * *', enabled: false }, // disabled → not armed
    ]));
    await app.register(jobSchedulerPlugin);
    // Both jobs are queried; only the enabled one gets a cron.
    await new Promise((r) => setTimeout(r, 10));
    expect(CronMock.Cron).toHaveBeenCalledTimes(1);
    expect(CronMock.Cron).toHaveBeenCalledWith('0 3 * * *', expect.anything(), expect.any(Function));
    // The scheduled callback runs the job — flagged as scheduled, so runJob
    // re-checks `enabled` on the live row (r303).
    expect(runnerMock.runJob).toHaveBeenCalledWith(expect.anything(), 1, { scheduled: true });
    await app.close();
  });

  it('skips invalid cron expressions without breaking the plugin', async () => {
    // biome-ignore lint/complexity/useArrowFunction: the plugin constructs Cron with `new`, so the mock implementation must be a constructable function, not an arrow.
    CronMock.Cron.mockImplementationOnce(function () {
      throw new Error('invalid pattern');
    });
    const app = Fastify({ logger: false });
    app.decorate('db', makeDb([{ id: 3, cron: 'nonsense', enabled: true }]));
    await app.register(jobSchedulerPlugin);
    expect(CronMock.Cron).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('stops all crons and timers on close', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', makeDb([{ id: 1, cron: '* * * * *', enabled: true }]));
    await app.register(jobSchedulerPlugin);
    await app.close();
    const inst = CronMock.instances[0] as unknown as { stop: ReturnType<typeof vi.fn> };
    expect(inst.stop).toHaveBeenCalled();
  });

  it('survives a failing job query (pre-migration table)', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', {
      query: { scheduledJobs: { findMany: vi.fn(async () => { throw new Error('no table'); }) } },
    } as never);
    await app.register(jobSchedulerPlugin);
    await app.close();
  });

  it('fires jobs on their cron callback and reports failures to the log', async () => {
    runnerMock.runJob.mockRejectedValueOnce(new Error('job boom'));
    const app = Fastify({ logger: false });
    app.decorate('db', makeDb([{ id: 5, cron: '* * * * *', enabled: true }]));
    await app.register(jobSchedulerPlugin);
    await new Promise((r) => setTimeout(r, 10));
    // The rejection was swallowed (logged), not thrown.
    expect(runnerMock.runJob).toHaveBeenCalled();
    await app.close();
  });

  it('stops the reload loop when the app closes mid-reload', async () => {
    vi.useFakeTimers();
    const app = Fastify({ logger: false });
    // The 2nd findMany (first reload) blocks until we release it, so close()
    // lands while armJobs is still pending — the follow-up scheduleReload must
    // observe `stopped` and arm nothing.
    let releaseGate: ((v: undefined) => void) | null = null;
    let calls = 0;
    const findMany = vi.fn(async () => {
      calls += 1;
      if (calls === 2) await new Promise<void>((r) => { releaseGate = r; });
      return [{ id: 1, cron: '* * * * *', enabled: true }];
    });
    app.decorate('db', { query: { scheduledJobs: { findMany } } } as never);
    await app.register(jobSchedulerPlugin);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // reload starts, gated
    expect(releaseGate).toBeTruthy();
    await app.close(); // stopped = true while the reload query pends
    runnerMock.runJob.mockClear();
    releaseGate!(); // armJobs settles → scheduleReload sees stopped → returns
    await vi.advanceTimersByTimeAsync(0); // flush the gated reload

    // The pending query must not install a new cron or run a job after close.
    expect(CronMock.Cron).toHaveBeenCalledTimes(1);
    expect(runnerMock.runJob).not.toHaveBeenCalled();
    const queried = calls;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(CronMock.Cron).toHaveBeenCalledTimes(1);
    expect(runnerMock.runJob).not.toHaveBeenCalled();
    expect(calls).toBe(queried);
  });
});

// F102: the API takes 5-field crons only since F240, but rows saved before it
// were armed in croner's default 'auto' mode — a stored `* * * * * *` carried
// a seconds field and ran its job every second. Real croner, fake clock.
describe('job scheduler — stored seconds-field crons (F102)', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    CronMock.instances.length = 0;
  });

  it('skips a legacy 6-field cron instead of firing it every second', async () => {
    const { Cron: RealCron } = await vi.importActual<typeof import('croner')>('croner');
    const real: Array<{ stop(): void }> = [];
    // biome-ignore lint/complexity/useArrowFunction: constructed with `new`.
    CronMock.Cron.mockImplementation(function (expr: string, opts: unknown, fn: () => void) {
      const c = new RealCron(expr, opts as never, fn);
      real.push(c);
      return c as never;
    });
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:30.000Z') });
    const app = Fastify({ logger: false });
    const warn = vi.spyOn(app.log, 'warn');
    app.decorate(
      'db',
      makeDb([
        { id: 1, cron: '* * * * *', enabled: true },
        { id: 2, cron: '* * * * * *', enabled: true },
      ]),
    );
    try {
      await app.register(jobSchedulerPlugin);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      await app.close();
      for (const c of real) c.stop();
      CronMock.Cron.mockReset();
    }

    const runsOf = (id: number) => runnerMock.runJob.mock.calls.filter((c) => (c as unknown[])[1] === id).length;
    expect(runsOf(1)).toBe(1);
    expect(runsOf(2)).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ jobId: 2 }), expect.stringContaining('invalid cron'));
  });
});
