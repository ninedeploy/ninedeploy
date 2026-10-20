import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, type Service, services, users } from '@ninedeploy/db';
import { autoscaleConfig } from '@ninedeploy/schemas';
import {
  autoscaleOf,
  autoscaleStatus,
  autoscaleStep,
  type AutoscaleDeps,
  decide,
  holdReason,
  measure,
  resetAutoscaleState,
  scaleService,
  servingReplicas,
} from '../../src/lib/autoscaler.js';
import { recordServiceRequest, resetRequestRates, serviceRequestRate } from '../../src/lib/requestRate.js';
import { createAutoscaler } from '../../src/plugins/autoscaler.js';
import type { ContainerStat } from '../../src/lib/stats.js';

/**
 * 0.16.10 autoscaling: measuring, the HPA-style decision with its up and
 * down windows, and scaling by starting and stopping the spare containers a
 * deploy created — against a real migrated SQLite and a fake docker.
 */

let db: DB;
const cfg = autoscaleConfig.parse({ minReplicas: 1, maxReplicas: 4, target: 50, scaleUpSeconds: 60, scaleDownSeconds: 300 });

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
  await db.insert(services).values({
    id: 5,
    name: 'web',
    slug: 'web',
    type: 'docker',
    branch: 'main',
    ownerUserId: 1,
    status: 'running',
    runtimeId: 'web-9',
    runtimeReplicas: 2,
    port: 3000,
    autoscale: cfg,
  } as never);
  resetAutoscaleState();
  resetRequestRates();
});
afterEach(() => vi.useRealTimers());

const row = async (): Promise<Service> => (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 5) }))!;
const stat = (name: string, cpuPct: number, memBytes = 100, memLimitBytes = 1000): ContainerStat => ({ name, cpuPct, memBytes, memLimitBytes });

function fakeDeps(over: Partial<AutoscaleDeps> = {}) {
  const calls: string[][] = [];
  const audits: Array<[string, string, Record<string, unknown>]> = [];
  const lines: string[] = [];
  const deps: AutoscaleDeps = {
    db,
    docker: vi.fn(async (args: string[]) => {
      calls.push(args);
    }),
    probe: vi.fn(async () => true),
    writeConfig: vi.fn(async () => undefined),
    audit: vi.fn(async (a: string, e: string, m: Record<string, unknown>) => {
      audits.push([a, e, m]);
    }),
    sleep: vi.fn(async () => undefined),
    log: (l) => lines.push(l),
    ...over,
  };
  return { deps, calls, audits, lines };
}

describe('measure', () => {
  it('cpu is the average per serving container, in percent of its limit or of one core', async () => {
    const svc = await row();
    const containers = new Map([
      ['web-9', stat('web-9', 80)],
      ['web-9-r2', stat('web-9-r2', 40)],
      ['web-9-r3', stat('web-9-r3', 99)], // spare, not serving
    ]);
    expect(measure(svc, cfg, containers, { analyticsOn: false, now: 0 })).toEqual({ value: 60, holding: null });
    expect(measure({ ...svc, cpuLimitMilli: 500 }, cfg, containers, { analyticsOn: false, now: 0 }).value).toBe(120);
  });

  it('memory is the percent of the limit; a missing limit reads 0', async () => {
    const svc = await row();
    const mem = { ...cfg, metric: 'memory' as const };
    expect(measure(svc, mem, new Map([['web-9', stat('web-9', 0, 300, 1000)], ['web-9-r2', stat('web-9-r2', 0, 100, 0)]]), { analyticsOn: false, now: 0 }).value).toBe(15);
  });

  it('holds without stats, and rps needs traffic analytics', async () => {
    const svc = await row();
    expect(measure(svc, cfg, new Map(), { analyticsOn: true, now: 0 })).toEqual({ value: null, holding: 'no container stats yet' });
    const rps = { ...cfg, metric: 'rps' as const };
    expect(measure(svc, rps, new Map(), { analyticsOn: false, now: 0 }).holding).toMatch(/traffic analytics/);
    for (let i = 0; i < 600; i++) recordServiceRequest(5, 1_000_000 + i * 100);
    // 600 requests in the minute before the 10 s lag, over 2 containers.
    expect(measure(svc, rps, new Map(), { analyticsOn: true, now: 1_070_000 })).toEqual({ value: 5, holding: null });
  });
});

