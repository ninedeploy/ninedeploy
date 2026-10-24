import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, primaryTransitions, domains, runMigrations, type Service, services, users } from '@ninedeploy/db';
import { markAwake, putToSleep, resetSleepState, servingContainers, sleepHoldReason, type SleepDeps, wakeService } from '../../src/lib/sleep.js';
import { lastServiceRequestAt, recordServiceRequest, resetRequestRates } from '../../src/lib/requestRate.js';
import { createSleeper } from '../../src/plugins/sleeper.js';

/**
 * 0.16.11 scale to zero: when a service goes to sleep, how it sleeps (routes
 * first, then the stop) and how it wakes (start, healthcheck, routes back),
 * against a real migrated SQLite and a fake docker.
 */

let db: DB;
let connection: ReturnType<typeof createDb>;
afterEach(() => connection?.client?.close());
const MIN = 60_000;

beforeEach(async () => {
  connection = createDb({ url: ':memory:' }); db = connection.db;
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
    sleepAfterMinutes: 10,
  } as never);
  resetSleepState();
  resetRequestRates();
});

const row = async (): Promise<Service> => (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 5) }))!;

function fakeDeps(over: Partial<SleepDeps> = {}) {
  const order: string[] = [];
  const deps: SleepDeps = {
    db,
    docker: vi.fn(async (args: string[]) => {
      order.push(args.join(' '));
    }),
    probe: vi.fn(async () => true),
    writeConfig: vi.fn(async () => {
      order.push(`route:${(await row()).asleepAt ? 'asleep' : 'awake'}`);
    }),
    audit: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    log: vi.fn(),
    now: () => 1_000_000,
    ...over,
  };
  return { deps, order };
}

const ctx = (over: Record<string, unknown> = {}) => ({ now: 0, analyticsOn: true, inFlight: new Set<number>(), routedDomains: 1, canaryRunning: false, ...over });

describe('sleepHoldReason', () => {
  it('starts the idle window when it first sees a runtime, then sleeps after it with no request', async () => {
    const svc = await row();
    expect(sleepHoldReason(svc, ctx({ now: 0 }))).toBe('just started; the idle window begins now');
    expect(sleepHoldReason(svc, ctx({ now: 9 * MIN }))).toBe('it had a request within the idle window');
    expect(sleepHoldReason(svc, ctx({ now: 10 * MIN }))).toBeNull();
  });

  it('a request restarts the window, and a new runtime (a deploy) does too', async () => {
    const svc = await row();
    sleepHoldReason(svc, ctx({ now: 0 }));
    recordServiceRequest(5, 8 * MIN);
    expect(lastServiceRequestAt(5)).toBe(8 * MIN + 10_000);
    expect(sleepHoldReason(svc, ctx({ now: 15 * MIN }))).toBe('it had a request within the idle window');
    expect(sleepHoldReason(svc, ctx({ now: 19 * MIN }))).toBeNull();
    expect(sleepHoldReason({ ...svc, runtimeId: 'web-10' }, ctx({ now: 19 * MIN }))).toBe('just started; the idle window begins now');
  });

  it('names every other reason', async () => {
    const svc = await row();
    expect(sleepHoldReason({ ...svc, sleepAfterMinutes: null }, ctx())).toBe('not set or already asleep');
    expect(sleepHoldReason({ ...svc, asleepAt: new Date() }, ctx())).toBe('not set or already asleep');
    expect(sleepHoldReason({ ...svc, type: 'compose' }, ctx())).toMatch(/docker services only/);
    expect(sleepHoldReason({ ...svc, serverId: 2 }, ctx())).toMatch(/panel host only/);
    expect(sleepHoldReason({ ...svc, orchestrator: 'swarm' }, ctx())).toMatch(/Swarm/);
    expect(sleepHoldReason({ ...svc, status: 'stopped' }, ctx())).toBe('the service is not running');
    expect(sleepHoldReason(svc, ctx({ analyticsOn: false }))).toMatch(/traffic analytics/);
    expect(sleepHoldReason(svc, ctx({ routedDomains: 0 }))).toMatch(/no domain/);
    expect(sleepHoldReason(svc, ctx({ inFlight: new Set([5]) }))).toBe('a deploy is in progress');
    expect(sleepHoldReason(svc, ctx({ canaryRunning: true }))).toBe('a canary release is in progress');
  });
});

