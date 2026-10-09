import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, runMigrations, services, settings } from '@ninedeploy/db';

/**
 * Multi-node T7, the pipeline branch (mount point M5, design §7.4, §7.5):
 *  - a NULL orchestrator (every service before an operator opts one in)
 *    deploys exactly as before: the container builder, no Swarm call at all;
 *  - `orchestrator = 'swarm'` reaches the Swarm builder (spy), after the
 *    §7.1 / cluster refusal, and finalizes `runtimeId = nd-<slug>_web` with
 *    one Traefik backend;
 *  - a refusal fails the deployment before anything is built;
 *  - a service leaving Swarm retires its stack once the container is live.
 * Docker, Traefik and both builders are fakes; the database is real.
 */

const h = vi.hoisted(() => ({
  container: {
    buildAndRun: vi.fn(async (ctx: { deploymentId: number; service: { slug: string } }) => ({ runtimeId: `${ctx.service.slug}-${ctx.deploymentId}`, port: 80, healthPath: '/', replicas: 1 })),
    isHealthy: vi.fn(async () => true),
    stop: vi.fn(async () => undefined),
  },
  swarm: {
    buildAndRun: vi.fn(async () => ({ runtimeId: 'nd-web_web', port: 80, healthPath: '/', replicas: 1 })),
    isHealthy: vi.fn(async () => true),
    stop: vi.fn(async () => undefined),
  },
  refusal: null as string | null,
  removed: [] as string[],
  docker: [] as string[][],
}));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  run: vi.fn(async (_c: string, args: string[]) => {
    h.docker.push(args);
  }),
  capture: vi.fn(async (_c: string, args: string[]) => {
    h.docker.push(args);
    return '';
  }),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/builders/docker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/builders/docker.js')>()),
  dockerBuilder: h.container,
}));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => null),
}));
vi.mock('../src/engine/swarmDeploy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine/swarmDeploy.js')>();
  return {
    ...real,
    swarmDeployRefusal: vi.fn(async () => h.refusal),
    createSwarmBuilder: vi.fn(() => h.swarm),
  };
});
vi.mock('../src/lib/swarm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/swarm.js')>()),
  removeSwarmStack: vi.fn(async (_db: unknown, slug: string) => {
    h.removed.push(slug);
  }),
}));

const { runDeployment } = await import('../src/engine/pipeline.js');
const swarmDeploy = await import('../src/engine/swarmDeploy.js');

let db: DB;
beforeEach(async () => {
  vi.clearAllMocks();
  h.refusal = null;
  h.removed = [];
  h.docker = [];
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(settings).values({ key: 'swarm_enabled', value: true });
});

async function deploy(values: Record<string, unknown>) {
  const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', image: 'nginx:1.27', port: 80, ...values } as never).returning();
  const [dep] = await db.insert(deployments).values({ serviceId: svc!.id, status: 'queued', trigger: 'manual' } as never).returning();
  await runDeployment(db, dep!.id);
  return {
    service: (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, svc!.id) }))!,
    deployment: (await db.query.deployments.findFirst({ where: (d, { eq }) => eq(d.id, dep!.id) }))!,
  };
}

describe('the pipeline and Swarm (M5)', () => {
  it('a NULL orchestrator deploys exactly as before: the container builder, nothing Swarm', async () => {
    const { service, deployment } = await deploy({});
    expect(deployment.status).toBe('running');
    expect(service).toMatchObject({ status: 'running', runtimeId: `web-${deployment.id}`, orchestrator: null });
    expect(h.container.buildAndRun).toHaveBeenCalledTimes(1);
    expect(swarmDeploy.createSwarmBuilder).not.toHaveBeenCalled();
    expect(swarmDeploy.swarmDeployRefusal).not.toHaveBeenCalled();
    expect(h.removed).toEqual([]);
    expect(h.docker.flat().join(' ')).not.toMatch(/swarm|stack|nd-swarm-/);
  });

  it("orchestrator 'container' is the same as NULL", async () => {
    await deploy({ orchestrator: 'container' });
    expect(h.container.buildAndRun).toHaveBeenCalledTimes(1);
    expect(swarmDeploy.createSwarmBuilder).not.toHaveBeenCalled();
  });

  it("orchestrator 'swarm' deploys through the Swarm builder and routes to nd-<slug>_web with one backend", async () => {
    const { service, deployment } = await deploy({ orchestrator: 'swarm', replicas: 3 });
    expect(swarmDeploy.swarmDeployRefusal).toHaveBeenCalledTimes(1);
    expect(swarmDeploy.createSwarmBuilder).toHaveBeenCalledWith(db, 'web');
    expect(h.swarm.buildAndRun).toHaveBeenCalledTimes(1);
    expect(h.swarm.isHealthy).toHaveBeenCalledTimes(1);
    expect(h.container.buildAndRun).not.toHaveBeenCalled();
    expect(deployment.status).toBe('running');
    expect(service).toMatchObject({ status: 'running', runtimeId: 'nd-web_web', runtimeReplicas: 1, replicas: 3 });
  });

  it('a Swarm refusal fails the deployment before anything is built', async () => {
    h.refusal = 'Swarm is not enabled on this panel';
    const { service, deployment } = await deploy({ orchestrator: 'swarm' });
    expect(deployment.status).toBe('failed');
    expect(service.status).toBe('error');
    expect(h.swarm.buildAndRun).not.toHaveBeenCalled();
    expect(h.container.buildAndRun).not.toHaveBeenCalled();
  });

  it('a redeploy of a Swarm service updates it in place (the previous runtime is the same service; nothing is retired)', async () => {
    const { deployment } = await deploy({ orchestrator: 'swarm', runtimeId: 'nd-web_web', status: 'running' });
    expect(deployment.status).toBe('running');
    expect(h.swarm.stop).not.toHaveBeenCalled();
  });

  it('a service leaving Swarm: the container goes live first, then its stack is retired', async () => {
    const { service } = await deploy({ orchestrator: null, runtimeId: 'nd-web_web', status: 'running' });
    expect(h.container.buildAndRun).toHaveBeenCalledTimes(1);
    expect(service.runtimeId).toMatch(/^web-\d+$/);
    expect(h.removed).toEqual(['web']);
    expect(h.container.stop).not.toHaveBeenCalledWith('nd-web_web', expect.anything());
  });
});
