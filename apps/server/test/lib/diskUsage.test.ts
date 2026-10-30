/**
 * ROADMAP item 9: hourly disk samples per service (lib/diskUsage.ts) against
 * a migrated SQLite. Docker is a fake; node sizes are injected.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metrics, servers, serviceVolumeAttachments, services, type DB } from '@ninedeploy/db';

const h = vi.hoisted(() => ({ df: '[]' as string | Error }));
vi.mock('../../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/exec.js')>()),
  capture: vi.fn(async (_tool: string, args: string[]) => {
    if (args.join(' ') !== 'system df -v --format {{json .Volumes}}') throw new Error(`unexpected docker ${args.join(' ')}`);
    if (h.df instanceof Error) throw h.df;
    return h.df;
  }),
}));

const lib = await import('../../src/lib/diskUsage.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  h.df = '[]';
});
afterEach(() => closeMigratedDb(db));

const NOW = new Date('2026-10-30T12:00:00Z');
const disk = () => db.select({ serviceId: metrics.serviceId, value: metrics.value }).from(metrics).where(eq(metrics.kind, 'disk'));

describe('Docker sizes', () => {
  it('reads Docker’s decimal human sizes', () => {
    expect(lib.parseDockerSize('0B')).toBe(0);
    expect(lib.parseDockerSize('512B')).toBe(512);
    expect(lib.parseDockerSize('1.5kB')).toBe(1500);
    expect(lib.parseDockerSize('2.25GB')).toBe(2_250_000_000);
    expect(lib.parseDockerSize(' 3MB ')).toBe(3_000_000);
    for (const bad of ['N/A', '', '1.2 GiB', 'GB']) expect(lib.parseDockerSize(bad)).toBeNull();
  });

  it('maps every panel-host volume to its size; unreadable output is empty', async () => {
    h.df = JSON.stringify([{ Name: 'a', Size: '1kB' }, { Name: 'b', Size: 'N/A' }, { Name: 3, Size: '1B' }, { Name: 'c' }]);
    expect([...(await lib.panelVolumeSizes())]).toEqual([['a', 1000]]);
    h.df = 'not json';
    expect((await lib.panelVolumeSizes()).size).toBe(0);
    h.df = '';
    expect((await lib.panelVolumeSizes()).size).toBe(0);
    h.df = '{"not":"a list"}';
    expect((await lib.panelVolumeSizes()).size).toBe(0);
  });
});

describe('the hourly sample', () => {
  it('adds up each service’s primary and attached volumes, on the panel host and on a node', async () => {
    const [node] = await db.insert(servers).values({ name: 'edge', host: '198.51.100.3', port: 4600, tokenEncrypted: 'x', status: 'online' }).returning();
    const [web] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', volumeMount: '/data' } as never).returning();
    const [api] = await db.insert(services).values({ name: 'api', slug: 'api', type: 'docker', serverId: node!.id } as never).returning();
    const [none] = await db.insert(services).values({ name: 'none', slug: 'none', type: 'docker' } as never).returning();
    await db.insert(serviceVolumeAttachments).values([
      { serviceId: web!.id, volumeName: 'shared', containerPath: '/shared' },
      { serviceId: api!.id, volumeName: 'nd-svc-api-cache', containerPath: '/cache' },
      { serviceId: api!.id, volumeName: 'unmeasurable', containerPath: '/x' },
    ] as never);
    const nodeSize = vi.fn(async (_serverId: number, volume: string) => (volume === 'unmeasurable' ? null : 5e9));
    const panelSizes = vi.fn(async () => new Map([['nd-svc-web-data', 2e9], ['shared', 1e9]]));
    expect(await lib.sampleServiceDisk(db, { panelSizes, nodeSize }, NOW)).toBe(1);
    expect(panelSizes).toHaveBeenCalledTimes(1);
    expect(nodeSize).toHaveBeenCalledWith(node!.id, 'nd-svc-api-cache');
    const rows = await disk();
    expect(rows.find((r) => r.serviceId === web!.id)?.value).toBe(3e9);
    // A partial sum is not the service's total disk usage.
    expect(rows.some((r) => r.serviceId === api!.id)).toBe(false);
    expect(rows.some((r) => r.serviceId === none!.id)).toBe(false);
  });

  it('a service none of whose volumes could be measured gets no sample (never a false zero)', async () => {
    await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', volumeMount: '/data' } as never);
    const [onNode] = await db.insert(servers).values({ name: 'edge', host: '198.51.100.4', port: 4600, tokenEncrypted: 'x', status: 'online' }).returning();
    await db.insert(services).values({ name: 'api', slug: 'api', type: 'docker', serverId: onNode!.id, volumeMount: '/d' } as never);
    expect(await lib.sampleServiceDisk(db, { panelSizes: async () => { throw new Error('daemon down'); }, nodeSize: async () => { throw new Error('unreachable'); } }, NOW)).toBe(0);
    // Without a node measure, a node service is skipped too; the default panel read uses docker system df.
    h.df = JSON.stringify([{ Name: 'nd-svc-web-data', Size: '1GB' }]);
    expect(await lib.sampleServiceDisk(db, {}, NOW)).toBe(1);
    expect(await disk()).toEqual([{ serviceId: expect.any(Number), value: 1e9 }]);
  });

  it('a node volume is measured through the agent; anything unclear is null', async () => {
    const { measureNodeVolume } = await import('../../src/lib/nodeVolumes.js');
    const op = (exitCode: number, lines: string[]) => vi.fn(async () => ({ exitCode, lines }));
    expect(await measureNodeVolume(db, 1, 'v', op(0, ['noise', '4096\t/v']))).toBe(4096);
    expect(await measureNodeVolume(db, 1, 'v', op(1, ['4096']))).toBeNull();
    expect(await measureNodeVolume(db, 1, 'v', op(0, ['x']))).toBeNull();
    expect(await measureNodeVolume(db, 1, 'v', vi.fn(async () => { throw new Error('unreachable'); }))).toBeNull();
  });

  it('nothing to sample without volumes', async () => {
    await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker' } as never);
    expect(await lib.sampleServiceDisk(db)).toBe(0);
  });
});
