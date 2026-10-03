import Fastify from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
    releaseGate!(); // armJobs settles → scheduleReload sees stopped → returns
    await vi.advanceTimersByTimeAsync(0); // flush the gated reload

    // The in-flight reload may finish arming (2nd Cron), but nothing further:
    const armed = CronMock.Cron.mock.calls.length;
    const queried = calls;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(CronMock.Cron.mock.calls.length).toBe(armed);
    expect(calls).toBe(queried);
    vi.useRealTimers();
  });
});