describe('requestRate', () => {
  it('counts per service in ten-second buckets, leaves out the last bucket, and forgets after a day', () => {
    recordServiceRequest(null, 0);
    recordServiceRequest(1, 5_000);
    recordServiceRequest(1, 15_000);
    expect(serviceRequestRate(1, 20_000, 30_000)).toBe(0.1);
    expect(serviceRequestRate(1, 20_000, 30_000, 0)).toBe(0.05);
    expect(serviceRequestRate(2, 20_000, 30_000)).toBe(0);
    expect(serviceRequestRate(1, 1, 25 * 3_600_000)).toBe(0);
    expect(serviceRequestRate(1, 20_000, 30_000)).toBe(0);
  });
});

describe('decide', () => {
  it('scales up once the need has lasted the up window, to the smallest count asked for', () => {
    expect(decide(5, 2, 100, cfg, 0)).toBeNull(); // wants 4
    expect(decide(5, 2, 80, cfg, 30_000)).toBeNull(); // wants 4
    expect(decide(5, 2, 70, cfg, 60_000)).toEqual({ to: 3, reason: 'cpu 70% per container over 60s (target 50%)' });
  });

  it('scales down only after the down window, to the largest count asked for in it', () => {
    expect(decide(5, 4, 10, cfg, 0)).toBeNull(); // wants 1
    expect(decide(5, 4, 30, cfg, 150_000)).toBeNull(); // wants 3
    expect(decide(5, 4, 10, cfg, 300_000)).toEqual({ to: 3, reason: 'cpu 10% per container over 300s (target 50%)' });
  });

  it('a value back near the target, or a swing the other way, restarts the window', () => {
    expect(decide(5, 2, 100, cfg, 0)).toBeNull();
    expect(decide(5, 2, 50, cfg, 30_000)).toBeNull();
    expect(decide(5, 2, 100, cfg, 60_000)).toBeNull();
    expect(decide(5, 2, 10, cfg, 90_000)).toBeNull();
    expect(decide(5, 2, 100, cfg, 120_000)).toBeNull();
    expect(decide(5, 2, 100, cfg, 180_000)).toEqual(expect.objectContaining({ to: 4 }));
  });

  it('does not act when the window asks for the current count after all, and labels rps', () => {
    const rps = { ...cfg, metric: 'rps' as const, target: 10, maxReplicas: 2 };
    expect(decide(6, 2, 40, rps, 0)).toBeNull(); // clamped to 2 = current
    expect(decide(7, 1, 40, rps, 0)).toBeNull();
    expect(decide(7, 1, 40, rps, 60_000)).toEqual({ to: 2, reason: 'rps 40 req/s per container over 60s (target 10 req/s)' });
  });
});

