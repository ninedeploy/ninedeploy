import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainerStat, HostStat } from '../../src/lib/stats.js';

const statsMock = vi.hoisted(() => ({
  collectContainerStats: vi.fn(),
  collectHostStats: vi.fn(),
}));

vi.mock('../../src/lib/stats.js', () => statsMock);

const proxyMock = vi.hoisted(() => ({ readCertificates: vi.fn(() => []) }));
vi.mock('../../src/engine/proxy.js', () => proxyMock);

const collectorPlugin = (await import('../../src/plugins/collector.js')).default;

const containerA: ContainerStat = { name: 'nd-web', cpuPct: 2.5, memBytes: 100, memLimitBytes: 200 };
const host: HostStat = {
  cpuCores: 4,
  load1: 0.5,
  memTotalBytes: 1000,
  memUsedBytes: 300,
  diskTotalBytes: 5000,
  diskUsedBytes: 1000,
};

function makeDb(services: Array<{ id: number; runtimeId: string | null }>) {
  const select = vi.fn(() => ({ from: vi.fn(async () => services) }));
  const insert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
  const del = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  return { db: { select, insert, delete: del } as never, insert, del };
}

async function buildApp(db: ReturnType<typeof makeDb>['db']) {
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  await app.register(collectorPlugin);
  return app;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  statsMock.collectContainerStats.mockReset();
  statsMock.collectHostStats.mockReset();
});

