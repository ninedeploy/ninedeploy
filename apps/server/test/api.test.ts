import { describe, expect, it, vi } from 'vitest';
import { apiRoutes } from '../src/modules/api.js';
import { buildTestApp, createFakeDb } from './helpers.js';

const stubs = vi.hoisted(() => {
  const createFirstAdmin = vi.fn(async () => ({
    user: { id: 1, email: 'admin@example.com', name: null, isOperator: true },
    tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 900 },
  }));
  // Each stub registers a route with a unique path so plugins sharing a
  // prefix (e.g. all the /services sub-resources) do not collide.
  const plugin = (name: string) => async (app: { get: (p: string, h: () => unknown) => unknown }) => {
    app.get(`/${name}-ping`, async () => ({ ok: true, module: name }));
  };
  return { createFirstAdmin, plugin };
});

vi.mock('../src/modules/auth.js', () => ({
  createFirstAdmin: stubs.createFirstAdmin,
  authRoutes: stubs.plugin('auth'),
}));
vi.mock('../src/modules/about.js', () => ({ aboutRoutes: stubs.plugin('about') }));
vi.mock('../src/modules/activity.js', () => ({ activityRoutes: stubs.plugin('activity') }));
vi.mock('../src/modules/dashboard.js', () => ({ dashboardRoutes: stubs.plugin('dashboard') }));
vi.mock('../src/modules/databases.js', () => ({
  databasesRoutes: stubs.plugin('databases'),
  attachmentRoutes: stubs.plugin('attachments'),
}));
vi.mock('../src/modules/backups.js', () => ({
  backupRoutes: stubs.plugin('backups'),
  databaseBackupRoutes: stubs.plugin('database-backups'),
}));
vi.mock('../src/modules/deploys.js', () => ({ deploysRoutes: stubs.plugin('deploys') }));
vi.mock('../src/modules/domainIndex.js', () => ({ domainIndexRoutes: stubs.plugin('domain-index') }));
vi.mock('../src/modules/domains.js', () => ({ domainsRoutes: stubs.plugin('domains') }));
vi.mock('../src/modules/env.js', () => ({
  envRoutes: stubs.plugin('env'),
  projectEnvRoutes: stubs.plugin('project-env'),
  envSearchRoutes: stubs.plugin('env-search'),
}));
vi.mock('../src/modules/networks.js', () => ({ networkRoutes: stubs.plugin('networks') }));
vi.mock('../src/modules/hooks.js', () => ({
  hookReceiveRoutes: stubs.plugin('hook-receive'),
  webhookMgmtRoutes: stubs.plugin('webhooks'),
}));
vi.mock('../src/modules/notifications.js', () => ({ notificationRoutes: stubs.plugin('notifications') }));
vi.mock('../src/modules/stats.js', () => ({
  metricRoutes: stubs.plugin('metrics'),
  statsRoutes: stubs.plugin('stats'),
}));
vi.mock('../src/modules/services.js', () => ({ servicesRoutes: stubs.plugin('services') }));
vi.mock('../src/modules/serviceMigration.js', () => ({ serviceMigrationRoutes: stubs.plugin('migration') }));
vi.mock('../src/modules/sources.js', () => ({ sourcesRoutes: stubs.plugin('sources') }));
vi.mock('../src/modules/resources.js', () => ({ systemRoutes: stubs.plugin('system') }));
vi.mock('../src/modules/templates.js', () => ({ templateRoutes: stubs.plugin('templates') }));
vi.mock('../src/modules/topology.js', () => ({ topologyRoutes: stubs.plugin('topology') }));
vi.mock('../src/modules/tunnels.js', () => ({ tunnelRoutes: stubs.plugin('tunnels') }));
vi.mock('../src/modules/demo.js', () => ({ demoRoutes: stubs.plugin('demo') }));
vi.mock('../src/modules/users.js', () => ({ userRoutes: stubs.plugin('users') }));
vi.mock('../src/modules/volumes.js', () => ({ volumeRoutes: stubs.plugin('volumes') }));

describe('api routes (mounted under /v1)', () => {
  it('registers every module and answers on a representative route', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(apiRoutes, { prefix: '/v1' });
    const res = await app.inject({ method: 'GET', url: '/v1/about/about-ping' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, module: 'about' });
    // A second prefix-sharing route proves both registrations coexist.
    const services = await app.inject({ method: 'GET', url: '/v1/services/services-ping' });
    expect(services.statusCode).toBe(200);
  });

  /**
   * Every module this file stubs must actually be mounted.
   *
   * Spot-checking two of them let a real one slip: `metricRoutes` is a second
   * export from `stats.ts`, its own comment says "Mounted under /services", and
   * `api.ts` never registered it. `GET /v1/services/:id/metrics` therefore
   * 404'd — so the CPU/memory charts on Monitoring and the service Overview tab
   * had nothing to read while the collector wrote a row every 30 seconds. The
   * stub for it existed in this file the whole time and nothing asked it a
   * question.
   */
  it.each([
    ['/about', 'about'],
    ['/activity', 'activity'],
    ['/auth', 'auth'],
    ['/backups', 'backups'],
    ['/dashboard', 'dashboard'],
    ['/databases', 'databases'],
    ['/databases', 'database-backups'],
    ['/demo', 'demo'],
    ['/domains', 'domain-index'],
    ['/env', 'env-search'],
    ['/hooks', 'hook-receive'],
    ['/networks', 'networks'],
    ['/notifications', 'notifications'],
    ['/projects', 'project-env'],
    ['/services', 'services'],
    ['/services', 'attachments'],
    ['/services', 'deploys'],
    ['/services', 'domains'],
    ['/services', 'env'],
    ['/services', 'metrics'],
    ['/services', 'migration'],
    ['/services', 'webhooks'],
    ['/sources', 'sources'],
    ['/stats', 'stats'],
    ['/system', 'system'],
    ['/templates', 'templates'],
    ['/topology', 'topology'],
    ['/tunnels', 'tunnels'],
    ['/users', 'users'],
    ['/volumes', 'volumes'],
  ])('mounts %s → %s', async (prefix, module) => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(apiRoutes, { prefix: '/v1' });
    const res = await app.inject({ method: 'GET', url: `/v1${prefix}/${module}-ping` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, module });
  });

  it('bootstraps the first admin via /v1/setup', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(apiRoutes, { prefix: '/v1' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/setup',
      payload: { email: 'admin@example.com', password: 'password123', name: 'Admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: 1, email: 'admin@example.com', isOperator: true });
    expect(stubs.createFirstAdmin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ email: 'admin@example.com' }));
  });

  it('rejects an invalid setup payload with a validation envelope', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(apiRoutes, { prefix: '/v1' });
    const res = await app.inject({ method: 'POST', url: '/v1/setup', payload: { email: 'bad' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('propagates a createFirstAdmin failure as an http error', async () => {
    stubs.createFirstAdmin.mockRejectedValueOnce(new Error('Instance is already initialized'));
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(apiRoutes, { prefix: '/v1' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/setup',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(500);
  });
});
