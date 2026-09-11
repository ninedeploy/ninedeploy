import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { servicesRoutes } from '../src/modules/services.js';
import { getBundledTemplates } from '../src/templates/registry.js';
import { asUser, buildTestApp, createFakeDb, svcRow, trackStatusUpdates } from './helpers.js';

const execMocks = vi.hoisted(() => ({
  capture: vi.fn(async () => 'line1\nline2'),
  run: vi.fn(async (_c: unknown, _a: unknown, _o: unknown, sink?: (l: string) => void) => { sink?.('out'); }),
}));
vi.mock('../src/lib/exec.js', () => execMocks);

const pm2Mocks = vi.hoisted(() => ({
  connect: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
  disconnect: vi.fn(),
  stop: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
  restart: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
  delete: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
  describe: vi.fn((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) => cb(null, [])),
}));
vi.mock('pm2', () => ({ default: pm2Mocks }));

const proxyMocks = vi.hoisted(() => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  // Inline compose stacks resolve their SERVICE_URL_* tokens against the
  // wildcard domain, and the scheme comes from whether ACME is configured.
  getAcmeEmail: vi.fn(async () => null as string | null),
  getStickyEnabledForService: vi.fn(async () => false),
  // docker.ts imports NETWORK from proxy.js; provide it so the mock stays complete.
  NETWORK: 'ninedeploy',
  TRAEFIK_CONTAINER: 'ninedeploy-traefik',
  TRAEFIK_IMAGE: 'traefik:3',
}));

/**
 * Calls that act on a service's *runtime* (container, compose project, PM2
 * process), as opposed to the per-service Docker bridge that deleting a
 * service reaps via `removeServiceBridgeIfEmpty`.
 *
 * The delete tests below used to assert `run` was never called at all. That
 * held only because this mock was incomplete: `serviceBridge` imported
 * `TRAEFIK_CONTAINER` from the mocked `proxy.js`, the binding was missing, and
 * the resulting throw was swallowed by the delete route — so the bridge reap
 * silently never ran under test. Splitting the two concerns asserts the real
 * contract instead of a mock artifact.
 */
const runtimeRunCalls = () =>
  execMocks.run.mock.calls.filter((c) => (c[1] as string[])[0] !== 'network');
vi.mock('../src/engine/proxy.js', () => proxyMocks);

// Deleting a service also takes its deploy log files; the real helper touches
// the filesystem, so it is stubbed and asserted on.
const composeWorkspaceMocks = vi.hoisted(() => ({
  materialiseComposeFile: vi.fn((_id: number, _content: string) => '/tmp/docker-compose.yml'),
  INLINE_COMPOSE_FILE: 'docker-compose.yml',
  stackWorkspace: vi.fn((id: number) => `/tmp/${id}`),
}));
vi.mock('../src/lib/composeWorkspace.js', () => composeWorkspaceMocks);

const logsMocks = vi.hoisted(() => ({ deleteLog: vi.fn(() => true) }));
vi.mock('../src/engine/logs.js', () => ({ deleteLog: logsMocks.deleteLog }));

const configMock = vi.hoisted(() => ({
  wildcardDomain: '',
  isProd: false,
  publicUrl: 'http://localhost:3000',
  paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
  jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
}));
vi.mock('../src/config.js', () => ({ config: configMock }));

const validCreate = {
  name: 'My App',
  type: 'docker',
  repoUrl: 'https://github.com/acme/app.git',
  branch: 'main',
  port: 8080,
  build: { buildPack: 'auto', baseDir: '/' },
};

