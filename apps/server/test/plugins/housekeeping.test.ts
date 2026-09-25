import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const logsMock = vi.hoisted(() => ({ pruneOldLogs: vi.fn(() => 0), deleteLog: vi.fn(() => true) }));
const execMock = vi.hoisted(() => ({
  run: vi.fn(async (_c: string, _a: unknown[], _o: unknown, sink?: (l: string) => void) => {
    sink?.('');
  }),
}));
const autoPruneMock = vi.hoisted(() => ({
  getAutoPruneStatus: vi.fn(async () => ({
    enabled: true,
    thresholdPercent: 85,
    diskUsedPercent: 90,
  })),
  executeAutoPrune: vi.fn(async () => ({ ok: true, freedBytes: 100 })),
}));

vi.mock('../../src/engine/logs.js', () => ({
  logBus: new (class extends EventTarget {})(),
  pruneOldLogs: logsMock.pruneOldLogs,
  deleteLog: logsMock.deleteLog,
}));
vi.mock('../../src/lib/exec.js', () => ({ run: execMock.run }));
const drillMock = vi.hoisted(() => ({ pruneDrillLeftovers: vi.fn(async () => 0) }));
vi.mock('../../src/lib/backupDrill.js', () => drillMock);
vi.mock('../../src/engine/autoPrune.js', () => ({
  getAutoPruneStatus: autoPruneMock.getAutoPruneStatus,
  executeAutoPrune: autoPruneMock.executeAutoPrune,
}));

const housekeepingPlugin = (await import('../../src/plugins/housekeeping.js')).default;

/**
 * `expiredDeployments` are the rows the deployment sweep is meant to find; the
 * plugin reads their ids first so it can delete each one's log file alongside
 * the row.
 */
function makeDb(expiredDeployments: Array<{ id: number }> = []) {
  const deleted: Array<{ table: unknown }> = [];
  const del = vi.fn((table: unknown) => {
    deleted.push({ table });
    return { where: vi.fn(async () => undefined) };
  });
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(async () => expiredDeployments) })),
  }));
  return { db: { delete: del, select } as never, deleted };
}

async function buildApp(db: ReturnType<typeof makeDb>['db'], kernel?: unknown) {
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  if (kernel) app.decorate('kernel', kernel as never);
  await app.register(housekeepingPlugin);
  return app;
}

