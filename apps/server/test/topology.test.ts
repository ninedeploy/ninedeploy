import { describe, expect, it, vi, beforeEach } from 'vitest';

const execMocks = vi.hoisted(() => ({ capture: vi.fn() }));
const visibleServiceIdSetMock = vi.hoisted(() => vi.fn().mockResolvedValue(new Set<number>()));
const visibleDatabaseIdsMock = vi.hoisted(() => vi.fn().mockResolvedValue(new Set<number>()));
vi.mock('../src/lib/exec.js', () => execMocks);
vi.mock('../src/lib/resourceAccess.js', () => ({
  visibleServiceIdSet: visibleServiceIdSetMock,
  visibleDatabaseIds: visibleDatabaseIdsMock,
}));

import { topologyRoutes } from '../src/modules/topology.js';
import { asUser, attachmentRow, buildTestApp, createFakeDb, dbRow, domainRow, svcRow } from './helpers.js';

describe('topology routes', () => {
  beforeEach(() => {
    execMocks.capture.mockReset();
    // Default: docker daemon present but empty runtime layers.
    execMocks.capture.mockResolvedValue('');
    visibleServiceIdSetMock.mockResolvedValue(null);
    visibleDatabaseIdsMock.mockResolvedValue(null);
  });

  it('assembles the workspace graph from all four tables', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 2, name: 'api', slug: 'api', type: 'pm2', status: 'running', port: null })],
          databases: [dbRow({ id: 3, name: 'redis', engine: 'redis', internalHost: null })],
          database_attachments: [attachmentRow({ id: 4, serviceId: 2, databaseId: 3, envAlias: 'REDIS_URL' })],
          domains: [domainRow({ id: 5, serviceId: 2, hostname: 'api.example.com' })],
        },
      }),
    });
    await app.register(topologyRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      services: [
        {
          id: 2,
          name: 'api',
          slug: 'api',
          type: 'pm2',
          status: 'running',
          image: null,
          port: null,
          runtimeId: null,
          volumeMount: null,
        },
      ],
      databases: [{ id: 3, name: 'redis', engine: 'redis', status: 'running', host: null }],
      attachments: [{ id: 4, serviceId: 2, databaseId: 3, envAlias: 'REDIS_URL' }],
      domains: [{ id: 5, serviceId: 2, hostname: 'api.example.com', ssl: false }],
      volumes: [],
      networks: [],
      gateway: { name: 'ninedeploy-traefik', network: 'ninedeploy', running: false },
    });
  });

  it('returns empty graphs when nothing exists', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(topologyRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      services: [],
      databases: [],
      attachments: [],
      domains: [],
      volumes: [],
      networks: [],
      gateway: { name: 'ninedeploy-traefik', network: 'ninedeploy', running: false },
    });
  });

  it('hides other tenants resources and runtime inventory from members', async () => {
    // visibleServiceIdSet returns {1} — user 7 owns service 1, not service 2.
    visibleServiceIdSetMock.mockResolvedValue(new Set([1]));
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [
            svcRow({ id: 1, ownerUserId: 7, slug: 'mine', runtimeId: 'mine-1' }),
            svcRow({ id: 2, ownerUserId: 9, slug: 'theirs', runtimeId: 'theirs-2' }),
          ],
          databases: [],
          database_attachments: [],
          domains: [
            domainRow({ id: 1, serviceId: 1, hostname: 'mine.example.com' }),
            domainRow({ id: 2, serviceId: 2, hostname: 'theirs.example.com' }),
          ],
        },
      }),
    });
    await app.register(topologyRoutes);
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.startsWith('volume ls')) return 'nd-svc-mine-data\nnd-svc-theirs-data\nnd-svc-orphan-data\n';
      if (joined.startsWith('network ls')) return 'ninedeploy\tbridge\nother-net\tbridge\n';
      if (joined.startsWith('network inspect')) return 'mine-1 theirs-2 ninedeploy-traefik ';
      return '';
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ id: 7, role: 'member' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().services.map((service: { id: number }) => service.id)).toEqual([1]);
    expect(res.json().domains.map((domain: { id: number }) => domain.id)).toEqual([1]);
    expect(res.json().volumes).toEqual([
      { name: 'nd-svc-mine-data', owner: { kind: 'service', refId: 1, name: 'web' } },
    ]);
    // The shared Traefik gateway stays visible: it is not another tenant's
    // resource and is already reported to every caller as `gateway`.
    expect(res.json().networks).toEqual([
      { name: 'ninedeploy', driver: 'bridge', containers: ['mine-1', 'ninedeploy-traefik'] },
    ]);
  });

  it('layers volumes, networks and the gateway from docker probes', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 2, name: 'web', slug: 'web', status: 'running', runtimeId: 'web-2', port: 3000, image: null, volumeMount: '/data' })],
          databases: [dbRow({ id: 3, name: 'pg', slug: 'pg', engine: 'postgres' })],
          database_attachments: [],
          domains: [],
        },
      }),
    });
    await app.register(topologyRoutes);
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.startsWith('volume ls')) return 'nd-svc-web-data\nnd-db-pg-data\nnd-svc-ghost-data\n';
      if (joined.startsWith('network ls')) return 'bridge\tbridge\nhost\thost\nninedeploy\tbridge\nmy-net\toverlay\n';
      if (joined.startsWith('network inspect ninedeploy')) return 'web-2 ninedeploy-traefik ';
      if (joined.startsWith('ps --filter name=^ninedeploy-traefik$')) return 'abc123\n';
      return '';
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Volumes resolved to owners; the ghost slug is orphaned.
    expect(body.volumes).toEqual([
      { name: 'nd-svc-web-data', owner: { kind: 'service', refId: 2, name: 'web' } },
      { name: 'nd-db-pg-data', owner: { kind: 'database', refId: 3, name: 'pg', engine: 'postgres' } },
      { name: 'nd-svc-ghost-data', owner: null },
    ]);
    // Builtin networks filtered; member list only for the shared mesh.
    expect(body.networks).toEqual([
      { name: 'ninedeploy', driver: 'bridge', containers: ['web-2', 'ninedeploy-traefik'] },
      { name: 'my-net', driver: 'overlay', containers: [] },
    ]);
    expect(body.gateway).toEqual({ name: 'ninedeploy-traefik', network: 'ninedeploy', running: true });
    // Service runtime details flow through for the graph.
    expect(body.services[0]).toMatchObject({ runtimeId: 'web-2', port: 3000, volumeMount: '/data' });
  });

  it('degrades a failing network inspect to an empty member list', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: { services: [], databases: [], database_attachments: [], domains: [] },
      }),
    });
    await app.register(topologyRoutes);
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.startsWith('network ls')) return 'ninedeploy\tbridge\n';
      if (joined.startsWith('network inspect')) throw new Error('inspect failed');
      return '';
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().networks).toEqual([{ name: 'ninedeploy', driver: 'bridge', containers: [] }]);
  });

  it('degrades gracefully when docker is unreachable', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 2, name: 'api', slug: 'api' })],
          databases: [],
          database_attachments: [],
          domains: [],
        },
      }),
    });
    await app.register(topologyRoutes);
    execMocks.capture.mockRejectedValue(new Error('docker down'));
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.services).toHaveLength(1);
    expect(body.volumes).toEqual([]);
    expect(body.networks).toEqual([]);
    expect(body.gateway.running).toBe(false);
  });

  it('renders per-slug bridges with their members (Model B)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          services: [svcRow({ id: 2, name: 'api', slug: 'api', status: 'running', runtimeId: 'api-7', port: 3000 })],
          databases: [dbRow({ id: 3, name: 'pg', slug: 'pg', engine: 'postgres' })],
          database_attachments: [attachmentRow({ serviceId: 2, databaseId: 3, envAlias: 'DATABASE_URL' })],
          domains: [],
        },
      }),
    });
    await app.register(topologyRoutes);
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.startsWith('volume ls')) return 'nd-svc-api-data\nnd-db-pg-data\n';
      if (joined.startsWith('network ls')) return 'ninedeploy\tbridge\nnd-svc-api\tbridge\n';
      // Per-slug bridge: app + its attached DB.
      if (joined.startsWith('network inspect nd-svc-api')) return 'api-7 nd-db-pg ';
      // Shared mesh: only Traefik (the legacy model would also include api-7).
      if (joined.startsWith('network inspect ninedeploy')) return 'ninedeploy-traefik ';
      if (joined.startsWith('ps --filter name=^ninedeploy-traefik$')) return 'abc123\n';
      return '';
    });
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Two bridges: shared mesh (Traefik only) and per-slug (app + db).
    const byName = Object.fromEntries((body.networks as Array<{ name: string; containers: string[] }>).map((n) => [n.name, n.containers]));
    expect(byName['ninedeploy']).toEqual(['ninedeploy-traefik']);
    expect(byName['nd-svc-api']).toEqual(['api-7', 'nd-db-pg']);
  });
});
