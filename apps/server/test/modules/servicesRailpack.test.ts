import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, createFakeDb, svcRow } from '../helpers.js';

/**
 * r520: the panel's container image ships no Railpack CLI, so a container
 * install accepted `buildPack: railpack` and failed every deploy mid-build.
 * The save routes now refuse it up front there (the install check itself is
 * unit-tested in test/builders/docker.test.ts; this pins the wiring).
 */

const h = vi.hoisted(() => ({ refused: null as string | null }));

vi.mock('../../src/engine/builders/docker.js', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/builders/docker.js')>()),
  railpackRefusedForInstall: () => h.refused,
}));
vi.mock('../../src/lib/exec.js', () => ({
  capture: vi.fn(async () => ''),
  run: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
  buildEnv: () => ({}),
}));
vi.mock('../../src/engine/proxy.js', () => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => null),
  getStickyEnabledForService: vi.fn(async () => false),
  NETWORK: 'ninedeploy',
  TRAEFIK_CONTAINER: 'ninedeploy-traefik',
  TRAEFIK_IMAGE: 'traefik:3',
}));
vi.mock('../../src/config.js', () => ({
  config: {
    wildcardDomain: '',
    isProd: false,
    publicUrl: 'http://localhost:3000',
    paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
    jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
  },
}));

const { servicesRoutes } = await import('../../src/modules/services.js');

const REASON = 'The railpack build pack is not available on this installation';
const operator = asUser({ id: 1, isOperator: true });
const create = {
  name: 'My App',
  type: 'docker',
  repoUrl: 'https://github.com/acme/app.git',
  branch: 'main',
  port: 8080,
  build: { buildPack: 'railpack', baseDir: '/' },
};

describe('r520: railpack on a container install', () => {
  beforeEach(() => {
    h.refused = REASON;
  });

  it('refuses creating a railpack service', async () => {
    const app = await buildTestApp({ db: createFakeDb({ insert: { services: [svcRow({ id: 4, slug: 'my-app' })] } }) });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/', headers: operator, payload: create });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'railpack_unavailable', message: REASON });
  });

  it('refuses switching TO railpack, but not re-sending a pack the service already has', async () => {
    const svc = svcRow({ id: 1, ownerUserId: 1 });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svc, buildConfigs: { serviceId: 1, buildPack: 'auto' } },
        update: { services: [svc], buildConfigs: [{ serviceId: 1 }] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: operator, payload: { build: { buildPack: 'railpack' } } });
    expect(res.statusCode).toBe(400);

    const already = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svc, buildConfigs: { serviceId: 1, buildPack: 'railpack' } },
        update: { services: [svc], buildConfigs: [{ serviceId: 1 }] },
      }),
    });
    await already.register(servicesRoutes);
    const resend = await already.inject({ method: 'PATCH', url: '/1', headers: operator, payload: { build: { buildPack: 'railpack' } } });
    expect(resend.statusCode).toBe(200);
  });

  it('accepts railpack where the install can run it', async () => {
    h.refused = null;
    const app = await buildTestApp({ db: createFakeDb({ insert: { services: [svcRow({ id: 4, slug: 'my-app' })] } }) });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/', headers: operator, payload: create });
    expect(res.statusCode).toBe(200);
  });
});
