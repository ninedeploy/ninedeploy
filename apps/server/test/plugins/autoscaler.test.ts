import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, deployments, runMigrations, servers, services, users } from '@ninedeploy/db';

/**
 * 0.16.10: the autoscaler plugin's wiring — its loop, the queries it feeds
 * lib/autoscaler.ts, and the docker, probe, route and audit calls it hands
 * it — on a bare Fastify with a real migrated SQLite and fake timers.
 */

const h = vi.hoisted(() => ({
  run: vi.fn(async (..._a: unknown[]) => undefined),
  isHealthy: vi.fn(async (..._a: unknown[]) => true),
  writeDynamicConfig: vi.fn(async (..._a: unknown[]) => undefined),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  analytics: vi.fn(async () => false),
  nodeStep: vi.fn(async (..._a: unknown[]) => ({ state: 'held' })),
  nodeForget: vi.fn(),
}));
vi.mock('../../src/lib/exec.js', () => ({ run: h.run, sleep: async () => undefined }));
vi.mock('../../src/engine/builders/docker.js', () => ({ dockerBuilder: { isHealthy: h.isHealthy } }));
vi.mock('../../src/engine/proxy.js', () => ({ writeDynamicConfig: h.writeDynamicConfig }));
vi.mock('../../src/lib/audit.js', () => ({ audit: h.audit }));
vi.mock('../../src/lib/trafficAnalytics.js', () => ({ trafficAnalyticsEnabled: h.analytics }));
vi.mock('../../src/lib/nodeAutoscaleWorker.js', () => ({ createNodeAutoscaleWorker: () => ({ step: h.nodeStep, forget: h.nodeForget }) }));

const { default: autoscalerPlugin } = await import('../../src/plugins/autoscaler.js');
const { resetAutoscaleState } = await import('../../src/lib/autoscaler.js');

afterEach(() => {
  vi.useRealTimers();
  resetAutoscaleState();
});

async function boot(opts: { stats?: boolean; deploying?: boolean } = {}) {
  const { db } = createDb({ url: ':memory:' });
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
    runtimeReplicas: 1,
    port: 3000,
    healthCheck: 'command',
    healthCommand: 'true',
    autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 50, scaleUpSeconds: 30, scaleDownSeconds: 300 },
  } as never);
  if (opts.deploying) await db.insert(deployments).values({ serviceId: 5, status: 'building' });
  const app = Fastify();
  app.decorate('db', db);
  if (opts.stats !== false) {
    app.decorate('stats', { raw: () => ({ containers: new Map([['web-9', { name: 'web-9', cpuPct: 150, memBytes: 1, memLimitBytes: 2 }]]), host: null, sampledAt: Date.now() }) });
  }
  await app.register(autoscalerPlugin);
  await app.ready();
  return { app, db };
}

describe('autoscaler plugin', () => {
  it('dispatches node services to the node worker instead of the panel Docker path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    h.nodeStep.mockClear(); h.run.mockClear();
    const { app, db } = await boot();
    await db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
    await db.update(services).set({ serverId: 4 });
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.waitFor(() => expect(h.nodeStep).toHaveBeenCalledOnce());
    expect(h.nodeStep.mock.calls[0]?.[0]).toMatchObject({ id: 5, serverId: 4 });
    expect(h.run).not.toHaveBeenCalled();
    await app.close();
  });
  it('scales a busy service up after its window: starts and probes the spare, routes it, audits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { app, db } = await boot();
    await vi.advanceTimersByTimeAsync(40_000); // first look: the need starts
    await vi.advanceTimersByTimeAsync(30_000); // the window has passed
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledWith('docker', ['start', 'web-9-r2'], { timeoutMs: 15_000 }, expect.any(Function)));
    expect(h.isHealthy).toHaveBeenCalledWith(
      { runtimeId: 'web-9-r2', port: 3000, healthPath: '/', healthCheck: 'command', healthCommand: 'true' },
      60_000,
      0,
    );
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalledWith(db, null, 'service.autoscale', expect.stringMatching(/^web: 1 → [23]$/), expect.anything()));
    expect(h.writeDynamicConfig).toHaveBeenCalledWith(db, expect.objectContaining({ confirmServiceId: 5 }));
    expect((await db.query.services.findFirst())?.runtimeReplicas).toBeGreaterThan(1);
    await app.close();
  });

  it('holds while a deploy is in progress, and without the collector', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    h.run.mockClear();
    const busy = await boot({ deploying: true });
    await vi.advanceTimersByTimeAsync(100_000);
    await busy.app.close();
    const bare = await boot({ stats: false });
    await vi.advanceTimersByTimeAsync(100_000);
    await bare.app.close();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('a panel whose database predates migration 0088 looks at nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const app = Fastify();
    app.decorate('db', { select: () => ({ from: () => ({ where: () => {
      const query = Promise.resolve().then(() => { throw new Error('no such column: autoscale'); });
      return Object.assign(query, { orderBy: () => ({ limit: () => query }) });
    } }) }) } as never);
    await app.register(autoscalerPlugin);
    await app.ready();
    await vi.advanceTimersByTimeAsync(40_000);
    await app.close();
    expect(h.run).not.toHaveBeenCalled();
  });
});
