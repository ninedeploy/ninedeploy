/**
 * G5.1 image scan routes (`modules/imageScans.ts`): the operator policy
 * routes, and a service scan on request for each place a service runs: a
 * Swarm service (scanned on the manager), a docker service on a node (its
 * agent), a compose stack and a docker service on the panel host. The docker
 * lookups and the scans themselves are stand-ins; the policy is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
const m = vi.hoisted(() => ({
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  capability: vi.fn(async (..._a: unknown[]) => undefined),
  swarmImage: vi.fn<(id: string) => Promise<string>>(),
  containerImage: vi.fn<(id: string) => Promise<string>>(),
  stackImages: vi.fn<(slug: string) => Promise<Array<{ imageId: string; services: string[] }>>>(),
  scan: vi.fn(),
  scanCompose: vi.fn(),
  scanNode: vi.fn(),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: m.audit }));
vi.mock('../src/lib/agentCapabilities.js', async (orig) => ({ ...(await orig<object>()), assertNodeCapability: m.capability }));
vi.mock('../src/lib/imageScan.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/imageScan.js')>()),
  swarmServiceImageId: m.swarmImage,
  containerImageId: m.containerImage,
  composeStackImages: m.stackImages,
  scanServiceImage: m.scan,
  scanComposeStack: m.scanCompose,
  scanNodeServiceImage: m.scanNode,
}));

const { setImageScanPolicy, composeImageSetId, DEFAULT_TRIVY_IMAGE } = await import('../src/lib/imageScan.js');
const { imageScanPolicyRoutes, serviceImageScanRoutes } = await import('../src/modules/imageScans.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

const IMG = `sha256:${'a'.repeat(64)}`;
const IMG2 = `sha256:${'b'.repeat(64)}`;
const ok = (imageId: string, critical = 0) => ({ status: 'ok', imageId, counts: { critical, high: 1, medium: 0, low: 0, unknown: 0 } });

let db: DB;
let app: Awaited<ReturnType<typeof buildTestApp>>;
beforeEach(async () => {
  for (const f of Object.values(m)) f.mockReset();
  m.audit.mockResolvedValue(undefined);
  m.capability.mockResolvedValue(undefined);
  db = await migratedDb();
  await db.insert(users).values({ id: 2, email: 'ops@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'web-1' },
    { id: 6, name: 'stack', slug: 'stack', type: 'compose', branch: 'main', ownerUserId: 2, runtimeId: 'ndcmp-stack' },
    { id: 7, name: 'edge', slug: 'edge', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'edge-svc', orchestrator: 'swarm' },
    { id: 8, name: 'remote', slug: 'remote', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'nd-svc-remote' },
    { id: 9, name: 'remote-idle', slug: 'remote-idle', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: null },
    { id: 10, name: 'site', slug: 'site', type: 'static', branch: 'main', ownerUserId: 2, runtimeId: 'site-1' },
    { id: 11, name: 'idle', slug: 'idle', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: null },
  ] as never);
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`UPDATE services SET server_id = 3 WHERE id IN (8, 9)`);
  app = await buildTestApp({ db });
  await app.register(imageScanPolicyRoutes, { prefix: '/image-scanning' });
  await app.register(serviceImageScanRoutes, { prefix: '/services' });
});
afterEach(async () => {
  await app.close();
  closeMigratedDb(db);
});

const post = (id: number) => app.inject({ method: 'POST', url: `/services/${id}/image-scan`, headers: asUser(1) });
const scanning = async (id: number) => (await app.inject({ method: 'GET', url: `/services/${id}/image-scan`, headers: asUser(1) })).json().scanning as boolean;
const flush = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('the policy routes', () => {
  it('reads the defaults and the Trivy image, and audits a change', async () => {
    const got = await app.inject({ method: 'GET', url: '/image-scanning', headers: asUser(1) });
    expect(got.json()).toEqual({ policy: { enabled: false, gate: 'off', gateFixableOnly: true, rescanHours: 24 }, trivyImage: DEFAULT_TRIVY_IMAGE });
    const put = await app.inject({ method: 'PUT', url: '/image-scanning', headers: asUser(1), payload: { enabled: true, gate: 'high' } });
    expect(put.json().policy).toEqual({ enabled: true, gate: 'high', gateFixableOnly: true, rescanHours: 24 });
    expect(m.audit).toHaveBeenCalledWith(db, 1, 'image_scan.policy', 'image-scanning', { enabled: true, gate: 'high', gateFixableOnly: true, rescanHours: 24 });
    // An empty body changes nothing.
    expect((await app.inject({ method: 'PUT', url: '/image-scanning', headers: asUser(1) })).json().policy.gate).toBe('high');
  });
});

describe('a scan on request', () => {
  beforeEach(async () => {
    await setImageScanPolicy(db, { enabled: true });
  });

  it('refuses members who are not admins of the service, and an unknown id', async () => {
    expect((await app.inject({ method: 'POST', url: '/services/5/image-scan', headers: asUser({ id: 99, isOperator: false }) })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await app.inject({ method: 'POST', url: '/services/abc/image-scan', headers: asUser(1) })).statusCode).toBe(400);
  });

  it('scans a Swarm service from the image its spec runs, and audits the result', async () => {
    m.swarmImage.mockResolvedValue(IMG);
    const done = deferred<unknown>();
    m.scan.mockReturnValue(done.promise);
    const res = await post(7);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true, imageId: IMG });
    expect(m.swarmImage).toHaveBeenCalledWith('edge-svc');
    expect(m.scan).toHaveBeenCalledWith(db, 7, IMG, 'manual');
    expect(await scanning(7)).toBe(true);
    // A second request while it runs is refused, not queued.
    expect((await post(7)).json().error.code).toBe('image_scan_running');
    done.resolve(ok(IMG, 2));
    await flush();
    expect(m.audit).toHaveBeenCalledWith(db, 1, 'image_scan.run', 'edge', { serviceId: 7, imageId: IMG, status: 'ok', critical: 2, high: 1 });
    expect(await scanning(7)).toBe(false);
  });

  it('refuses a Swarm service whose image is not on the panel host, and logs a failed scan', async () => {
    m.swarmImage.mockRejectedValueOnce(new Error('The image x of this Swarm service is not on the panel host'));
    const res = await post(7);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'image_scan_not_running', message: 'The image x of this Swarm service is not on the panel host' });
    m.swarmImage.mockRejectedValueOnce('no daemon');
    expect((await post(7)).json().error.message).toBe('no daemon');
    expect(await scanning(7)).toBe(false);

    m.swarmImage.mockResolvedValue(IMG);
    m.scan.mockRejectedValue(new Error('crashed'));
    expect((await post(7)).statusCode).toBe(202);
    await flush();
    expect(m.audit).not.toHaveBeenCalled();
    expect(await scanning(7)).toBe(false);
  });

  it('scans a node service through its agent after the capability check', async () => {
    const done = deferred<unknown>();
    m.scanNode.mockReturnValue(done.promise);
    const res = await post(8);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true, imageId: null });
    expect(m.capability).toHaveBeenCalledWith(db, 3, { cap: 'image.scan', feature: 'scan images for vulnerabilities', sealedRequired: true });
    expect(m.scanNode).toHaveBeenCalledWith(db, { id: 8, serverId: 3, runtimeId: 'nd-svc-remote' }, 'manual');
    expect((await post(8)).json().error.code).toBe('image_scan_running');
    done.resolve(ok(IMG2, 1));
    await flush();
    expect(m.audit).toHaveBeenCalledWith(db, 1, 'image_scan.run', 'remote', { serviceId: 8, imageId: IMG2, status: 'ok', critical: 1, high: 1 });
    expect(await scanning(8)).toBe(false);
  });

  it('does not audit an unchanged node image, and logs a failed node scan', async () => {
    m.scanNode.mockResolvedValueOnce(null);
    expect((await post(8)).statusCode).toBe(202);
    await flush();
    expect(m.audit).not.toHaveBeenCalled();
    m.scanNode.mockRejectedValueOnce(new Error('agent gone'));
    expect((await post(8)).statusCode).toBe(202);
    await flush();
    expect(m.audit).not.toHaveBeenCalled();
    expect(await scanning(8)).toBe(false);
  });

  it('refuses a node service that runs nothing', async () => {
    const res = await post(9);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('image_scan_not_running');
    expect(m.capability).not.toHaveBeenCalled();
  });

  it('refuses a service type that is not scanned, and a docker service that runs nothing', async () => {
    const res = await post(10);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('image_scan_unsupported');
    expect((await post(11)).json().error.code).toBe('image_scan_not_running');
  });

  it('scans every image of a compose stack and audits the merged result', async () => {
    const images = [{ imageId: IMG, services: ['api'] }, { imageId: IMG2, services: ['db'] }];
    m.stackImages.mockResolvedValue(images);
    const done = deferred<unknown>();
    m.scanCompose.mockReturnValue(done.promise);
    const res = await post(6);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true, imageId: composeImageSetId(images) });
    expect(m.stackImages).toHaveBeenCalledWith('stack');
    expect(m.scanCompose).toHaveBeenCalledWith(db, 6, images, 'manual');
    expect((await post(6)).json().error.code).toBe('image_scan_running');
    done.resolve(ok('compose:x', 0));
    await flush();
    expect(m.audit).toHaveBeenCalledWith(db, 1, 'image_scan.run', 'stack', { serviceId: 6, imageId: 'compose:x', status: 'ok', critical: 0, high: 1 });
    expect(await scanning(6)).toBe(false);
  });

  it('refuses a stack whose images cannot be listed or that runs nothing, and logs a failed stack scan', async () => {
    m.stackImages.mockRejectedValueOnce(new Error('inventory unconfirmed'));
    expect((await post(6)).json().error).toMatchObject({ code: 'image_scan_not_running', message: "Could not list the stack's images: inventory unconfirmed" });
    m.stackImages.mockRejectedValueOnce('daemon down');
    expect((await post(6)).json().error.message).toBe("Could not list the stack's images: daemon down");
    m.stackImages.mockResolvedValueOnce([]);
    expect((await post(6)).json().error).toMatchObject({ code: 'image_scan_not_running', message: 'The stack has no running container to scan; deploy it first' });
    expect(await scanning(6)).toBe(false);

    m.stackImages.mockResolvedValueOnce([{ imageId: IMG, services: ['api'] }]);
    m.scanCompose.mockRejectedValueOnce(new Error('crashed'));
    expect((await post(6)).statusCode).toBe(202);
    await flush();
    expect(m.audit).not.toHaveBeenCalled();
    expect(await scanning(6)).toBe(false);
  });

  it('scans a docker service on the panel host from its running image', async () => {
    m.containerImage.mockResolvedValue(IMG);
    const done = deferred<unknown>();
    m.scan.mockReturnValue(done.promise);
    const res = await post(5);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true, imageId: IMG });
    expect(m.containerImage).toHaveBeenCalledWith('web-1');
    expect((await post(5)).json().error.code).toBe('image_scan_running');
    done.resolve(ok(IMG, 0));
    await flush();
    expect(m.audit).toHaveBeenCalledWith(db, 1, 'image_scan.run', 'web', { serviceId: 5, imageId: IMG, status: 'ok', critical: 0, high: 1 });
    expect(await scanning(5)).toBe(false);
  });

  it('refuses a container whose image cannot be read, and logs a failed scan', async () => {
    m.containerImage.mockRejectedValueOnce(new Error('No such container'));
    expect((await post(5)).json().error).toMatchObject({ code: 'image_scan_not_running', message: 'Could not read the running image: No such container' });
    m.containerImage.mockRejectedValueOnce(42);
    expect((await post(5)).json().error.message).toBe('Could not read the running image: 42');
    expect(await scanning(5)).toBe(false);

    m.containerImage.mockResolvedValueOnce(IMG);
    m.scan.mockRejectedValueOnce(new Error('crashed'));
    expect((await post(5)).statusCode).toBe(202);
    await flush();
    expect(m.audit).not.toHaveBeenCalled();
    expect(await scanning(5)).toBe(false);
  });
});