describe('services routes', () => {
  beforeEach(() => {
    // Isolate exec/pm2 call history per test (assertions like "not called with
    // docker logs" must not see earlier tests' calls).
    vi.clearAllMocks();
  });

  it('lists services', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findMany: { services: [svcRow({ id: 1, name: 'web' })] } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 1, name: 'web', autoUrl: null });
  });

  it('scopes the list to a project when ?projectId= is a positive integer', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findMany: { services: [svcRow({ id: 1, name: 'web' })] } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/?projectId=2', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 1, name: 'web' });
    // A non-numeric projectId is ignored (no scoping).
    const bad = await app.inject({ method: 'GET', url: '/?projectId=abc', headers: asUser() });
    expect(bad.statusCode).toBe(200);
  });

  it('resolves the attached Git credential name per service (sourceName)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          services: [
            svcRow({ id: 1, name: 'private-app', sourceId: 7 }),
            svcRow({ id: 2, name: 'public-app', sourceId: null }),
            svcRow({ id: 3, name: 'dangling', sourceId: 99 }),
          ],
          // One query feeds the whole list page — no per-row source lookups.
          sources: [{ id: 7, name: 'github-app', type: 'github' }],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0]).toMatchObject({ name: 'private-app', sourceId: 7, sourceName: 'github-app' });
    expect(rows[1]).toMatchObject({ name: 'public-app', sourceId: null, sourceName: null });
    // A credential deleted after the service was linked degrades to null.
    expect(rows[2]).toMatchObject({ name: 'dangling', sourceId: 99, sourceName: null });
  });

  it('creates a service and its build config', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: { services: [svcRow({ id: 4, name: 'My App', slug: 'my-app' })] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: validCreate });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 4, slug: 'my-app' });
  });

  it('refuses a member-supplied sourceId on create (operator-managed credentials)', async () => {
    // Sources hold operator-managed deploy keys/tokens; a member guessing id 1
    // could otherwise clone the operator's PRIVATE repos into their own
    // container and read the source.
    const app = await buildTestApp({
      db: createFakeDb({
        insert: { services: [svcRow({ id: 4, name: 'My App', slug: 'my-app' })] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { ...validCreate, sourceId: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a member-supplied serverId on create and patch; null stays allowed (r097)', async () => {
    // Remote servers are operator-registered capacity with their own public
    // Traefik edge; placing a member's container there is the operator's call.
    const createApp = await buildTestApp({
      db: createFakeDb({ insert: { services: [svcRow({ id: 4, name: 'My App', slug: 'my-app' })] } }),
    });
    await createApp.register(servicesRoutes);
    const created = await createApp.inject({
      method: 'POST',
      url: '/',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { ...validCreate, serverId: 3 },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error.message).toContain('remote server');

    const patchApp = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, ownerUserId: 7, runtimeId: 'nd-svc-web' }) },
        update: { services: [svcRow({ id: 1, ownerUserId: 7, serverId: null })] },
      }),
    });
    await patchApp.register(servicesRoutes);
    const moved = await patchApp.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { serverId: 3 },
    });
    expect(moved.statusCode).toBe(403);
    const backHome = await patchApp.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { serverId: null },
    });
    expect(backHome.statusCode).not.toBe(403);
  });

  it('refuses a member-supplied sourceId on patch (operator-managed credentials)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, ownerUserId: 7, runtimeId: 'nd-svc-web' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { sourceId: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('persists trusted command, socket and database mappings from a Hub template', async () => {
    let inserted: Record<string, unknown> | undefined;
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: (value) => {
            inserted = value as Record<string, unknown>;
            return [svcRow({ id: 4, name: 'WordPress', slug: 'wordpress' })];
          },
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: {
        templateId: 'wordpress',
        name: 'WordPress',
        type: 'docker',
        image: 'wordpress:latest',
        port: 80,
        volumeMount: '/var/www/html',
        build: { buildPack: 'auto', baseDir: '/' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(inserted).toMatchObject({
      templateId: 'wordpress',
      cmd: null,
      dockerSocket: false,
      templateDatabaseEnv: {
        WORDPRESS_DB_HOST: 'host', // internal bridge alias — see registry note
        WORDPRESS_DB_USER: 'username',
        WORDPRESS_DB_PASSWORD: 'password',
        WORDPRESS_DB_NAME: 'database',
      },
    });
  });

  it('returns 409-style 400 for a duplicate slug (including project-less rows)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 9, slug: 'my-app' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: validCreate });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('slug_taken');
  });

  it('reuses a matching caller-owned idle service for a Hub retry', async () => {
    const existing = svcRow({
      id: 9,
      ownerUserId: 1,
      name: 'My App',
      slug: 'my-app',
      status: 'idle',
      repoUrl: 'https://github.com/acme/app.git',
      port: 8080,
      serverId: null,
    });
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: existing } }) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { ...validCreate, reuseExisting: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 9, slug: 'my-app', status: 'idle' });
  });

  it('repairs an older failed Hub service with the current trusted template database contract', async () => {
    // Registry-controlled fields must match the bundled registry — hardcoding
    // them here drifts whenever the curated template images are bumped.
    const ghost = getBundledTemplates().find((t) => t.id === 'ghost');
    expect(ghost).toBeDefined();
    let updated: Record<string, unknown> | undefined;
    const existing = svcRow({
      id: 17,
      ownerUserId: 1,
      name: 'Ghost',
      slug: 'ghost',
      status: 'error',
      type: 'docker',
      repoUrl: null,
      image: ghost!.image,
      port: ghost!.port,
      volumeMount: ghost!.volumeMount,
      templateDatabaseEnv: null,
      serverId: null,
    });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: existing },
        update: { services: (value) => { updated = value as Record<string, unknown>; return [value as Record<string, unknown>]; } },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: {
        templateId: 'ghost',
        reuseExisting: true,
        name: 'Ghost',
        type: 'docker',
        image: ghost!.image,
        port: ghost!.port,
        volumeMount: ghost!.volumeMount,
        build: { buildPack: 'auto', baseDir: '/' },
      },
    });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json()).toMatchObject({ id: 17, status: 'error' });
    expect(updated?.templateId).toBe('ghost');
    expect(updated?.templateDatabaseEnv).toMatchObject({
      database__connection__host: 'host',
      database__connection__password: 'password',
    });
  });

  it('does not reuse another user service or an already deployed service', async () => {
    for (const existing of [
      svcRow({ ownerUserId: 2, slug: 'my-app', repoUrl: 'https://github.com/acme/app.git', port: 8080, serverId: null }),
      svcRow({ ownerUserId: 1, slug: 'my-app', repoUrl: 'https://github.com/acme/app.git', port: 8080, serverId: null, status: 'running' }),
    ]) {
      const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: existing } }) });
      await app.register(servicesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { ...validCreate, reuseExisting: true },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    }
  });

  it('creates a service without a port', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { services: [svcRow({ id: 4, port: null })] } }),
    });
    await app.register(servicesRoutes);
    const { port: _port, ...noPort } = validCreate;
    const res = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: noPort });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 4, port: null });
  });

  it('creates a service with an explicit slug and publishedPort', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { services: [svcRow({ id: 4, slug: 'custom', publishedPort: 8080 })] } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { ...validCreate, slug: 'custom', publishedPort: 8080 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('custom');
    expect(res.json().publishedPort).toBe(8080);
  });

  it('returns 404 when the service insert fails', async () => {
    const app = await buildTestApp({ db: createFakeDb({ insert: { services: [] } }) });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: validCreate });
    expect(res.statusCode).toBe(404);
  });

  it('gets a service by id', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 3 }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/3', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(3);
    expect(res.json().build).toBeNull();
  });

  it('gets a service with its build config', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 3 }),
          buildConfigs: {
            serviceId: 3, buildPack: 'dockerfile', baseDir: '/app', installCmd: null,
            buildCmd: 'npm run build', startCmd: 'npm start', dockerfilePath: './Dockerfile',
          },
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/3', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().build).toMatchObject({
      buildPack: 'dockerfile',
      baseDir: '/app',
      installCmd: null,
      buildCmd: 'npm run build',
      startCmd: 'npm start',
      dockerfilePath: './Dockerfile',
    });
  });

  it('returns 404 for a missing service', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/99', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('patches the build config alongside the service row', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        update: {
          services: [svcRow({ id: 1, name: 'renamed' })],
          build_configs: [{ serviceId: 1, buildPack: 'nixpacks' }],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/1', headers: asUser(),
      payload: {
        name: 'renamed',
        build: {
          buildPack: 'nixpacks', baseDir: '/app', installCmd: 'npm ci',
          buildCmd: '', startCmd: 'npm start', dockerfilePath: '',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 1, name: 'renamed' });
  });

  it('rewrites Traefik immediately when a running service container port is corrected', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, runtimeId: 'next-app-12', port: null }) },
        update: { services: [svcRow({ id: 1, runtimeId: 'next-app-12', port: 3000 })] },
      }),
    });
    await app.register(servicesRoutes);

    const res = await app.inject({
      method: 'PATCH', url: '/1', headers: asUser(), payload: { port: 3000 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().port).toBe(3000);
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalledWith(app.db);
  });

  it('patches restart policy and stop grace into the build config', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        update: { services: [svcRow()], build_configs: [{ serviceId: 1 }] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/1', headers: asUser(),
      payload: { build: { restartPolicy: 'on-failure:3', stopGraceSeconds: 20 } },
    });
    expect(res.statusCode).toBe(200);
  });

  it('skips the build config write when the patch carries no build keys', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        update: { services: [svcRow({ id: 1 })], build_configs: [] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/1', headers: asUser(), payload: { build: {} },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when patching a service whose build config row is missing', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        update: { services: [svcRow({ id: 1 })], build_configs: [] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/1', headers: asUser(), payload: { build: { startCmd: 'npm start' } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('patches a service with and without a build section', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        update: { services: [svcRow({ id: 1, name: 'renamed' })] },
      }),
    });
    await app.register(servicesRoutes);
    const withBuild = await app.inject({
      method: 'PATCH', url: '/1', headers: asUser(),
      payload: {
        name: 'renamed',
        previewDeploymentsEnabled: true,
        previewDomainPattern: 'pr-{{pr}}.local',
        build: {
          buildPack: 'nixpacks',
          preDeployCmd: 'npm run db:migrate',
          postDeployCmd: 'curl http://localhost/warmup',
          preStopCmd: 'npm run drain',
        },
      },
    });
    expect(withBuild.statusCode).toBe(200);
    expect(withBuild.json()).toMatchObject({ id: 1, name: 'renamed' });
    const withoutBuild = await app.inject({
      method: 'PATCH', url: '/1', headers: asUser(), payload: { name: 'renamed' },
    });
    expect(withoutBuild.statusCode).toBe(200);
  });

  it('returns 404 when patching a missing service', async () => {
    const app = await buildTestApp({ db: createFakeDb({ update: { services: [] } }) });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/99', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('patches a service with an empty body', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1 }) }, update: { services: [svcRow({ id: 1 })] } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 1 });
  });

  /**
   * The FK cascade removes the deployment ROWS but knows nothing about the log
   * FILES on disk, which would otherwise outlive the service they describe by
   * up to the 30-day retention window — and build logs routinely echo
   * configuration.
   */
  it('takes the deploy log files with the service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, name: 'web' }) },
        select: { deployments: [{ id: 41 }, { id: 42 }] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
    expect(logsMocks.deleteLog).toHaveBeenCalledWith(41);
    expect(logsMocks.deleteLog).toHaveBeenCalledWith(42);
  });

  it('still deletes the service when the log listing fails', async () => {
    // Cleanup is best-effort: a read failure must not block the destructive
    // operation the caller actually asked for. The 30-day sweep is the backstop.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, name: 'web' }) },
        selectError: { deployments: new Error('db locked') },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
    expect(logsMocks.deleteLog).not.toHaveBeenCalled();
  });

  it('deletes a service', async () => {
    // No runtime id — covers the "nothing to retire" branch.
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, name: 'web' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
    expect(runtimeRunCalls()).toEqual([]);
    // The service is gone, so its private bridge is reaped with it.
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker',
      ['network', 'disconnect', 'nd-svc-web', 'ninedeploy-traefik'],
      {},
      expect.any(Function),
    );
  });

  it('tears a compose project down on delete', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, name: 'stack', type: 'compose', runtimeId: 'ndcmp-stack-api-1' }) },
      }),
    });
    // The compose stop path resolves the project from the container's own
    // compose labels (project + config file, tab-separated). The stop path
    // passes only config files that still EXIST — the label records the
    // deploy-time override too, which the pipeline deletes afterwards — so
    // the recorded file here must be a real one on disk.
    const composeFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'nd-svc-stop-')), 'compose.yaml');
    writeFileSync(composeFile, 'services: {}\n');
    execMocks.capture.mockResolvedValueOnce(`ndcmp-stack\t${composeFile}`);
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
    const composeCall = execMocks.run.mock.calls.find((c) => (c[1] as string[])[0] === 'compose');
    expect(composeCall).toBeTruthy();
    expect((composeCall![1] as string[])).toEqual(['compose', '-p', 'ndcmp-stack', '-f', composeFile, 'down', '--remove-orphans']);
    rmSync(path.dirname(composeFile), { recursive: true, force: true });
  });

  it('stops and removes the docker container and rewrites traefik config on delete', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, name: 'web', type: 'docker', runtimeId: 'c1' }) },      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
    expect(execMocks.run).toHaveBeenCalledWith('docker', ['stop', '-t', '5', 'c1'], {}, expect.any(Function));
    expect(execMocks.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'c1'], {}, expect.any(Function));
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('deletes a pm2 service through the pm2 daemon and rewrites traefik config', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, name: 'api', type: 'pm2', runtimeId: 'api-1' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
    expect(pm2Mocks.delete).toHaveBeenCalledWith('api-1', expect.any(Function));
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('returns 404 when deleting a missing service', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/99', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('deletes the row even when rewriting traefik config fails', async () => {
    proxyMocks.writeDynamicConfig.mockRejectedValueOnce(new Error('yaml write failed'));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, name: 'web', type: 'docker', runtimeId: 'c1' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
  });

  it('updates limits', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1 }) }, update: { services: [svcRow({ id: 1, cpuShares: 512, memLimitMb: 1024 })] } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/1/limits', headers: asUser(), payload: { cpuShares: 512, memLimitMb: 1024 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cpuShares: 512, memLimitMb: 1024 });
  });

  it('returns 404 when updating limits on a missing service', async () => {
    const app = await buildTestApp({ db: createFakeDb({ update: { services: [] } }) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH', url: '/99/limits', headers: asUser(), payload: { cpuShares: 128 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('stops a running service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1', name: 'web' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'stopped' });
    expect(execMocks.capture).toHaveBeenCalledWith('docker', ['stop', '-t', '5', 'c1']);
  });

  it('starts a service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'running' });
  });

  it('restarts a service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/restart', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'running' });
  });

  it('returns 404 when stopping an undeployed service', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when starting an undeployed service', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when restarting an undeployed service', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/restart', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('treats stopping a missing container as success (idempotent)', async () => {
    execMocks.capture.mockRejectedValueOnce(
      new Error('`docker stop c1` exited 1: Error response from daemon: No such container: c1'),
    );
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'stopped' });
  });

  it('reports 503 instead of a fake status when the docker daemon is unreachable during stop', async () => {
    execMocks.capture.mockRejectedValueOnce(
      new Error('`docker stop c1` exited 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'),
    );
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(503);
  });

  it('reports 503 when the docker daemon is unreachable during start', async () => {
    execMocks.capture.mockRejectedValueOnce(
      new Error('`docker start c1` exited 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock'),
    );
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    expect(res.statusCode).toBe(503);
  });

  it('reports 409 and marks the service errored when the container no longer exists at start', async () => {
    execMocks.capture.mockRejectedValueOnce(
      new Error('`docker start c1` exited 1: Error response from daemon: No such container: c1'),
    );
    const db = createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } });
    const { updates } = trackStatusUpdates(db);
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/no longer exists/i);
    expect(updates).toContainEqual({ status: 'error' });
    // The lying "running" write must never happen after a failed start.
    expect(updates).not.toContainEqual({ status: 'running' });
  });

  it('reports 409 when the container no longer exists at restart', async () => {
    execMocks.capture.mockRejectedValueOnce(
      new Error('`docker restart c1` exited 1: Error response from daemon: No such container: c1'),
    );
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/restart', headers: asUser() });
    expect(res.statusCode).toBe(409);
  });

  it('propagates unexpected docker failures instead of claiming success', async () => {
    execMocks.capture.mockRejectedValueOnce(new Error('`docker stop c1` exited 1: driver failure'));
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(500);
  });

  it('returns container logs', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/logs', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lines: 'line1\nline2' });
  });

  it('returns empty logs when docker fails', async () => {
    execMocks.capture.mockRejectedValueOnce(new Error('no such container'));
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/logs', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lines: '' });
  });

  it('returns 404 for logs of an undeployed service', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/logs', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid create payload', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('exposes an auto url when a wildcard domain is configured', async () => {
    configMock.wildcardDomain = 'example.com';
    try {
      const app = await buildTestApp({
        db: createFakeDb({ findMany: { services: [svcRow({ id: 1, slug: 'web' })] } }),
      });
      await app.register(servicesRoutes);
      const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0].autoUrl).toBe('web.example.com');
    } finally {
      configMock.wildcardDomain = '';
    }
  });

  it('stops a pm2 service through the pm2 daemon, not docker', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, runtimeId: 'api-1', type: 'pm2', name: 'api' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'stopped' });
    expect(pm2Mocks.stop).toHaveBeenCalledWith('api-1', expect.any(Function));
    expect(execMocks.run).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['stop']));
  });

  it('starts a pm2 service through the pm2 daemon', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, runtimeId: 'api-1', type: 'pm2' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'running' });
    expect(pm2Mocks.restart).toHaveBeenCalledWith('api-1', expect.any(Function));
  });

  it('restarts a pm2 service through the pm2 daemon', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, runtimeId: 'api-1', type: 'pm2' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/restart', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'running' });
    expect(pm2Mocks.restart).toHaveBeenCalledWith('api-1', expect.any(Function));
  });

  it('treats stopping a missing pm2 process as success (idempotent)', async () => {
    pm2Mocks.stop.mockImplementationOnce((_n: string, cb: (err?: Error | null) => void) =>
      cb(new Error('process api-1 not found')));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, runtimeId: 'api-1', type: 'pm2' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'stopped' });
  });

  it('propagates unexpected pm2 daemon failures during stop instead of claiming success', async () => {
    pm2Mocks.stop.mockImplementationOnce((_n: string, cb: (err?: Error | null) => void) =>
      cb(new Error('RPC timeout')));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, runtimeId: 'api-1', type: 'pm2' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(res.statusCode).toBe(500);
  });

  it('reports 409 and marks the service errored when the pm2 process no longer exists at start', async () => {
    pm2Mocks.restart.mockImplementationOnce((_n: string, cb: (err?: Error | null) => void) =>
      cb(new Error('process api-1 not found')));
    const db = createFakeDb({
      findFirst: { services: svcRow({ id: 1, runtimeId: 'api-1', type: 'pm2' }) },
    });
    const { updates } = trackStatusUpdates(db);
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(updates).toContainEqual({ status: 'error' });
    expect(updates).not.toContainEqual({ status: 'running' });
  });

  it('propagates unexpected pm2 daemon failures during restart', async () => {
    pm2Mocks.restart.mockImplementationOnce((_n: string, cb: (err?: Error | null) => void) =>
      cb(new Error('RPC timeout')));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, runtimeId: 'api-1', type: 'pm2' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/restart', headers: asUser() });
    expect(res.statusCode).toBe(500);
  });

  it('rejects lifecycle ops for an unsupported service type', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, runtimeId: 'x-1', type: 'k8s' }) },
      }),
    });
    await app.register(servicesRoutes);
    for (const op of ['stop', 'start', 'restart']) {
      const res = await app.inject({ method: 'POST', url: `/1/${op}`, headers: asUser() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    // Neither the docker CLI nor the pm2 daemon was touched.
    expect(execMocks.run).not.toHaveBeenCalled();
    expect(pm2Mocks.stop).not.toHaveBeenCalled();
    expect(pm2Mocks.restart).not.toHaveBeenCalled();
  });

  it('deletes a service of an unsupported type without touching its runtime', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, name: 'odd', type: 'k8s', runtimeId: 'x-1' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(204);
    // An unknown service type has no runtime the panel knows how to retire —
    // but the row, its routing and its bridge still go away.
    expect(runtimeRunCalls()).toEqual([]);
    expect(pm2Mocks.delete).not.toHaveBeenCalled();
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('returns pm2 process logs from the daemon log files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pm2logs-'));
    const out = path.join(dir, 'out.log');
    const err = path.join(dir, 'err.log');
    writeFileSync(out, 'line1\nline2\nline3\n');
    writeFileSync(err, 'boom\n');
    pm2Mocks.describe.mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
      cb(null, [{ name: 'api-1', pm2_env: { pm_out_log_path: out, pm_err_log_path: err } }]));
    try {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1, runtimeId: 'api-1', type: 'pm2' }) },
        }),
      });
      await app.register(servicesRoutes);
      const res = await app.inject({ method: 'GET', url: '/1/logs', headers: asUser() });
      expect(res.statusCode).toBe(200);
      // Structural, not exact: the log bus may reorder/tail lines without the
      // test breaking (the join of out+err is an implementation detail).
      const lines = res.json().lines as string;
      expect(lines).toContain('line1');
      expect(lines).toContain('line2');
      expect(lines).toContain('line3');
      expect(lines).toContain('boom');
      expect(lines.split('\n')).toHaveLength(4);
      expect(execMocks.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['logs']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clones an existing service with its build configs and env vars', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, name: 'original-svc', slug: 'orig-svc' }),
          buildConfigs: { serviceId: 1, buildPack: 'nixpacks' } as any,
        },
        findMany: {
          envVars: [{ id: 1, serviceId: 1, key: 'PORT', valueEncrypted: 'enc', scope: 'service', scopeKey: null }] as any,
        },
        insert: {
          services: [svcRow({ id: 2, name: 'original-svc (Copy)', slug: 'orig-svc-copy' })],
          buildConfigs: [{ id: 2, serviceId: 2, buildPack: 'nixpacks' }] as any,
          envVars: [{ id: 2, serviceId: 2, key: 'PORT' }] as any,
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/clone',
      headers: asUser(),
      payload: { name: 'cloned-app' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 2, name: 'original-svc (Copy)' });

    // 404 for missing service
    const app404 = await buildTestApp({ db: createFakeDb({ findFirst: { services: null } }) });
    await app404.register(servicesRoutes);
    const res404 = await app404.inject({ method: 'POST', url: '/99/clone', headers: asUser() });
    expect(res404.statusCode).toBe(404);
  });
});

