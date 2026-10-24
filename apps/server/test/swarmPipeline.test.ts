import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, runMigrations, services, settings, swarmTransitions } from '@ninedeploy/db';
import type { BuildContext } from '../src/engine/types.js';

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
  checkout: vi.fn(async () => 'c'.repeat(40)),
  imageAvailable: true,
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
vi.mock('../src/lib/git.js', async original => ({ ...await original<typeof import('../src/lib/git.js')>(), checkoutCommit: h.checkout }));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  run: vi.fn(async (_c: string, args: string[]) => {
    h.docker.push(args);
  }),
  capture: vi.fn(async (_c: string, args: string[]) => {
    h.docker.push(args);
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!h.imageAvailable) throw Error('missing source image');
      return `sha256:${'a'.repeat(64)}`;
    }
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
  h.imageAvailable = true;
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
  it('retains a source artifact in the database before the Swarm update can be applied', async () => {
    const imageId = `sha256:${'a'.repeat(64)}`;
    h.swarm.buildAndRun.mockImplementationOnce(async (ctx: BuildContext) => {
      expect(ctx.recordDockerArtifact).toBe(true);
      await ctx.captureSwarmArtifact!({ imageId, builtWithNixpacks: true, builtStatic: false });
      expect((await db.query.deployments.findFirst({ where: (d, { eq }) => eq(d.id, ctx.deploymentId) }))?.artifact).toMatchObject({ imageId, originDeploymentId: ctx.deploymentId, commitSha: 'c'.repeat(40) });
      return { runtimeId: 'nd-web_web', port: 80, healthPath: '/', replicas: 1, imageDigest: imageId, artifactBuild: { builtWithNixpacks: true, builtStatic: false } };
    });
    const { deployment } = await deploy({ orchestrator: 'swarm', image: null, repoUrl: 'https://github.com/acme/web.git' });
    expect(deployment.status).toBe('running');
    expect(deployment.artifact).toMatchObject({ imageId, builtWithNixpacks: true });
  });
  it('does not apply a Swarm update if its verified panel artifact cannot be retained', async () => {
    h.imageAvailable = false;
    let applied = false;
    h.swarm.buildAndRun.mockImplementationOnce(async (ctx: BuildContext) => {
      await ctx.captureSwarmArtifact!({ imageId: `sha256:${'a'.repeat(64)}`, builtWithNixpacks: false, builtStatic: false });
      applied = true;
      return { runtimeId: 'nd-web_web', port: 80, healthPath: '/', replicas: 1 };
    });
    const { deployment } = await deploy({ orchestrator: 'swarm', image: null, repoUrl: 'https://github.com/acme/web.git', runtimeId: 'nd-web_web', status: 'running' });
    expect(deployment.status).toBe('failed'); expect(deployment.artifact).toBeNull();
    expect(applied).toBe(false); expect(h.swarm.stop).not.toHaveBeenCalled();
  });
  it('runs a queued Swarm artifact with target environment and skips Git and source builds', async () => {
    const imageId = `sha256:${'a'.repeat(64)}`, commitSha = 'c'.repeat(40);
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', orchestrator: 'swarm', repoUrl: 'https://github.com/acme/web.git', port: 80 }).returning();
    const [dep] = await db.insert(deployments).values({ serviceId: svc!.id, status: 'queued', commitSha, artifact: { version: 1, imageId, repoUrl: svc!.repoUrl!, commitSha, originDeploymentId: 99, builtWithNixpacks: true, builtStatic: false }, promotionSourceDeploymentId: 99 }).returning();
    h.swarm.buildAndRun.mockImplementationOnce(async (ctx: BuildContext) => {
      expect(ctx.prebuiltImage).toMatchObject({ imageId, tag: imageId, builtWithNixpacks: true });
      expect(ctx.recordDockerArtifact).toBeUndefined(); expect(ctx.captureSwarmArtifact).toBeUndefined();
      return { runtimeId: 'nd-web_web', port: 80, healthPath: '/', replicas: 1, imageDigest: imageId };
    });
    await runDeployment(db, dep!.id);
    expect(h.checkout).not.toHaveBeenCalled(); expect(h.container.buildAndRun).not.toHaveBeenCalled();
    expect((await db.query.deployments.findFirst({ where: (d, { eq }) => eq(d.id, dep!.id) }))?.status).toBe('running');
  });
  it('does not announce a completed hook while a journalled Swarm job is still pending', async () => {
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', image: 'nginx:1.27', orchestrator: 'swarm' }).returning();
    const [dep] = await db.insert(deployments).values({ serviceId: svc!.id, status: 'building' }).returning();
    await db.insert(swarmTransitions).values({ serviceId: svc!.id, deploymentId: dep!.id, runtimeId: 'nd-web_web', managerNodeId: 'mgr0000000000000000000001', payloadEncrypted: 'opaque', leaseUntil: new Date(Date.now() + 90_000), ownerToken: 'live' });
    const hooks = { call: vi.fn(async () => undefined) };
    await runDeployment(db, dep!.id, { hooks } as never);
    expect(hooks.call).not.toHaveBeenCalled();
    expect((await db.query.deployments.findFirst({ where: (d, { eq }) => eq(d.id, dep!.id) }))?.status).toBe('building');
  });

  it('fails an unavailable-manager preparation without stranding a building job', async () => {
    h.swarm.buildAndRun.mockImplementationOnce(async (ctx: BuildContext) => {
      await ctx.prepareSwarmTransition!({ name: 'nd-web', services: [], networks: [], configs: [], secrets: [], volumes: [] }, { runtimeId: 'nd-web_web', port: 80, healthPath: '/' });
      return { runtimeId: 'nd-web_web', port: 80, healthPath: '/', replicas: 1 };
    });
    const { deployment } = await deploy({ orchestrator: 'swarm' });
    expect(deployment.status).toBe('failed'); expect(await db.select().from(swarmTransitions)).toHaveLength(0);
  });

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