describe('housekeeping plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logsMock.pruneOldLogs.mockClear();
    logsMock.deleteLog.mockClear();
    autoPruneMock.executeAutoPrune.mockClear();
    autoPruneMock.getAutoPruneStatus.mockResolvedValue({
      enabled: true,
      thresholdPercent: 85,
      diskUsedPercent: 90,
    } as never);
  });
  afterEach(async () => {
    vi.useRealTimers();
  });

  it('prunes old logs and deletes stale audit/notification rows on each tick', async () => {
    const { db, deleted } = makeDb();
    const app = await buildApp(db);

    // The first tick fires ~60s after boot.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(logsMock.pruneOldLogs).toHaveBeenCalledTimes(1);
    const tables = deleted.map((d) => d.table);
    expect(tables).toContain(auditLog);
    expect(tables).toContain(notificationLog);
    // `job_runs` had no retention at all, and each row carries up to 60 KB of
    // captured command output inside the SQLite file that gets backed up whole.
    expect(tables).toContain(jobRuns);
    // Dangling Docker images are pruned each tick too.
    expect(execMock.run).toHaveBeenCalledWith('docker', ['image', 'prune', '-f'], {}, expect.any(Function));
    // `sessions` had no retention either: one row per login, forever, each
    // carrying an IP + User-Agent. The panel filters dead rows out of its
    // RESPONSE, so the growth was invisible while the file kept growing.
    expect(tables).toContain(sessions);
    // Auto-prune was triggered because 90% >= 85%
    expect(autoPruneMock.executeAutoPrune).toHaveBeenCalledTimes(1);
    await app.close();
  });

  /**
   * r302: these tables had no retention at all, and the drill's plaintext
   * scratch files survived any drill whose process died before cleanup. The
   * sweeps themselves are exercised against real SQLite in
   * housekeepingRetention.test.ts; this asserts the tick actually runs them.
   */
  it('sweeps drills, invitations, domain transfers, cold cache rows and drill leftovers each tick (r302)', async () => {
    const { db, deleted } = makeDb();
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(60_000);

    const tables = deleted.map((d) => d.table);
    for (const t of [backupDrills, workspaceInvitations, domainTransfers, cacheRegistryBlobs]) expect(tables).toContain(t);
    expect(drillMock.pruneDrillLeftovers).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('backups')]),
      expect.any(Number),
    );
    await app.close();
  });

  it('exempts the log files of non-terminal deployments from the mtime sweep (r302)', async () => {
    // The fake select answers every query with these rows — here, the live ids.
    const { db } = makeDb([{ id: 5 }]);
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(logsMock.pruneOldLogs).toHaveBeenCalledWith(expect.any(Number), new Set([5]));
    await app.close();
  });

  /**
   * `plugin:metric-history:retention_days` documents itself as swept by "a
   * /v1/housekeeping pass", but nothing outside the manual
   * `POST /v1/metric-history/flush` route ever called `runRetention` — an
   * operator who lowered the window saw no effect until they clicked.
   */
  it('runs the metric-history retention sweep each tick', async () => {
    const runRetention = vi.fn(async () => 3);
    const kernel = { getPlugin: vi.fn(() => ({ runRetention })) };
    const { db } = makeDb();
    const app = await buildApp(db, kernel);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(kernel.getPlugin).toHaveBeenCalledWith('metric-history');
    expect(runRetention).toHaveBeenCalledWith(kernel);
    await app.close();
  });

  it('skips the metric-history sweep when the plugin is absent', async () => {
    const kernel = { getPlugin: vi.fn(() => undefined) };
    const { db } = makeDb();
    const app = await buildApp(db, kernel);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(kernel.getPlugin).toHaveBeenCalledWith('metric-history');
    // The rest of the tick still ran.
    expect(execMock.run).toHaveBeenCalledWith('docker', ['image', 'prune', '-f'], {}, expect.any(Function));
    await app.close();
  });

  it('keeps sweeping when the metric-history backend throws', async () => {
    const runRetention = vi.fn(async () => {
      throw new Error('backend down');
    });
    const kernel = { getPlugin: vi.fn(() => ({ runRetention })) };
    const { db } = makeDb();
    const app = await buildApp(db, kernel);

    await vi.advanceTimersByTimeAsync(60_000);

    // The failure is contained: the Docker prune later in the same tick ran.
    expect(execMock.run).toHaveBeenCalledWith('docker', ['image', 'prune', '-f'], {}, expect.any(Function));
    await app.close();
  });

  /**
   * Deployment ROWS were never swept. Only the log FILE aged out (30 days), so
   * the older half of every service's Deploys tab listed builds whose logs had
   * already been deleted — history you can click and learn nothing from — while
   * the table itself grew for the life of the instance.
   */
  it('sweeps finished deployment rows and their log files', async () => {
    const { db, deleted } = makeDb([{ id: 11 }, { id: 12 }]);
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deleted.map((d) => d.table)).toContain(deployments);
    // The row and its log go together — the file sweep judges mtime only, so a
    // deploy that produced no output recently would otherwise leave one behind.
    expect(logsMock.deleteLog).toHaveBeenCalledWith(11);
    expect(logsMock.deleteLog).toHaveBeenCalledWith(12);
    await app.close();
  });

  it('issues no deployment delete when nothing has aged out', async () => {
    const { db, deleted } = makeDb([]);
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deleted.map((d) => d.table)).not.toContain(deployments);
    expect(logsMock.deleteLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('skips auto-prune when disk percent is below threshold', async () => {
    autoPruneMock.getAutoPruneStatus.mockResolvedValueOnce({
      enabled: true,
      thresholdPercent: 85,
      diskUsedPercent: 40,
    } as never);
    const { db } = makeDb();
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(autoPruneMock.executeAutoPrune).not.toHaveBeenCalled();
    await app.close();
  });

  it('logs and continues when a retention delete fails', async () => {
    const del = vi.fn(() => ({ where: vi.fn(async () => Promise.reject(new Error('db locked'))) }));
    const app = await buildApp({ delete: del, select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })) } as never);
    const errorSpy = vi.spyOn(app.log, 'error');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(errorSpy).toHaveBeenCalledWith({ err: expect.objectContaining({ message: 'db locked' }) }, 'housekeeping failed');
    // Still reschedules the next tick.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(logsMock.pruneOldLogs).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('stops scheduling after close', async () => {
    const { db } = makeDb();
    const app = await buildApp(db);
    await vi.advanceTimersByTimeAsync(60_000);
    await app.close();

    const callsBefore = logsMock.pruneOldLogs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 * 24);
    expect(logsMock.pruneOldLogs.mock.calls.length).toBe(callsBefore);
  });

  it('does not reschedule when close lands while a tick is still in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const del = vi.fn(() => ({ where: vi.fn(() => gate) }));
    const app = await buildApp({ delete: del, select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })) } as never);

    // Start the first tick; it hangs on the db delete.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logsMock.pruneOldLogs).toHaveBeenCalledTimes(1);

    // Close while the tick is in flight: running flips to false before the
    // finally block runs, so the next tick must not be scheduled.
    await app.close();
    release();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(logsMock.pruneOldLogs).toHaveBeenCalledTimes(1);
  });

  it('absorbs a failing docker image prune without breaking the tick', async () => {
    execMock.run.mockRejectedValueOnce(new Error('docker unavailable'));
    const { db } = makeDb();
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(60_000);

    // The prune rejection is caught (fire-and-forget); the rest of the tick still ran.
    expect(logsMock.pruneOldLogs).toHaveBeenCalledTimes(1);
    expect(execMock.run).toHaveBeenCalledWith('docker', ['image', 'prune', '-f'], {}, expect.any(Function));
    await app.close();
  });
});