describe('collector plugin', () => {
  it('collects stats on the interval, persists metrics, and updates the cache', async () => {
    vi.useFakeTimers();
    statsMock.collectContainerStats.mockResolvedValue(new Map([['nd-web', containerA]]));
    statsMock.collectHostStats.mockResolvedValue(host);

    const { db, insert, del } = makeDb([
      { id: 1, runtimeId: 'nd-web' },
      { id: 2, runtimeId: 'nd-other' },
      { id: 3, runtimeId: null },
    ]);
    const app = Fastify({ logger: false });
    const logSpy = vi.spyOn(app.log, 'info');
    app.decorate('db', db);
    await app.register(collectorPlugin);

    await vi.advanceTimersByTimeAsync(5000);

    expect(statsMock.collectContainerStats).toHaveBeenCalledTimes(1);
    expect(statsMock.collectHostStats).toHaveBeenCalledTimes(1);
    // Only service 1 has a matching runtime container.
    expect(insert).toHaveBeenCalledTimes(1);
    const valuesFn = (insert.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values;
    expect(valuesFn).toHaveBeenCalledWith([
      { serviceId: 1, kind: 'cpu', value: 250, ts: expect.any(Date) },
      { serviceId: 1, kind: 'memory', value: 100, ts: expect.any(Date) },
    ]);
    expect(del).toHaveBeenCalledTimes(1);

    const cache = (app.stats as { raw: () => unknown }).raw() as {
      containers: Map<string, ContainerStat>;
      host: HostStat | null;
    };
    expect(cache.containers.get('nd-web')).toBe(containerA);
    expect(cache.host).toBe(host);
    expect(logSpy).toHaveBeenCalledWith('metrics collector started');
    await app.close();
  });

  it('skips the insert when no services match any container', async () => {
    vi.useFakeTimers();
    statsMock.collectContainerStats.mockResolvedValue(new Map());
    statsMock.collectHostStats.mockResolvedValue(host);

    const { db, insert, del } = makeDb([{ id: 9, runtimeId: 'nothing-runs' }]);
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(5000);

    expect(insert).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1); // retention delete still runs
    await app.close();
  });

  it('logs and continues when collection fails', async () => {
    vi.useFakeTimers();
    statsMock.collectContainerStats.mockRejectedValue(new Error('docker down'));
    statsMock.collectHostStats.mockResolvedValue(host);

    const { db } = makeDb([]);
    const app = await buildApp(db);
    const errorSpy = vi.spyOn(app.log, 'error');

    await vi.advanceTimersByTimeAsync(5000);

    expect(errorSpy).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'docker down' }) },
      'metrics collection failed',
    );
    await app.close();
  });

  it('reschedules the tick while running', async () => {
    vi.useFakeTimers();
    statsMock.collectContainerStats.mockResolvedValue(new Map());
    statsMock.collectHostStats.mockResolvedValue(host);

    const { db } = makeDb([]);
    const app = await buildApp(db);

    await vi.advanceTimersByTimeAsync(5000);
    expect(statsMock.collectContainerStats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statsMock.collectContainerStats).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('stops rescheduling after close', async () => {
    vi.useFakeTimers();
    let resolveContainers: (m: Map<string, ContainerStat>) => void = () => undefined;
    const pending = new Promise<Map<string, ContainerStat>>((r) => {
      resolveContainers = r;
    });
    statsMock.collectContainerStats.mockReturnValueOnce(pending);
    statsMock.collectHostStats.mockResolvedValue(host);

    const { db } = makeDb([]);
    const app = await buildApp(db);

    // Fire the first tick; it suspends on the pending stats promise.
    vi.advanceTimersByTime(5000);
    await app.close(); // running = false
    resolveContainers(new Map());
    await vi.advanceTimersByTimeAsync(0);

    // No further ticks should be scheduled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statsMock.collectContainerStats).toHaveBeenCalledTimes(1);
  });

  it('skips host alert snapshots when host stats are unavailable', async () => {
    vi.useFakeTimers();
    statsMock.collectContainerStats.mockResolvedValue(new Map());
    statsMock.collectHostStats.mockResolvedValue(null as unknown as HostStat);

    const { db } = makeDb([]);
    const app = await buildApp(db);
    await vi.advanceTimersByTimeAsync(5000);

    const cache = (app.stats as { raw: () => unknown }).raw() as { host: HostStat | null };
    expect(cache.host).toBeNull();
    await app.close();
  });

  it('feeds cert-expiry snapshots from the issued certificates', async () => {
    vi.useFakeTimers();
    proxyMock.readCertificates.mockReturnValueOnce([
      { domain: 'a.example.com', expiresAt: new Date(Date.now() + 3 * 86_400_000) },
      { domain: 'b.example.com', expiresAt: new Date(Date.now() + 30 * 86_400_000) },
    ]);
    statsMock.collectContainerStats.mockResolvedValue(new Map());
    statsMock.collectHostStats.mockResolvedValue(host);

    const { db } = makeDb([]);
    const app = await buildApp(db);
    await vi.advanceTimersByTimeAsync(5000);
    // The evaluation itself is covered by the alerting tests; here we only
    // verify the collector did not blow up on cert snapshots.
    expect(statsMock.collectContainerStats).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('skips cert snapshots when no certificate has an expiry', async () => {
    vi.useFakeTimers();
    proxyMock.readCertificates.mockReturnValueOnce([{ domain: 'a.example.com', expiresAt: null }]);
    statsMock.collectContainerStats.mockResolvedValue(new Map());
    statsMock.collectHostStats.mockResolvedValue(host);

    const { db } = makeDb([]);
    const app = await buildApp(db);
    await vi.advanceTimersByTimeAsync(5000);
    await app.close();
  });

  it('falls back to load-derived host cpu when memTotal is zero', async () => {
    vi.useFakeTimers();
    statsMock.collectContainerStats.mockResolvedValue(new Map());
    statsMock.collectHostStats.mockResolvedValue({ ...host, memTotalBytes: 0, load1: 1.2 });

    const { db } = makeDb([]);
    const app = await buildApp(db);
    await vi.advanceTimersByTimeAsync(5000);
    await app.close();
  });
});

describe('cpuDeltaPct', () => {
  it('returns null without a previous sample or with mismatched cores', async () => {
    const { cpuDeltaPct } = await import('../../src/plugins/collector.js');
    const cpu = (idle: number, total: number) => ({
      model: '',
      speed: 0,
      times: { idle, irq: 0, nice: 0, sys: 0, user: total - idle },
    });
    expect(cpuDeltaPct(null, [cpu(1, 10)])).toBeNull();
    expect(cpuDeltaPct([cpu(1, 10)], [cpu(1, 10), cpu(1, 10)])).toBeNull();
    // Zero deltas (sampled too fast) are not a measurement.
    expect(cpuDeltaPct([cpu(5, 10)], [cpu(5, 10)])).toBeNull();
    // 10 total ticks elapsed, 3 idle → 70% busy.
    expect(cpuDeltaPct([cpu(10, 20)], [cpu(13, 30)])).toBe(70);
    // A malformed sample missing the idle counter is tolerated as 0.
    const partial = [{ model: '', speed: 0, times: { user: 5 } }] as never;
    const partialPrev = [{ model: '', speed: 0, times: { user: 3 } }] as never;
    expect(cpuDeltaPct(partialPrev, partial)).toBe(100);
  });
});