/**
 * Inline compose stacks: a compose file pasted into the wizard instead of
 * cloned from a repository. The YAML is stored on the service row and written
 * into the workspace; `composeWorkspace` is mocked so these tests assert the
 * WIRING (was it called, with what) without touching the filesystem — the file
 * itself is covered in test/lib/composeWorkspace.test.ts.
 */
describe('inline compose stacks', () => {
  const STACK = ['services:', '  web:', '    image: nginx:alpine', '  db:', '    image: postgres:16'].join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const appWith = async (over: Record<string, unknown> = {}) =>
    buildTestApp({
      db: createFakeDb({
        insert: { services: [svcRow({ id: 4, name: 'Stack', slug: 'stack', type: 'compose', ...over })] },
        findMany: { envVars: [] },
      }),
    });

  it('stores the YAML, derives the routed service and materialises the workspace file', async () => {
    const app = await appWith();
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'Stack', type: 'compose', composeContent: STACK, build: { buildPack: 'auto', baseDir: '/' } },
    });

    expect(res.statusCode).toBe(200);
    expect(composeWorkspaceMocks.materialiseComposeFile).toHaveBeenCalledWith(4, STACK);
    expect(res.json()).toMatchObject({ id: 4, type: 'compose' });
  });

  it('refuses a composeService the file does not declare', async () => {
    const app = await appWith();
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'Stack', type: 'compose', composeContent: STACK, composeService: 'nope' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not declared in the compose file/);
    expect(composeWorkspaceMocks.materialiseComposeFile).not.toHaveBeenCalled();
  });

  it('refuses a stack the platform cannot run (preflight) before creating anything', async () => {
    const app = await appWith();
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: {
        name: 'Stack',
        type: 'compose',
        composeContent: 'services:\n  web:\n    image: nginx\n    env_file: .env\n',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/env_file is not supported/);
    expect(composeWorkspaceMocks.materialiseComposeFile).not.toHaveBeenCalled();
  });

  it('refuses a stack with no services', async () => {
    // `docker compose up` on such a file succeeds while running nothing — the
    // deploy would go green with no containers.
    const app = await appWith();
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'Stack', type: 'compose', composeContent: 'version: "3"\n' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no services declared/);
  });

  it('is operator-only, like every other compose deploy', async () => {
    const app = await appWith();
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { name: 'Stack', type: 'compose', composeContent: STACK },
    });

    expect(res.statusCode).toBe(403);
  });

  it('PATCH rewrites the workspace copy of an existing stack', async () => {
    const next = 'services:\n  web:\n    image: nginx:1.27\n';
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 4, slug: 'stack', type: 'compose', composeService: 'web', composeContent: STACK }),
        },
        update: { services: [svcRow({ id: 4, slug: 'stack', type: 'compose', composeContent: next })] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/4',
      headers: asUser(),
      payload: { composeContent: next },
    });

    expect(res.statusCode).toBe(200);
    expect(composeWorkspaceMocks.materialiseComposeFile).toHaveBeenCalledWith(4, next);
  });

  it('PATCH refuses compose YAML for a service whose file comes from its repository', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 4, slug: 'stack', type: 'compose', repoUrl: 'https://github.com/a/b.git' }) },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/4',
      headers: asUser(),
      payload: { composeContent: STACK },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no inline compose stack/);
    expect(composeWorkspaceMocks.materialiseComposeFile).not.toHaveBeenCalled();
  });

  it('withholds the YAML from a member — a compose file can carry inline credentials', async () => {
    // Writing it is operator-only (PATCH runs the compose host-privilege
    // gate); reading has to match, or a member reads secrets the Environment
    // tab would never show them.
    // The member OWNS this service — visibility is not the point here, the
    // withheld field is.
    const row = svcRow({ id: 4, slug: 'stack', type: 'compose', ownerUserId: 7, composeContent: STACK });
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: row } }) });
    await app.register(servicesRoutes);

    const res = await app.inject({ method: 'GET', url: '/4', headers: asUser({ id: 7, isOperator: false }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().composeContent).toBeNull();
  });

  it('serves the stored YAML on the detail route only', async () => {
    const row = svcRow({ id: 4, slug: 'stack', type: 'compose', composeContent: STACK });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: row }, findMany: { services: [row] } }),
    });
    await app.register(servicesRoutes);

    const detail = await app.inject({ method: 'GET', url: '/4', headers: asUser() });
    expect(detail.json().composeContent).toBe(STACK);

    // The list ships every service on the host; a 256 KiB YAML per row has no
    // business in it.
    const list = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(list.json()[0]).not.toHaveProperty('composeContent');
  });

  it('previews a pasted file without creating anything', async () => {
    const app = await buildTestApp({ db: createFakeDb({}) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/compose/preview',
      headers: asUser(),
      payload: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the compose magic-token syntax is the literal under test
        content: 'services:\n  web:\n    image: nginx\n    environment:\n      KEY: ${SERVICE_PASSWORD_32}\n',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      services: ['web'],
      suggestedService: 'web',
      magicTokens: ['SERVICE_PASSWORD_32'],
    });
    expect(composeWorkspaceMocks.materialiseComposeFile).not.toHaveBeenCalled();
  });

  it('reports why a bad file cannot run instead of failing the request', async () => {
    // The wizard renders `reasons` inline; a 400 here would be a dead end.
    const app = await buildTestApp({ db: createFakeDb({}) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/compose/preview',
      headers: asUser(),
      payload: { content: 'services: [oops\n' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().reasons.join(' ')).toMatch(/unparsable YAML/);
  });

  it('refuses the preview to a member (it is the analysis half of a host-privileged deploy)', async () => {
    const app = await buildTestApp({ db: createFakeDb({}) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/compose/preview',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { content: 'services:\n  web:\n    image: nginx\n' },
    });

    expect(res.statusCode).toBe(403);
  });
});
