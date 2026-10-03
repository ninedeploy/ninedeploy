/**
 * Integration test: END-TO-END deploy through the real pipeline against a live
 * Docker daemon — an image-based service (nginx) is deployed, health checked,
 * blue-green flipped, and rolled back. Gated on RUN_INTEGRATION=1 + Docker.
 * Excluded from coverage runs (see vitest.integration.config.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer } from 'testcontainers';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { buildConfigs, createDb, deployments, services } from '@ninedeploy/db';
import { ensureNetwork } from '../../src/engine/proxy.js';
import { serviceBridgeName } from '../../src/lib/serviceBridge.js';
import { runDeployment } from '../../src/engine/pipeline.js';
import { capture } from '../../src/lib/exec.js';

const ENABLED = process.env.RUN_INTEGRATION === '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));

// The pipeline healthcheck probes the container's network IP directly from the
// host. That only works where the Docker bridge is host-routable (Linux, incl.
// CI); elsewhere (Docker Desktop) the sibling probe covers it — the probe
// container joins the runtime's per-slug bridge — but this suite still needs
// host-routable IPs for its own assertions, so it skips itself there instead
// of failing on an environmental limit.
let HOST_CAN_REACH_CONTAINERS = false;
if (ENABLED) {
  // The in-network probes `docker run` busybox:1.36. Pull it up front with
  // retries — an auto-pull inside a test assertion turns a rate-limited
  // registry into a red suite (seen on CI).
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await capture('docker', ['pull', 'busybox:1.36']).then(() => true).catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
  try {
    const probe = await new GenericContainer('nginx:1.27-alpine').withExposedPorts(80).start();
    const ip = (await capture('docker', ['inspect', probe.getName().replace(/^\//, ''), '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'])).trim();
    HOST_CAN_REACH_CONTAINERS = ip
      ? await fetch(`http://${ip}/`, { signal: AbortSignal.timeout(2000) }).then(() => true).catch(() => false)
      : false;
    await probe.stop();
  } catch {
    HOST_CAN_REACH_CONTAINERS = false;
  }
}

describe.skipIf(!ENABLED || !HOST_CAN_REACH_CONTAINERS)('deploy pipeline (real Docker daemon)', () => {
  // createDb returns { db, client } — migrations run against the drizzle handle.
  const db = createDb({ url: ':memory:' }).db;
  let serviceId: number;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder });
    await ensureNetwork(() => undefined);
    const [svc] = await db
      .insert(services)
      .values({ name: 'integ-e2e', slug: 'integ-e2e', type: 'docker', image: 'nginx:1.27-alpine', port: 80, healthPath: '/' })
      .returning();
    serviceId = svc!.id;
    await db.insert(buildConfigs).values({ serviceId, buildPack: 'dockerfile' });
  }, 240_000);

  afterAll(async () => {
    // Sweep every container this service ever ran (blue-green names).
    const list = await capture('docker', ['ps', '-a', '--format', '{{.Names}}']);
    for (const name of list.split('\n').map((n) => n.trim()).filter((n) => n.startsWith('nd-svc-integ-e2e'))) {
      await capture('docker', ['rm', '-f', name]).catch(() => '');
    }
    await capture('docker', ['network', 'rm', serviceBridgeName('integ-e2e')]).catch(() => '');
  }, 120_000);

  const deploy = async () => {
    const [dep] = await db.insert(deployments).values({ serviceId, status: 'queued', trigger: 'user' }).returning();
    await runDeployment(db, dep!.id);
    const row = await db.query.deployments.findFirst({ where: eq(deployments.id, dep!.id) });
    const svc = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
    return { dep: row!, svc: svc! };
  };

  // Model B: the runtime lives on its own `nd-svc-<slug>` bridge — the shared
  // mesh neither resolves its name nor routes to it. Verify reachability the
  // way platform infrastructure (Traefik, the probe container) does: from a
  // container attached to the service's bridge, by name.
  const httpGet = (runtimeId: string) =>
    capture('docker', ['run', '--rm', '--network', serviceBridgeName('integ-e2e'), 'busybox:1.36', 'wget', '-qO-', `http://${runtimeId}/`]);

  it('deploys an image, health checks it, and reports running', async () => {
    const { dep, svc } = await deploy();
    expect(dep.status).toBe('running');
    expect(svc.status).toBe('running');
    expect(svc.runtimeId).toBeTruthy();
    // The container actually serves HTTP on the shared network (no host ports).
    const out = await httpGet(svc.runtimeId!);
    expect(out).toContain('nginx');
    const ports = await capture('docker', ['port', svc.runtimeId!]);
    expect(ports.trim()).toBe('');
    const inspect = await capture('docker', ['inspect', svc.runtimeId!, '--format', '{{json .NetworkSettings.Networks}}']);
    // Model B: the runtime is a member of its per-slug bridge (where Traefik
    // and the probe container are attached), not the shared mesh.
    expect(inspect).toContain(serviceBridgeName('integ-e2e'));
  }, 300_000);

  it('rolls back to the first deployment', async () => {
    const first = await deploy();
    expect(first.dep.status).toBe('running');

    // Rollback = new deployment pinned to the first one's exact image.
    const [rb] = await db
      .insert(deployments)
      .values({ serviceId, status: 'queued', trigger: 'user', commitSha: first.dep.commitSha, imageDigest: first.dep.imageDigest })
      .returning();
    await runDeployment(db, rb!.id);
    const row = await db.query.deployments.findFirst({ where: eq(deployments.id, rb!.id) });
    expect(row!.status).toBe('running');

    const svc = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
    const out = await httpGet(svc!.runtimeId!);
    expect(out).toContain('nginx');
  }, 300_000);
});
