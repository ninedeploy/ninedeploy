/**
 * G5.1 image scans of node services: the agent op (`image.scan`), the
 * panel's scan through it, and the scheduled rescan of node services.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
const exec = vi.hoisted(() => ({ capture: vi.fn<(cmd: string, args: string[]) => Promise<string>>() }));
vi.mock('../../src/lib/exec.js', async (orig) => ({ ...(await orig<object>()), capture: exec.capture }));

const lib = await import('../../src/lib/imageScan.js');
const { imageScanOps } = await import('../../src/agentOps/imageScan.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

const IMG = `sha256:${'a'.repeat(64)}`;
const IMG2 = `sha256:${'b'.repeat(64)}`;
const report = (critical: number) => ({
  os: 'debian 12.15',
  counts: { critical, high: 0, medium: 0, low: 0, unknown: 0 },
  fixable: { critical, high: 0, medium: 0, low: 0, unknown: 0 },
  findings: Array.from({ length: critical }, (_, i) => ({ id: `CVE-${i}`, severity: 'CRITICAL', pkg: 'openssl', installed: '1', fixed: '2', title: null, url: null, target: 'img' })),
  findingsTruncated: false,
});

let db: DB;
beforeEach(async () => {
  exec.capture.mockReset();
  db = await migratedDb();
  await db.insert(users).values({ id: 2, email: 'ops@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'nd-svc-api', serverId: null },
    { id: 8, name: 'edge', slug: 'edge', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'nd-svc-edge' },
  ] as never);
  // Service 8 runs on a node (no server row is needed for these calls).
  await db.run((await import('drizzle-orm')).sql`PRAGMA foreign_keys = OFF`);
  await db.run((await import('drizzle-orm')).sql`UPDATE services SET server_id = 3 WHERE id = 8`);
});
afterEach(() => closeMigratedDb(db));

describe('the agent op', () => {
  const run = (params: Record<string, unknown>) => {
    const lines: string[] = [];
    return imageScanOps.ops['image.scan']!.run(params, (l) => lines.push(l), { sealed: true } as never).then(() => lines);
  };

  it('scans only service containers the panel started, and answers "unchanged" for a known image', async () => {
    exec.capture.mockImplementation(async (_c, args) => (args.includes('{{.Image}}') ? `${IMG}\n` : 'database\n'));
    await expect(run({ container: 'nd-db-pg' })).rejects.toThrow(/not a service container/);
    exec.capture.mockImplementation(async (_c, args) => (args.includes('{{.Image}}') ? `${IMG}\n` : 'service\n'));
    expect(await run({ container: 'nd-svc-api', knownImageId: IMG })).toEqual([`ND-IMAGE-SCAN ${JSON.stringify({ imageId: IMG, unchanged: true })}`]);
    await expect(run({ container: '-rm' })).rejects.toThrow(/invalid container/);
    await expect(run({ container: 'nd-svc-api', knownImageId: 'latest' })).rejects.toThrow(/invalid knownImageId/);
  });
});

describe('scanning a node service', () => {
  it('stores the node report, skips an unchanged image and records a failure', async () => {
    let answer = JSON.stringify({ imageId: IMG, ...report(1) });
    const nodeScan = vi.fn(async () => answer);
    const r = await lib.scanNodeServiceImage(db, { id: 8, serverId: 3, runtimeId: 'nd-svc-edge' }, 'manual', { deps: { nodeScan } });
    expect(r).toMatchObject({ status: 'ok', imageId: IMG, os: 'debian 12.15', counts: { critical: 1 } });
    expect(nodeScan).toHaveBeenCalledWith(db, 3, { container: 'nd-svc-edge' });
    expect((await lib.getImageScanResult(db, 8))?.imageId).toBe(IMG);

    answer = JSON.stringify({ imageId: IMG, unchanged: true });
    expect(await lib.scanNodeServiceImage(db, { id: 8, serverId: 3, runtimeId: 'nd-svc-edge' }, 'schedule', { knownImageId: IMG, deps: { nodeScan } })).toBeNull();
    expect(nodeScan).toHaveBeenLastCalledWith(db, 3, { container: 'nd-svc-edge', knownImageId: IMG });

    // A malformed answer from the node is refused, not stored as a clean scan.
    answer = JSON.stringify({ imageId: IMG, counts: { critical: -1 }, fixable: {}, findings: [] });
    expect(await lib.scanNodeServiceImage(db, { id: 8, serverId: 3, runtimeId: 'nd-svc-edge' }, 'manual', { deps: { nodeScan } })).toMatchObject({ status: 'error' });
    nodeScan.mockRejectedValueOnce(new Error('update the node agent to v0.18.7'));
    expect(await lib.scanNodeServiceImage(db, { id: 8, serverId: 3, runtimeId: 'nd-svc-edge' }, 'manual', { deps: { nodeScan } })).toMatchObject({
      status: 'error',
      error: 'update the node agent to v0.18.7',
    });
  });

  it('is part of the scheduled rescan, which asks the node to skip an image it already scanned', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, rescanHours: 24 });
    let answer = JSON.stringify({ imageId: IMG, ...report(0) });
    const nodeScan = vi.fn(async () => answer);
    const onNewCritical = vi.fn();
    const deps = { nodeScan, onNewCritical, imageIdOf: async () => Promise.reject(new Error('none')), stackImagesOf: async () => [] };
    expect(await lib.rescanRunningImages(db, deps)).toBe(1);
    answer = JSON.stringify({ imageId: IMG, unchanged: true });
    expect(await lib.rescanRunningImages(db, deps)).toBe(0);
    expect(nodeScan).toHaveBeenLastCalledWith(db, 3, { container: 'nd-svc-edge', knownImageId: IMG });
    // A new image with a fixable critical is reported.
    answer = JSON.stringify({ imageId: IMG2, ...report(2) });
    expect(await lib.rescanRunningImages(db, deps)).toBe(1);
    expect(onNewCritical).toHaveBeenCalledTimes(1);
  });
});

describe('Swarm services', () => {
  it('scan the image the service spec runs on the panel host, and record why when it is not there', async () => {
    await db.insert(services).values({ id: 9, name: 'swarmy', slug: 'swarmy', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'nd-swarm-swarmy', orchestrator: 'swarm' } as never);
    await lib.setImageScanPolicy(db, { enabled: true, rescanHours: 24 });
    const trivy = vi.fn(async () => JSON.stringify({ SchemaVersion: 2, Results: [] }));
    let swarmImage: string | null = null;
    const deps = {
      trivy,
      nodeScan: async () => JSON.stringify({ imageId: IMG, unchanged: true }),
      imageIdOf: async () => Promise.reject(new Error('none')),
      stackImagesOf: async () => [],
      swarmImageIdOf: async () => (swarmImage ? swarmImage : Promise.reject(new Error('The image x of this Swarm service is not on the panel host, so it cannot be scanned here'))),
    };
    await lib.rescanRunningImages(db, deps);
    expect(await lib.getImageScanResult(db, 9)).toMatchObject({ status: 'error', error: expect.stringContaining('not on the panel host') });
    swarmImage = IMG2;
    await lib.rescanRunningImages(db, deps);
    expect(await lib.getImageScanResult(db, 9)).toMatchObject({ status: 'ok', imageId: IMG2 });
    expect(trivy).toHaveBeenCalledWith(IMG2);
  });
});