describe('putToSleep', () => {
  it('does not sleep a runtime protected by pending primary recovery', async () => {
    await db.insert(primaryTransitions).values({ serviceId: 5, deploymentId: 9, candidate: { runtimeId: 'web-10', port: 3000, healthPath: '/', healthCheck: null, replicas: 1, commitSha: null, containers: [] } });
    const { deps } = fakeDeps(); expect(await putToSleep(deps, await row())).toBe(false);
    expect(deps.docker).not.toHaveBeenCalled(); expect((await row()).asleepAt).toBeNull();
  });
  it('routes the domains to the wake endpoint first, then stops the serving containers, and audits', async () => {
    const { deps, order } = fakeDeps();
    expect(await putToSleep(deps, await row())).toBe(true);
    expect(order).toEqual(['route:asleep', 'stop -t 10 web-9 web-9-r2']);
    expect((await row()).asleepAt).toEqual(new Date(1_000_000));
    expect(deps.audit).toHaveBeenCalledWith('service.sleep', 'web', { serviceId: 5, afterMinutes: 10 });
  });

  it('stays awake when the routes cannot be written', async () => {
    const { deps } = fakeDeps({ writeConfig: vi.fn(async () => Promise.reject(new Error('disk full'))) });
    expect(await putToSleep(deps, await row())).toBe(false);
    expect((await row()).asleepAt).toBeNull();
    expect(deps.docker).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('sleep: web: the routes could not be written (disk full); it stays awake');
  });

  it('logs a failed stop; the domains are on the wake endpoint already', async () => {
    const { deps } = fakeDeps({ docker: vi.fn(async () => Promise.reject('busy')) });
    expect(await putToSleep(deps, await row())).toBe(true);
    expect(deps.log).toHaveBeenCalledWith('sleep: web: stopping web-9, web-9-r2 failed (busy)');
  });

  it('does nothing when the row moved on (a deploy, a stop)', async () => {
    const svc = await row();
    await db.update(services).set({ runtimeId: 'web-10' });
    const { deps } = fakeDeps();
    expect(await putToSleep(deps, svc)).toBe(false);
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });
});