describe('scaleService', () => {
  it('up: starts and probes each spare, then routes them and audits', async () => {
    const { deps, calls, audits } = fakeDeps();
    expect(await scaleService(deps, await row(), 2, 4, 'busy', Date.UTC(2026, 9, 20))).toBe(4);
    expect(calls).toEqual([['start', 'web-9-r3'], ['start', 'web-9-r4']]);
    expect((await row()).runtimeReplicas).toBe(4);
    expect(deps.writeConfig).toHaveBeenCalledTimes(1);
    expect(audits).toEqual([['service.autoscale', 'web: 2 → 4', { serviceId: 5, from: 2, to: 4, reason: 'busy' }]]);
    expect(autoscaleStatus(await row()).lastEvent).toEqual({ at: '2026-10-20T00:00:00.000Z', from: 2, to: 4, reason: 'busy' });
  });

  it('up: stops at a spare that fails its healthcheck, and says so', async () => {
    const probe = vi.fn(async (_s: Service, name: string) => name !== 'web-9-r4');
    const { deps, calls } = fakeDeps({ probe });
    expect(await scaleService(deps, await row(), 2, 4, 'busy', 0)).toBe(3);
    expect(calls).toEqual([['start', 'web-9-r3'], ['start', 'web-9-r4'], ['stop', '-t', '5', 'web-9-r4']]);
    expect((await row()).runtimeReplicas).toBe(3);
    expect(autoscaleStatus(await row()).holding).toBe('web-9-r4 failed its healthcheck when started');
  });

  it('up: a spare that does not exist (autoscaling turned on since the deploy) leaves everything as it was', async () => {
    const { deps } = fakeDeps({ docker: vi.fn(async () => Promise.reject(new Error('No such container'))) });
    expect(await scaleService(deps, await row(), 2, 3, 'busy', 0)).toBe(2);
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
    expect(autoscaleStatus(await row()).holding).toBe('web-9-r3 could not be started; the next deploy creates the containers autoscaling starts');
  });

  it('down: routes the containers away first, then stops them', async () => {
    const order: string[] = [];
    const { deps } = fakeDeps({
      writeConfig: vi.fn(async () => {
        order.push(`route:${(await row()).runtimeReplicas}`);
      }),
      docker: vi.fn(async (args: string[]) => {
        order.push(args.join(' '));
      }),
    });
    expect(await scaleService(deps, await row(), 2, 1, 'idle', 0)).toBe(1);
    expect(order).toEqual(['route:1', 'stop -t 10 web-9-r2']);
  });

  it('down: a failed stop is logged; the containers are already unrouted', async () => {
    const { deps, lines } = fakeDeps({ docker: vi.fn(async () => Promise.reject('busy')) });
    expect(await scaleService(deps, await row(), 2, 1, 'idle', 0)).toBe(1);
    expect(lines).toEqual(['autoscale: web: stopping web-9-r2 failed (busy)']);
  });

  it('a deploy that replaced the runtime meanwhile wins: nothing is written or audited', async () => {
    const svc = await row();
    await db.update(services).set({ runtimeId: 'web-10' });
    for (const [from, to] of [[2, 3], [2, 1]] as const) {
      const { deps } = fakeDeps();
      expect(await scaleService(deps, svc, from, to, 'x', 0)).toBe(from);
      expect(deps.writeConfig).not.toHaveBeenCalled();
      expect(deps.audit).not.toHaveBeenCalled();
    }
  });
});

describe('autoscaleStep', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    containers: new Map([
      ['web-9', stat('web-9', 90)],
      ['web-9-r2', stat('web-9-r2', 90)],
    ]),
    analyticsOn: false,
    inFlight: new Set<number>(),
    canaryRunning: false,
    now: 0,
    ...over,
  });

  it('holds with the reason and touches nothing', async () => {
    const { deps } = fakeDeps();
    expect(await autoscaleStep(deps, await row(), cfg, ctx({ inFlight: new Set([5]) }))).toBe(2);
    expect(autoscaleStatus(await row()).holding).toBe('a deploy is in progress');
    expect(deps.docker).not.toHaveBeenCalled();
  });

  it('stops a spare that runs unrouted', async () => {
    const { deps, calls } = fakeDeps();
    const containers = new Map([...ctx().containers, ['web-9-r3', stat('web-9-r3', 1)]]);
    await autoscaleStep(deps, await row(), cfg, ctx({ containers }));
    expect(calls[0]).toEqual(['stop', '-t', '10', 'web-9-r3']);
  });

  it('moves inside new bounds at once', async () => {
    const { deps } = fakeDeps();
    const narrow = { ...cfg, minReplicas: 3 };
    expect(await autoscaleStep(deps, await row(), narrow, ctx())).toBe(3);
    expect(deps.audit).toHaveBeenCalledWith('service.autoscale', 'web: 2 → 3', expect.objectContaining({ reason: 'the configured bounds are 3–4' }));
  });

  it('measures, waits the window, then scales; status shows what it saw', async () => {
    const { deps } = fakeDeps();
    expect(await autoscaleStep(deps, await row(), cfg, ctx({ now: 0 }))).toBe(2);
    expect(autoscaleStatus(await row())).toMatchObject({ enabled: true, replicas: 2, value: 90, desired: 4, holding: null, lastEvent: null });
    await autoscaleStep(deps, await row(), cfg, ctx({ now: 30_000 }));
    expect(await autoscaleStep(deps, await row(), cfg, ctx({ now: 60_000 }))).toBe(4);
  });

  it('holds when the metric cannot be read', async () => {
    const { deps } = fakeDeps();
    expect(await autoscaleStep(deps, await row(), cfg, ctx({ containers: new Map() }))).toBe(2);
    expect(autoscaleStatus(await row()).holding).toBe('no container stats yet');
  });
});

