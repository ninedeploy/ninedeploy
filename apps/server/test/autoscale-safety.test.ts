import Fastify from 'fastify';
import { setImmediate } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployments, primaryTransitions, services, eq } from '@ninedeploy/db';
import { autoscaleConfig } from '@ninedeploy/schemas';
import { observabilityDb } from './fixtures/observability.js';
import { autoscaleStep, autoscaleStatus, measure, resetAutoscaleState, scaleService, type AutoscaleDeps } from '../src/lib/autoscaler.js';

const boundary = vi.hoisted(() => ({ run: vi.fn(async (..._args: unknown[]) => undefined), probe: vi.fn(async (..._args: unknown[]) => true), route: vi.fn(async (..._args: unknown[]) => undefined), audit: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../src/lib/exec.js', () => ({ run: boundary.run, sleep: async () => undefined }));
vi.mock('../src/engine/builders/docker.js', () => ({ dockerBuilder: { isHealthy: boundary.probe } }));
vi.mock('../src/engine/proxy.js', () => ({ writeDynamicConfig: boundary.route }));
vi.mock('../src/lib/audit.js', () => ({ audit: boundary.audit }));
vi.mock('../src/lib/trafficAnalytics.js', () => ({ trafficAnalyticsEnabled: async () => false }));
const { default: autoscalerPlugin } = await import('../src/plugins/autoscaler.js');

const fixtures: Awaited<ReturnType<typeof observabilityDb>>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  resetAutoscaleState(); vi.useRealTimers(); vi.clearAllMocks();
  boundary.probe.mockResolvedValue(true); boundary.route.mockResolvedValue(undefined);
});
const cfg = autoscaleConfig.parse({ minReplicas: 1, maxReplicas: 4, target: 50, scaleUpSeconds: 60, scaleDownSeconds: 300 });
const stat = (name: string, cpuPct = 90, memLimitBytes = 1000) => ({ name, cpuPct, memBytes: 100, memLimitBytes });
const samples = () => new Map([['web-7', stat('web-7')], ['web-7-r2', stat('web-7-r2')]]);
const context = (now: number, containers = samples()) => ({ now, containers, analyticsOn: false, inFlight: new Set<number>(), canaryRunning: false });
async function fixture() {
  const f = await observabilityDb(); fixtures.push(f);
  await f.db.update(services).set({ autoscale: cfg, runtimeReplicas: 2, port: 3000 }).where(eq(services.id, 1));
  const row = async () => (await f.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
  const deps: AutoscaleDeps = { db: f.db, docker: vi.fn(async () => undefined), probe: vi.fn(async () => true), writeConfig: vi.fn(async () => undefined), audit: vi.fn(async () => undefined), sleep: async () => undefined, log: vi.fn() };
  return { ...f, row, deps };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('autoscale safety boundaries', () => {
  it('does not scale a service whose terminal deploy still has a retained primary transition', async () => {
    const f = await fixture();
    await f.db.insert(primaryTransitions).values({ serviceId: 1, deploymentId: 9, candidate: { runtimeId: 'web-9', port: 3000, healthPath: '/', healthCheck: null, replicas: 1, commitSha: null, containers: [] } });
    expect(await scaleService(f.deps, await f.row(), 2, 3, 'test', 0)).toBe(2);
    expect(f.deps.docker).not.toHaveBeenCalled(); expect((await f.row()).runtimeReplicas).toBe(2);
  });
  it('does not treat an incomplete serving-replica sample as the service load', async () => {
    const f = await fixture(), svc = await f.row();
    expect(measure(svc, cfg, samples(), { analyticsOn: false, now: 0 }).value).toBe(90);
    expect(measure(svc, cfg, new Map([['web-7', stat('web-7', 1)]]), { analyticsOn: false, now: 0 }).value).toBeNull();
    expect(measure(svc, { ...cfg, metric: 'memory' }, new Map([['web-7', stat('web-7')], ['web-7-r2', stat('web-7-r2', 0, 0)]]), { analyticsOn: false, now: 0 }).value).toBeNull();
  });

  it.each([null, -90_001, 1, Number.NaN])('holds CPU scaling for an unknown, stale or future sample timestamp: %s', async (sampledAt) => {
    const f = await fixture();
    expect(measure(await f.row(), cfg, samples(), { analyticsOn: false, now: 0, sampledAt }))
      .toEqual({ value: null, holding: 'waiting for fresh container stats' });
    expect(measure(await f.row(), cfg, samples(), { analyticsOn: false, now: 0, sampledAt: -90_000 }).value).toBe(90);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('does not use invalid CPU measurements: %s', async (cpuPct) => {
    const f = await fixture(), containers = samples();
    containers.set('web-7', stat('web-7', cpuPct));
    expect(measure(await f.row(), cfg, containers, { analyticsOn: false, now: 0 }).value).toBeNull();
  });

  it('requires a new continuous load window after an unreadable sample', async () => {
    const f = await fixture();
    await autoscaleStep(f.deps, await f.row(), cfg, context(0));
    await autoscaleStep(f.deps, await f.row(), cfg, context(30_000, new Map()));
    await autoscaleStep(f.deps, await f.row(), cfg, context(60_000));
    expect(f.deps.docker).not.toHaveBeenCalled();
    await autoscaleStep(f.deps, await f.row(), cfg, context(90_000));
    await autoscaleStep(f.deps, await f.row(), cfg, context(120_000));
    expect((await f.row()).runtimeReplicas).toBe(4);
  });

  it('restores the serving count and keeps containers running when routing cannot be acknowledged', async () => {
    const f = await fixture();
    f.deps.writeConfig = vi.fn(async () => { throw new Error('route unavailable'); });
    await expect(scaleService(f.deps, await f.row(), 2, 1, 'idle', 0)).rejects.toThrow('route unavailable');
    expect((await f.row()).runtimeReplicas).toBe(2);
    expect(f.deps.docker).not.toHaveBeenCalled();
    expect(f.deps.audit).not.toHaveBeenCalled();
    await autoscaleStep(f.deps, await f.row(), cfg, context(30_000));
    expect(f.deps.docker).not.toHaveBeenCalled();
    expect(autoscaleStatus(await f.row()).holding).toMatch(/routing/i);
  });

  it('does not publish a scale-up if a deployment starts while its readiness probe is pending', async () => {
    const f = await fixture(), gate = deferred<boolean>(), entered = deferred<void>();
    f.deps.probe = async () => { entered.resolve(); return gate.promise; };
    const scaling = scaleService(f.deps, await f.row(), 2, 3, 'busy', 0);
    await entered.promise;
    await f.db.insert(deployments).values({ serviceId: 1, status: 'deploying' });
    gate.resolve(true); await scaling;
    expect((await f.row()).runtimeReplicas).toBe(2);
    expect(f.deps.writeConfig).not.toHaveBeenCalled();
    expect(f.deps.audit).not.toHaveBeenCalled();
  });

  it.each(['configuration', 'runtime', 'controller generation'] as const)('does not publish a scale-up after its %s changes during readiness', async (change) => {
    const f = await fixture(), gate = deferred<boolean>(), entered = deferred<void>();
    f.deps.probe = async () => { entered.resolve(); return gate.promise; };
    const scaling = scaleService(f.deps, await f.row(), 2, 3, 'busy', 0);
    await entered.promise;
    if (change === 'configuration') await f.db.update(services).set({ autoscale: { ...cfg, maxReplicas: 3 } });
    else if (change === 'runtime') await f.db.update(services).set({ runtimeId: 'replacement-8' });
    else resetAutoscaleState(1);
    gate.resolve(true); await scaling;
    expect((await f.row()).runtimeReplicas).toBe(2);
    expect(f.deps.writeConfig).not.toHaveBeenCalled();
    expect(f.deps.audit).not.toHaveBeenCalled();
  });

  it('reconfirms routing before stopping a spare left by a failed scale-up', async () => {
    const f = await fixture();
    f.deps.writeConfig = vi.fn().mockRejectedValueOnce(new Error('route unavailable')).mockResolvedValue(undefined);
    await expect(scaleService(f.deps, await f.row(), 2, 3, 'busy', 0)).rejects.toThrow('route unavailable');
    expect((await f.row()).runtimeReplicas).toBe(2);
    expect(f.deps.docker).toHaveBeenCalledExactlyOnceWith(['start', 'web-7-r3']);
    const order: string[] = [];
    f.deps.writeConfig = async () => { order.push('route'); };
    f.deps.sleep = async () => { order.push('drain'); };
    f.deps.docker = async () => { order.push('stop'); };
    const containers = samples(); containers.set('web-7-r3', stat('web-7-r3'));
    await autoscaleStep(f.deps, await f.row(), cfg, context(30_000, containers));
    expect(order).toEqual(['route', 'drain', 'stop']);
    expect(f.deps.audit).not.toHaveBeenCalled();
  });

  it('drains a pending scale operation on shutdown and prevents publication after close begins', async () => {
    const f = await fixture(), gate = deferred<boolean>();
    await f.db.update(services).set({ autoscale: { ...cfg, minReplicas: 3 } });
    boundary.probe.mockImplementation(async () => gate.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const app = Fastify(); app.decorate('db', f.db);
    app.decorate('stats', { raw: () => ({ containers: samples(), host: null, sampledAt: Date.now() }) });
    await app.register(autoscalerPlugin); await app.ready();
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.waitFor(() => expect(boundary.probe).toHaveBeenCalled());
    boundary.route.mockClear();
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally { gate.resolve(true); await closing; }
    expect((await f.row()).runtimeReplicas).toBe(2);
    expect(boundary.route).not.toHaveBeenCalled();
    expect(boundary.audit).not.toHaveBeenCalled();
  });
});
