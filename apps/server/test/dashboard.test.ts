import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardRoutes } from '../src/modules/dashboard.js';
import { asUser, buildTestApp, createFakeDb, depRow, svcRow } from './helpers.js';

const execMocks = vi.hoisted(() => ({
  capture: vi.fn(async (_c: unknown, args: unknown[]) =>
    (args as string[])[0] === 'inspect' ? 'running|172.18.0.2' : 'a\nb\n'),
  run: vi.fn(async (_c: unknown, _a: unknown, _o: unknown, sink?: (l: string) => void) => { sink?.('out'); }),
}));
vi.mock('../src/lib/exec.js', () => execMocks);
vi.mock('../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));

describe('dashboard routes', () => {
  beforeEach(() => {
    // Isolate capture/run call history per test (assertions like "not called
    // with inspect" must not see earlier tests' calls).
    vi.clearAllMocks();
  });
  it('aggregates stats, health and recent deploys', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [
            svcRow({ id: 1, status: 'running', port: 3000, runtimeId: 'c1' }),
            svcRow({ id: 2, status: 'stopped', port: 3001 }),
            svcRow({ id: 3, status: 'running', port: null }),
            svcRow({ id: 4, status: 'error', port: 3002 }),
          ],
          databases: [svcRow({ id: 5, status: 'running' })],
        },
        counts: {
          services: [{ n: 4 }],
          databases: [{ n: 1 }],
          deployments: [{ n: 9 }],
          domains: [{ n: 2 }],
          webhooks: [{ n: 3 }],
        },
        findMany: {
          deployments: [
            depRow({ id: 10, serviceId: 1, status: 'running', finishedAt: new Date('2026-01-02T00:00:00Z') }),
            depRow({ id: 11, serviceId: 99, status: 'failed', commitSha: null, message: null }),
          ],
        },
        findFirst: {
          deployments: depRow({ id: 10, serviceId: 1, createdAt: new Date('2026-01-02T00:00:00Z') }),
        },
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats).toEqual({
      services: 4,
      databases: 1,
      deployments: 9,
      domains: 2,
      webhooks: 3,
      running: 2,
      stopped: 1,
      errored: 1,
      dbRunning: 1,
      containers: 2,
    });
    expect(body.recentDeploys[0]).toMatchObject({
      id: 10,
      serviceId: 1,
      serviceName: 'web',
      commitSha: 'abcdef1',
      finishedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(body.recentDeploys[1]).toMatchObject({ serviceId: 99, serviceName: 'unknown', finishedAt: null });
    expect(body.health).toHaveLength(4);
    expect(body.health[0]).toMatchObject({ serviceId: 1, healthy: true, responseMs: expect.any(Number) });
    expect(body.health[1]).toMatchObject({ serviceId: 2, healthy: false, responseMs: null });
    expect(body.health[2]).toMatchObject({ serviceId: 3, healthy: true, responseMs: null, port: null });
    expect(body.health[3]).toMatchObject({ serviceId: 4, healthy: false });
    expect(body.health[0].lastDeploy).toBe('2026-01-02T00:00:00.000Z');
  });

  it('marks a service unhealthy when its probe returns a 5xx', async () => {
    const fetchMock = vi.fn(async () => ({ status: 500, ok: false })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    // mesh fallback must also fail, or the service would read healthy again
    execMocks.capture.mockImplementation(async (_c: unknown, args: unknown[]) =>
      (args as string[])[0] === 'inspect' ? 'running|172.18.0.2' : Promise.reject(new Error('wget failed')));
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'running', port: 3000, runtimeId: 'c1' })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().health[0].healthy).toBe(false);
  });

  it('marks a service unhealthy when the probe rejects', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    execMocks.capture.mockImplementation(async (_c: unknown, args: unknown[]) =>
      (args as string[])[0] === 'inspect' ? 'running|172.18.0.2' : Promise.reject(new Error('wget failed')));
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'running', port: 3000, runtimeId: 'c1', commitSha: 'long-sha' })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().health[0]).toMatchObject({ healthy: false, responseMs: null });
  });

  it('falls back to the traefik mesh probe when the host cannot route bridge IPs', async () => {
    // Docker Desktop case: direct fetch to the bridge IP times out, but the
    // same request from inside the mesh (exec wget in the traefik container)
    // succeeds — the service must read healthy.
    const fetchMock = vi.fn(async () => { throw new Error('route unreachable'); }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    // Reset the persistent implementation leaked from the previous test.
    execMocks.capture.mockImplementation(async (_c: unknown, args: unknown[]) =>
      (args as string[])[0] === 'inspect' ? 'running|172.18.0.2' : 'ok');
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'running', port: 3000, runtimeId: 'c1' })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().health[0]).toMatchObject({ healthy: true, responseMs: null });
    expect(execMocks.capture).toHaveBeenCalledWith(
      'docker',
      ['exec', 'ninedeploy-traefik', 'wget', '-q', '-O', '/dev/null', '-T', '3', 'http://c1:3000/'],
    );
  });

  it('falls back to a netns-sharing probe for containers outside the mesh', async () => {
    // Compose-style service: not reachable from traefik's network, but the
    // throwaway curl container sharing its netns gets a 200 from loopback.
    const fetchMock = vi.fn(async () => { throw new Error('route unreachable'); }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    execMocks.capture.mockImplementation(async (_c: unknown, args: unknown[]) => {
      const a = args as string[];
      if (a[0] === 'inspect') return 'running|172.18.0.2';
      if (a[0] === 'exec') throw new Error('no route on mesh'); // e.g. compose network
      if (a[0] === 'run') return '200';
      return 'ok';
    });
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'running', port: 8080, runtimeId: 'ndcmp-web-1' })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().health[0]).toMatchObject({ healthy: true });
  });

  it('probes docker services on the container network IP, never loopback', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'running', port: 3000, runtimeId: 'c1', healthPath: '/health' })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('http://172.18.0.2:3000/health', expect.anything());
    expect(res.json().health[0]).toMatchObject({ healthy: true });
  });

  it('probes pm2 services on loopback since they are host processes', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'running', port: 3000, runtimeId: 'app-1', type: 'pm2', healthPath: '' })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3000/', expect.anything());
    // The PM2 path must not try to resolve a docker container IP.
    expect(execMocks.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['inspect']));
  });

  it('marks a docker service unhealthy when its container is not running', async () => {
    // Once-only override: 'exited|' resolves to no IP; later tests keep the
    // default running-container fixture (a leaked persistent implementation
    // would silently change their assertions).
    execMocks.capture.mockImplementationOnce(async (_c: unknown, args: unknown[]) =>
      (args as string[])[0] === 'inspect' ? 'exited|' : 'a\nb\n');
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'running', port: 3000, runtimeId: 'c1' })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().health[0]).toMatchObject({ healthy: false, responseMs: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a running docker service without a runtime id as unhealthy', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'running', port: 3000, runtimeId: null })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().health[0]).toMatchObject({ healthy: false, responseMs: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a missing docker binary as zero containers', async () => {
    execMocks.capture.mockRejectedValueOnce(new Error('docker not found'));
    const app = await buildTestApp({
      db: createFakeDb({ select: { services: [] }, counts: {} }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats.containers).toBe(0);
  });

  it('handles a service with no deployments', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [svcRow({ id: 1, status: 'idle', port: null, commitSha: null })] },
        counts: {},
      }),
    });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().health[0]).toMatchObject({ serviceId: 1, healthy: false, lastDeploy: null, commitSha: null });
    expect(res.json().recentDeploys).toEqual([]);
  });
});