describe('holdReason, autoscaleOf, status', () => {
  it('names each reason not to measure', async () => {
    const svc = await row();
    expect(holdReason(svc, new Set(), false)).toBeNull();
    expect(holdReason({ ...svc, serverId: 2 }, new Set(), false)).toMatch(/panel host only/);
    expect(holdReason({ ...svc, orchestrator: 'swarm' }, new Set(), false)).toMatch(/Swarm/);
    expect(holdReason({ ...svc, status: 'stopped' }, new Set(), false)).toBe('the service is not running');
    expect(holdReason(svc, new Set(), true)).toBe('a canary release is in progress');
  });

  it('reads a stored configuration, and none from an invalid one', async () => {
    const svc = await row();
    expect(autoscaleOf(svc)).toEqual(cfg);
    expect(autoscaleOf({ autoscale: null })).toBeNull();
    expect(autoscaleOf({ autoscale: { ...cfg, maxReplicas: 1 } })).toBeNull();
    expect(servingReplicas({ runtimeReplicas: null })).toBe(1);
    expect(autoscaleStatus({ ...svc, autoscale: null })).toEqual({ enabled: false, replicas: 2 });
    expect(autoscaleStatus(svc)).toMatchObject({ value: null, desired: null, holding: null, lastEvent: null });
    resetAutoscaleState(5);
  });
});

describe('createAutoscaler', () => {
  it('looks at autoscaled services only, one step per service at a time', async () => {
    const svc = await row();
    let release: () => void = () => undefined;
    const docker = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const { deps } = fakeDeps({ docker });
    const errors: unknown[] = [];
    const scaler = createAutoscaler({
      load: async () => [svc, { ...svc, id: 6, autoscale: null }],
      inFlightDeploys: async () => new Set(),
      containers: () => new Map([['web-9-r3', stat('web-9-r3', 1)]]),
      analyticsOn: async () => Promise.reject(new Error('no settings')),
      canaryRunning: () => false,
      step: deps,
      now: () => 0,
      onError: (e) => errors.push(e),
    });
    expect(await scaler.tick()).toBe(1);
    // The stray stop is still pending: the service is busy.
    expect(await scaler.tick()).toBe(0);
    release();
    await vi.waitFor(() => expect(scaler.busy.size).toBe(0));
    expect(errors).toEqual([]);
  });

  it('does nothing without autoscaled services, and reports a failed load', async () => {
    const { deps } = fakeDeps();
    const errors: unknown[] = [];
    const base = {
      inFlightDeploys: async () => new Set<number>(),
      containers: () => new Map(),
      analyticsOn: async () => false,
      canaryRunning: () => false,
      step: deps,
      onError: (e: unknown) => errors.push(e),
    };
    expect(await createAutoscaler({ ...base, load: async () => [] }).tick()).toBe(0);
    expect(await createAutoscaler({ ...base, load: async () => Promise.reject(new Error('db')) }).tick()).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('reports a failed step', async () => {
    const svc = await row();
    const errors: unknown[] = [];
    const { deps } = fakeDeps({ docker: vi.fn(async () => undefined) });
    const scaler = createAutoscaler({
      load: async () => [{ ...svc, runtimeId: null, status: 'running' } as Service, svc],
      inFlightDeploys: async () => new Set(),
      containers: () => {
        throw new Error('stats gone');
      },
      analyticsOn: async () => false,
      canaryRunning: () => false,
      step: deps,
      onError: (e) => errors.push(e),
    });
    expect(await scaler.tick()).toBe(0);
    expect(errors).toHaveLength(1);
  });
});
