import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { createDb, deploymentReleaseRecords, deployments, services, type DB } from '@ninedeploy/db';
import { createComposeRelease } from '../src/lib/composeRelease.js';
import { storeReleaseRecord } from '../src/lib/releaseRecords.js';
import { listReleaseImages, pruneReleaseImages, retainedReleaseImageIds } from '../src/lib/releaseImageRetention.js';
import { executeAutoPrune } from '../src/engine/autoPrune.js';

const h = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn() }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture, run: h.run }));
const ids = ['a', 'b', 'c', 'd'].map(c => `sha256:${c.repeat(64)}`);
const inventory = ids.map((ID, i) => ({ ID, Repository: i % 2 ? '<none>' : 'fixture', Tag: i % 2 ? '<none>' : String(i), Size: '1MB', CreatedAt: '2020-01-01T00:00:00Z' }));
let db: DB;
let close: () => void;
let serviceId: number;
let deploymentId: number;
const record = () => createComposeRelease({ serviceId, slug: 'retained', runtimeId: 'ndcmp-retained-web-1', composeService: 'web', port: 80, healthPath: '/' }, JSON.stringify({ services: { web: { environment: { TOKEN: 'private-release-token' } }, worker: {} } }), { web: ids[0]!, worker: ids[1]! });

beforeEach(async () => {
  vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'c'.repeat(64));
  vi.stubEnv('NINEDEPLOY_MASTER_KEYS', '');
  const created = createDb({ url: 'file::memory:' });
  db = created.db;
  close = () => created.client?.close();
  await created.ready;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)) });
  const [service] = await db.insert(services).values({ name: 'Retained', slug: 'retained', type: 'compose' }).returning();
  serviceId = service!.id;
  const [dep] = await db.insert(deployments).values({ serviceId, status: 'superseded' }).returning();
  deploymentId = dep!.id;
  await storeReleaseRecord(db, deploymentId, record());
  h.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'image' && args[1] === 'ls') return inventory.map(i => JSON.stringify(i)).join('\n');
    if (args[0] === 'ps') return '';
    if (args[0] === 'image' && args[1] === 'prune') return 'Total reclaimed space: 4MB';
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
  h.run.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { close(); vi.unstubAllEnvs(); });

describe('recorded release image retention', () => {
  it('shows protection separately from container use without exposing release secrets', async () => {
    const images = await listReleaseImages(db);
    expect(images.map(i => [i.inUse, i.releaseProtected])).toEqual([[false, true], [false, true], [false, false], [false, false]]);
    expect(JSON.stringify(images)).not.toContain('private-release-token');
    expect(h.capture).toHaveBeenCalledWith('docker', ['image', 'ls', '--no-trunc', '--format', '{{json .}}'], { timeoutMs: 30_000 });
  });

  it.each([false, true])('protects tagged and untagged images in dry-run and deletion (dangling=%s)', async danglingOnly => {
    const opts = { danglingOnly, olderThanHours: 1 };
    const dry = await pruneReleaseImages(db, { ...opts, dryRun: true });
    expect(dry.removed).toEqual([ids[danglingOnly ? 3 : 2]]);
    expect(h.run).not.toHaveBeenCalled();
    const actual = await pruneReleaseImages(db, opts);
    expect(actual.removed).toEqual(dry.removed);
    expect(h.run.mock.calls[0]![1]).toEqual(['image', 'rm', ...dry.removed]);
    expect(h.capture.mock.calls.some(([, args]) => args[1] === 'prune')).toBe(false);
  });

  it('applies the same protection to age-filtered automatic cleanup', async () => {
    const runner = async (cmd: string, args: string[]) => {
      if (args[0] === 'image' && args[1] === 'rm') { await h.run(cmd, args); return { stdout: '', stderr: '' }; }
      return { stdout: await h.capture(cmd, args), stderr: '' };
    };
    const result = await executeAutoPrune(db, { maxAgeHours: 0, pruneImages: true, pruneBuildCache: false, pruneContainers: false, pruneVolumes: false }, runner);
    expect(result.freedBytes).toBe(2 * 1024 * 1024);
    expect(h.run.mock.calls[0]![1]).toEqual(['image', 'rm', ids[2], ids[3]]);
  });

  it('keeps a copied queued restore protected after source deletion, then releases it with its final record', async () => {
    const [copy] = await db.insert(deployments).values({ serviceId, status: 'queued', restoredFromDeploymentId: deploymentId }).returning();
    await storeReleaseRecord(db, copy!.id, record());
    await db.delete(deployments).where(eq(deployments.id, deploymentId));
    expect(await retainedReleaseImageIds(db)).toEqual(new Set(ids.slice(0, 2)));
    await db.delete(deployments).where(eq(deployments.id, copy!.id));
    expect(await retainedReleaseImageIds(db)).toEqual(new Set());
    await pruneReleaseImages(db, { includeDangling: true, olderThanHours: 0 });
    expect(h.capture).toHaveBeenCalledWith('docker', ['image', 'prune', '-af', '--filter', 'until=0h'], { timeoutMs: 60_000 });
  });

  it('refuses cleanup before Docker is called when any encrypted record is unreadable', async () => {
    await db.update(deploymentReleaseRecords).set({ payloadEncrypted: 'corrupt-secret-payload' });
    await expect(pruneReleaseImages(db, { danglingOnly: true })).rejects.toThrow('Image cleanup refused');
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    const result = await executeAutoPrune(db, { pruneImages: true, pruneBuildCache: false, pruneContainers: false, pruneVolumes: false });
    expect(result.details.imagesFreed).toBe('Prune images failed or skipped');
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('paginates retained records instead of silently ignoring later history', async () => {
    for (let i = 0; i < 33; i++) {
      const [dep] = await db.insert(deployments).values({ serviceId, status: 'failed' }).returning();
      await storeReleaseRecord(db, dep!.id, record());
    }
    expect(await retainedReleaseImageIds(db)).toEqual(new Set(ids.slice(0, 2)));
    const rows = await db.query.deploymentReleaseRecords.findMany({ orderBy: (t, { desc }) => desc(t.id), limit: 1 });
    await db.update(deploymentReleaseRecords).set({ payloadEncrypted: 'corrupt-last-page' }).where(eq(deploymentReleaseRecords.id, rows[0]!.id));
    await expect(retainedReleaseImageIds(db)).rejects.toThrow('Image cleanup refused');
  });

  it('serializes record publication with an in-flight cleanup and releases the lock after failure', async () => {
    let entered!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    h.capture.mockImplementationOnce(async () => { entered(); await gate; throw new Error('daemon unavailable'); });
    const prune = pruneReleaseImages(db, { danglingOnly: true }).catch(e => e as Error);
    await waiting;
    const [dep] = await db.insert(deployments).values({ serviceId, status: 'queued' }).returning();
    let stored = false;
    const save = storeReleaseRecord(db, dep!.id, record()).then(() => { stored = true; });
    await Promise.resolve();
    expect(stored).toBe(false);
    resume();
    expect(await prune).toBeInstanceOf(Error);
    await save;
    expect(stored).toBe(true);
    expect(await db.query.deploymentReleaseRecords.findMany()).toHaveLength(2);
  });
});