describe('dashboard member scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Collect the SQL column names referenced by a drizzle condition. */
  function columnsIn(node: unknown, seen = new WeakSet<object>()): string[] {
    if (node === null || typeof node !== 'object' || seen.has(node)) return [];
    seen.add(node);
    const self = (node as { name?: unknown; columnType?: unknown }).columnType
      && typeof (node as { name?: unknown }).name === 'string'
      ? [(node as { name: string }).name]
      : [];
    return [...self, ...Object.values(node as Record<string, unknown>).flatMap((v) => columnsIn(v, seen))];
  }

  function scopedDb() {
    const capture = { where: undefined as unknown };
    const db = createFakeDb({
      select: {
        // Full-row select -> the whole inventory; id-only projection -> the
        // owner-scoped re-query, whose predicate the fake db cannot apply.
        services: (cols) =>
          cols === undefined
            ? [
                svcRow({ id: 70, ownerUserId: 7, name: 'mine', status: 'stopped', port: null }),
                svcRow({ id: 71, ownerUserId: 42, name: 'victim-billing-api', status: 'stopped', port: null }),
              ]
            : [{ id: 70 }],
        databases: [],
      },
      findMany: {
        deployments: async (args: unknown) => {
          const resolved = await Promise.resolve(args);
          const a = resolved as { where?: unknown };
          capture.where = a.where;
          return [depRow({ id: 8, serviceId: 70, status: 'completed' })];
        },
      },
    });
    return { db, capture };
  }

  it("a member's dashboard contains only their own services", async () => {
    const { db } = scopedDb();
    const app = await buildTestApp({ db });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ id: 7, isOperator: false }) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats.services).toBe(1);
    expect(body.health).toHaveLength(1);
    expect(body.health[0]).toMatchObject({ serviceId: 70, name: 'mine' });
    // Another tenant's inventory (names, health, counts) must not leak.
    expect(res.body).not.toContain('victim-billing-api');
  });

  it("constrains the recent-deploys query to the member's own service ids", async () => {
    // The fake db ignores predicates, so assert the where-clause itself
    // carries the service_id scoping (mirrors the M-2 regression pattern).
    const { db, capture } = scopedDb();
    const app = await buildTestApp({ db });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ id: 7, isOperator: false }) });
    expect(res.statusCode).toBe(200);
    expect(columnsIn(capture.where)).toContain('service_id');
    expect(res.json().recentDeploys[0]).toMatchObject({ serviceId: 70, serviceName: 'mine' });
  });

  it('an admin still sees the whole instance', async () => {
    const { db, capture } = scopedDb();
    const app = await buildTestApp({ db });
    await app.register(dashboardRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ id: 1, isOperator: true }) });
    expect(res.statusCode).toBe(200);
    // The admin path must NOT scope the recent-deploys query.
    expect(capture.where).toBeUndefined();
    const body = res.json();
    expect(body.stats.services).toBe(2);
    expect(body.health).toHaveLength(2);
  });
});