describe('wakeService', () => {
  beforeEach(async () => {
    await db.update(services).set({ asleepAt: new Date(0) });
  });

  it('starts the containers, waits for the healthcheck, routes back and audits', async () => {
    let t = 1_000_000;
    const { deps, order } = fakeDeps({ now: () => (t += 500) });
    expect(await wakeService(deps, await row(), 'request')).toBe(true);
    expect(order).toEqual(['start web-9 web-9-r2', 'route:awake']);
    expect(deps.probe).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), 'web-9', 60_000);
    expect(deps.audit).toHaveBeenCalledWith('service.wake', 'web', { serviceId: 5, trigger: 'request', ms: 500 });
    // Awake now: the idle window starts again.
    expect(sleepHoldReason(await row(), ctx({ now: 1_005_000 }))).toBe('it had a request within the idle window');
  });

  it('concurrent requests share one wake', async () => {
    let release: () => void = () => undefined;
    const { deps } = fakeDeps({ probe: vi.fn(() => new Promise<boolean>((r) => (release = () => r(true)))) });
    const svc = await row();
    const a = wakeService(deps, svc, 'request');
    const b = wakeService(deps, svc, 'request');
    expect(b).toBe(a);
    await vi.waitFor(() => expect(deps.probe).toHaveBeenCalled());
    release();
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(deps.docker).toHaveBeenCalledTimes(1);
  });

  it('uses the service healthcheck timeout', async () => {
    const { deps } = fakeDeps();
    await wakeService(deps, { ...(await row()), healthTimeoutSeconds: 120 }, 'manual');
    expect(deps.probe).toHaveBeenCalledWith(expect.anything(), 'web-9', 120_000);
  });

  it('stays asleep when the containers will not start or fail the healthcheck', async () => {
    const broken = fakeDeps({ docker: vi.fn(async () => Promise.reject(new Error('No such container'))) });
    expect(await wakeService(broken.deps, await row(), 'request')).toBe(false);
    expect(broken.deps.log).toHaveBeenCalledWith('wake: web: starting web-9, web-9-r2 failed (No such container)');
    const sick = fakeDeps({ probe: vi.fn(async () => false) });
    expect(await wakeService(sick.deps, await row(), 'request')).toBe(false);
    expect(sick.order).toEqual(['start web-9 web-9-r2', 'stop -t 5 web-9 web-9-r2']);
    expect((await row()).asleepAt).not.toBeNull();
  });

  it('a service woken meanwhile (a deploy) is not routed or audited again', async () => {
    const svc = await row();
    await db.update(services).set({ asleepAt: null });
    const { deps } = fakeDeps();
    expect(await wakeService(deps, svc, 'request')).toBe(true);
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe('servingContainers, markAwake', () => {
  it('lists the serving containers', () => {
    expect(servingContainers({ runtimeId: 'a', runtimeReplicas: null })).toEqual(['a']);
    expect(servingContainers({ runtimeId: 'a', runtimeReplicas: 3 })).toEqual(['a', 'a-r2', 'a-r3']);
  });

  it('markAwake starts a window by hand', async () => {
    const svc = await row();
    markAwake(svc, 0);
    expect(sleepHoldReason(svc, ctx({ now: 10 * MIN }))).toBeNull();
  });
});

describe('createSleeper', () => {
  it('puts idle services to sleep and skips the rest', async () => {
    const svc = await row();
    markAwake(svc, 0);
    const { deps } = fakeDeps();
    const errors: unknown[] = [];
    const sleeper = createSleeper({
      load: async () => [svc, { ...svc, id: 6, sleepAfterMinutes: null }],
      inFlightDeploys: async () => new Set(),
      routedDomains: async () => new Map([[5, 1]]),
      analyticsOn: async () => Promise.reject(new Error('settings')),
      canaryRunning: () => false,
      wakeUnreachable: async () => null,
      step: deps,
      now: () => 11 * MIN,
      onError: (e) => errors.push(e),
    });
    // Traffic analytics could not be read: treated as off, nothing sleeps.
    expect(await sleeper.tick()).toBe(0);
    // Traefik cannot reach the wake endpoint: it stays awake, and says why.
    const blind = createSleeper({
      load: async () => [svc],
      inFlightDeploys: async () => new Set(),
      routedDomains: async () => new Map([[5, 1]]),
      analyticsOn: async () => true,
      canaryRunning: () => false,
      wakeUnreachable: async () => 'Traefik cannot reach the panel',
      step: deps,
      now: () => 11 * MIN,
    });
    expect(await blind.tick()).toBe(0);
    expect(deps.log).toHaveBeenCalledWith('sleep: web stays awake: Traefik cannot reach the panel');
    const on = createSleeper({
      load: async () => [svc],
      inFlightDeploys: async () => new Set(),
      routedDomains: async () => new Map([[5, 1]]),
      analyticsOn: async () => true,
      canaryRunning: () => false,
      wakeUnreachable: async () => null,
      step: deps,
      now: () => 11 * MIN,
      onError: (e) => errors.push(e),
    });
    expect(await on.tick()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('reports a failed load and a failed sleep, and does nothing without candidates', async () => {
    const svc = await row();
    markAwake(svc, 0);
    const errors: unknown[] = [];
    const base = {
      inFlightDeploys: async () => new Set<number>(),
      routedDomains: async () => new Map([[5, 1]]),
      analyticsOn: async () => true,
      canaryRunning: () => false,
      wakeUnreachable: async () => null,
      now: () => 11 * MIN,
      onError: (e: unknown) => errors.push(e),
    };
    expect(await createSleeper({ ...base, load: async () => [], step: fakeDeps().deps }).tick()).toBe(0);
    expect(await createSleeper({ ...base, load: async () => Promise.reject(new Error('db')), step: fakeDeps().deps }).tick()).toBe(0);
    const failing = fakeDeps();
    failing.deps.db = { update: () => ({ set: () => ({ where: () => ({ returning: async () => Promise.reject(new Error('locked')) }) }) }) } as never;
    expect(await createSleeper({ ...base, load: async () => [svc], step: failing.deps }).tick()).toBe(0);
    expect(errors).toHaveLength(2);
  });
});

describe('the sleeper plugin', () => {
  it('loads services with sleepAfterMinutes, their routed domains and in-flight deploys', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.resetModules();
      const h = { run: vi.fn(async (..._a: unknown[]) => undefined) };
      vi.doMock('../../src/lib/exec.js', () => ({ run: h.run, sleep: async () => undefined }));
      vi.doMock('../../src/engine/proxy.js', () => ({ writeDynamicConfig: async () => undefined }));
      vi.doMock('../../src/lib/audit.js', () => ({ audit: async () => undefined }));
      vi.doMock('../../src/lib/trafficAnalytics.js', () => ({ trafficAnalyticsEnabled: async () => true }));
      vi.doMock('../../src/engine/builders/docker.js', () => ({ dockerBuilder: { isHealthy: async () => true } }));
      vi.doMock('../../src/lib/panelUpstream.js', () => ({ wakeUnreachableReason: async () => null }));
      const Fastify = (await import('fastify')).default;
      const { default: sleeperPlugin } = await import('../../src/plugins/sleeper.js');
      await db.insert(domains).values({ serviceId: 5, hostname: 'web.example.com', status: 'active' } as never);
      await db.insert(deployments).values({ serviceId: 5, status: 'running' });
      const app = Fastify();
      app.decorate('db', db);
      await app.register(sleeperPlugin);
      await app.ready();
      await vi.advanceTimersByTimeAsync(60_000); // first look: the window starts
      await vi.advanceTimersByTimeAsync(10 * MIN); // ten idle minutes later
      await vi.waitFor(async () => expect((await row()).asleepAt).not.toBeNull());
      expect(h.run).toHaveBeenCalledWith('docker', ['stop', '-t', '10', 'web-9', 'web-9-r2'], {}, expect.any(Function));
      await app.close();
    } finally {
      vi.useRealTimers();
      vi.doUnmock('../../src/lib/exec.js');
      vi.doUnmock('../../src/engine/proxy.js');
      vi.doUnmock('../../src/lib/audit.js');
      vi.doUnmock('../../src/lib/trafficAnalytics.js');
      vi.doUnmock('../../src/engine/builders/docker.js');
      vi.doUnmock('../../src/lib/panelUpstream.js');
    }
  });
});
