/**
 * A1 — `/v1/services/:id/volume-imports` against a real migrated SQLite: who
 * may import (operators, on a service they can see), which services can take
 * one, the chunked upload, the start checks (running service, deployment in
 * flight, not a gzipped tar), cancel; and the job (sha256, the pre-import
 * snapshot, failure recording) plus recovery and the staging sweep, with the
 * engine's docker calls injected.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backups, createDb, type DB, deployments, serviceTargets, servers, services, users, volumeImports } from '@ninedeploy/db';

vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
const m = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/audit.js', () => ({ audit: m.audit }));

const { volumeImportRoutes, volumeImportRefusal } = await import('../../src/modules/volumeImports.js');
const lib = await import('../../src/lib/volumeImport.js');
const { asUser, buildTestApp } = await import('../helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'nd-volume-import-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const OWNER = 2;
const OPERATOR = 6;
const CHUNK = 64;

/** A real gzipped tar header block (ustar magic at 257), so the start sniff sees a tar. */
function tarGz(): Buffer {
  const block = Buffer.alloc(1024);
  block.write('hello.txt', 0);
  block.write('ustar', 257);
  return gzipSync(block);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let db: DB;
let close: () => void;
let app: FastifyInstance;
let stagingDir: string;
let svc: number;
const runJob = vi.fn(async () => undefined);
const isRunning = vi.fn(async () => false);

async function newService(over: Record<string, unknown> = {}) {
  const n = Math.random().toString(36).slice(2, 8);
  const [row] = await db.insert(services).values({ name: `s${n}`, slug: `s${n}`, type: 'docker', image: 'nginx:1', volumeMount: '/data', ownerUserId: OWNER, ...over } as never).returning();
  return row!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  isRunning.mockResolvedValue(false);
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([1, OWNER, OPERATOR].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x' })));
  svc = (await newService({ slug: 'shop', name: 'shop' })).id;
  stagingDir = mkdtempSync(path.join(root, 'staging-'));
  app = await buildTestApp({ db, rawBody: true });
  await app.register(volumeImportRoutes, { prefix: '/services', chunkSize: CHUNK, stagingDir, maxBytes: 100_000, runJob, isRunning });
});
afterEach(async () => {
  await app.close();
  close();
});

const operator = asUser({ id: OPERATOR, isOperator: true });
const owner = asUser({ id: OWNER, isOperator: false, role: 'member' });
const create = (body: unknown, headers = operator, id = svc) => app.inject({ method: 'POST', url: `/services/${id}/volume-imports`, headers, payload: body as object });
const chunk = (importId: number, index: number, data: Buffer, headers = operator, id = svc) =>
  app.inject({ method: 'PUT', url: `/services/${id}/volume-imports/${importId}/chunks/${index}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: data });
const start = (importId: number, headers = operator, id = svc) => app.inject({ method: 'POST', url: `/services/${id}/volume-imports/${importId}/start`, headers });
const row = async (id: number) => (await db.query.volumeImports.findFirst({ where: eq(volumeImports.id, id) }))!;

async function uploaded(file = tarGz(), id = svc) {
  const res = await create({ sizeBytes: file.length, sha256: sha(file), filename: 'shop.tar.gz' }, operator, id);
  expect(res.statusCode).toBe(201);
  const imp = res.json() as { id: number };
  for (let i = 0; i * CHUNK < file.length; i++) expect((await chunk(imp.id, i, file.subarray(i * CHUNK, (i + 1) * CHUNK), operator, id)).statusCode).toBe(200);
  return imp.id;
}

describe('volume import routes', () => {
  it('is for operators only, on a service they can see', async () => {
    expect((await create({ sizeBytes: 10, sha256: 'a'.repeat(64) }, owner)).statusCode).toBe(403);
    expect((await create({ sizeBytes: 10, sha256: 'a'.repeat(64) }, operator, 99999)).statusCode).toBe(404);
    expect((await create({ sizeBytes: 10 })).statusCode).toBe(400);
    expect((await create({ sizeBytes: 10, sha256: 'xyz' })).statusCode).toBe(400);
    expect((await create({ sizeBytes: 1_000_000, sha256: 'a'.repeat(64) })).statusCode).toBe(413);
  });

  it('names the data volume itself, never from the request', async () => {
    const res = await create({ sizeBytes: 10, sha256: 'A'.repeat(64), volumeName: 'nd-db-x' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ volumeName: 'nd-svc-shop-data', status: 'uploading', sha256: 'a'.repeat(64), chunkSize: CHUNK, safetyBackupId: null });
    expect(existsSync((await row(res.json().id)).stagingPath!)).toBe(true);
    expect((await row(res.json().id)).stagingPath!.startsWith(stagingDir)).toBe(true);
  });

  it('refuses services whose data volume is not one volume on the panel host', async () => {
    expect(volumeImportRefusal({ type: 'compose', orchestrator: null, volumeMount: '/d', serverId: null } as never, false)).toMatch(/docker services/);
    expect(volumeImportRefusal({ type: 'docker', orchestrator: 'swarm', volumeMount: '/d', serverId: null } as never, false)).toMatch(/Swarm/);
    expect(volumeImportRefusal({ type: 'docker', orchestrator: null, volumeMount: null, serverId: null } as never, false)).toMatch(/no data volume/);
    expect(volumeImportRefusal({ type: 'docker', orchestrator: null, volumeMount: '/d', serverId: 3 } as never, false)).toMatch(/on a node/);
    expect(volumeImportRefusal({ type: 'docker', orchestrator: null, volumeMount: '/d', serverId: null } as never, true)).toMatch(/several hosts/);
    expect(volumeImportRefusal({ type: 'docker', orchestrator: null, volumeMount: '/d', serverId: null } as never, false)).toBeNull();
    const bare = await newService({ volumeMount: null });
    const res = await create({ sizeBytes: 10, sha256: 'a'.repeat(64) }, operator, bare.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('volume_import_unsupported');
    const [node] = await db.insert(servers).values({ name: 'n1', host: '10.0.0.2', tokenEncrypted: 'v1:x' } as never).returning();
    const spread = await newService();
    await db.insert(serviceTargets).values({ serviceId: spread.id, serverId: node!.id } as never);
    expect((await create({ sizeBytes: 10, sha256: 'a'.repeat(64) }, operator, spread.id)).statusCode).toBe(422);
  });

  it('takes chunks in order, retries idempotently, and starts the job', async () => {
    const file = tarGz();
    const created = (await create({ sizeBytes: file.length, sha256: sha(file) })).json() as { id: number };
    expect((await chunk(created.id, 1, file.subarray(CHUNK, 2 * CHUNK))).statusCode).toBe(409);
    expect((await chunk(created.id, 0, file.subarray(0, 3))).statusCode).toBe(400);
    expect((await chunk(created.id, 0, file.subarray(0, CHUNK))).statusCode).toBe(200);
    expect((await chunk(created.id, 0, file.subarray(0, CHUNK))).statusCode).toBe(200);
    expect((await chunk(created.id, Number('1e3') as never, file)).statusCode).toBeGreaterThanOrEqual(400);
    for (let i = 1; i * CHUNK < file.length; i++) await chunk(created.id, i, file.subarray(i * CHUNK, (i + 1) * CHUNK));
    expect((await row(created.id)).status).toBe('pending');
    const last = Math.ceil(file.length / CHUNK) - 1;
    expect((await chunk(created.id, last, file.subarray(last * CHUNK))).statusCode).toBe(200);
    const res = await start(created.id);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('running');
    expect(runJob).toHaveBeenCalledWith(expect.anything(), created.id, expect.objectContaining({ actorId: OPERATOR }));
    expect((await start(created.id)).statusCode).toBe(409);
    expect((await chunk(created.id, 0, file.subarray(0, CHUNK))).statusCode).toBe(409);
  });

  it('refuses to start while the service runs or deploys, and fails a file that is not a gzipped tar', async () => {
    let id = await uploaded();
    await db.update(services).set({ status: 'running' }).where(eq(services.id, svc));
    expect((await start(id)).json().error.code).toBe('volume_import_stop_first');
    await db.update(services).set({ status: 'stopped', runtimeId: 'nd-shop' }).where(eq(services.id, svc));
    isRunning.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await start(id)).statusCode).toBe(409);
    isRunning.mockResolvedValue(false);
    await db.insert(deployments).values({ serviceId: svc, status: 'building' } as never);
    expect((await start(id)).json().error.code).toBe('volume_import_deploying');
    await db.delete(deployments);
    expect((await start(id)).statusCode).toBe(202);

    const notTar = gzipSync(Buffer.from('just text'));
    id = await uploaded(notTar);
    const res = await start(id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/not a gzipped tar/);
    expect(await row(id)).toMatchObject({ status: 'failed', stagingPath: null });
  });

  it('cancels an upload and lists only this service\'s imports; chunks belong to their creator', async () => {
    const id = (await create({ sizeBytes: 10, sha256: 'a'.repeat(64) })).json().id as number;
    const staging = (await row(id)).stagingPath!;
    const other = asUser({ id: 1, isOperator: true });
    expect((await chunk(id, 0, Buffer.alloc(10), other)).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/services/${svc}/volume-imports/${id}`, headers: operator })).json().status).toBe('cancelled');
    expect(existsSync(staging)).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: `/services/${svc}/volume-imports/${id}`, headers: operator })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/services/${svc}/volume-imports`, headers: operator })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/services/${svc}/volume-imports/${id}`, headers: operator })).json().id).toBe(id);
    const elsewhere = await newService();
    expect((await app.inject({ method: 'GET', url: `/services/${elsewhere.id}/volume-imports/${id}`, headers: operator })).statusCode).toBe(404);
  });
});

describe('volume import job', () => {
  const deps = (over: Partial<import('../../src/lib/volumeImport.js').VolumeImportJobDeps> = {}) => ({
    sha256File: vi.fn(async () => 'f'.repeat(64)),
    volumeExists: vi.fn(async () => true),
    backupVolume: vi.fn(async (_n: string, dest: string) => { writeFileSync(dest, 'snap'); }),
    restoreVolume: vi.fn(async () => undefined),
    snapshotFile: vi.fn(() => path.join(root, `snap-${Math.random()}.tar.gz`)),
    ...over,
  });
  async function running(): Promise<number> {
    const staging = path.join(stagingDir, `${Math.random()}.part`);
    writeFileSync(staging, 'x');
    const [r] = await db.insert(volumeImports).values({ serviceId: svc, volumeName: 'nd-svc-shop-data', status: 'running', sizeBytes: 1, sha256: 'f'.repeat(64), stagingPath: staging }).returning();
    return r!.id;
  }

  it('snapshots an existing volume, restores, and records it', async () => {
    const id = await running();
    const d = deps();
    await lib.runVolumeImportJob(db, id, { actorId: OPERATOR }, d);
    const r = await row(id);
    expect(r).toMatchObject({ status: 'completed', stagingPath: null, error: null });
    expect(d.restoreVolume).toHaveBeenCalledWith('nd-svc-shop-data', expect.any(String), expect.any(Function));
    const snap = await db.query.backups.findFirst({ where: eq(backups.id, r.safetyBackupId!) });
    expect(snap).toMatchObject({ scope: 'volumes', volumeName: 'nd-svc-shop-data', label: 'pre-import', status: 'completed', sizeBytes: 4 });
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), OPERATOR, 'volume.import.complete', 'nd-svc-shop-data', expect.anything());
  });

  it('skips the snapshot for a volume that does not exist yet', async () => {
    const id = await running();
    const d = deps({ volumeExists: vi.fn(async () => false) });
    await lib.runVolumeImportJob(db, id, { actorId: OPERATOR }, d);
    expect(d.backupVolume).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'completed', safetyBackupId: null });
  });

  it('touches nothing on a sha256 mismatch or a failed snapshot, and records a failed restore', async () => {
    let id = await running();
    let d = deps({ sha256File: vi.fn(async () => '0'.repeat(64)) });
    await lib.runVolumeImportJob(db, id, { actorId: OPERATOR }, d);
    expect((await row(id)).error).toMatch(/sha256 mismatch/);
    expect(d.restoreVolume).not.toHaveBeenCalled();

    id = await running();
    d = deps({ backupVolume: vi.fn(async () => { throw new Error('disk full'); }) });
    await lib.runVolumeImportJob(db, id, { actorId: OPERATOR }, d);
    expect((await row(id)).error).toMatch(/snapshot before the import failed, so the volume was not touched: disk full/);
    expect(d.restoreVolume).not.toHaveBeenCalled();
    expect((await db.query.backups.findMany()).at(-1)!.status).toBe('failed');

    id = await running();
    d = deps({ restoreVolume: vi.fn(async (_n, _s, log) => { log('tar: corrupt'); throw new Error('exit 1'); }) });
    await lib.runVolumeImportJob(db, id, { actorId: OPERATOR }, d);
    expect(await row(id)).toMatchObject({ status: 'failed', error: 'exit 1 — Restoring the uploaded archive into nd-svc-shop-data | tar: corrupt', stagingPath: null });

    const [gone] = await db.insert(volumeImports).values({ serviceId: svc, volumeName: 'v', status: 'running', sizeBytes: 1, sha256: 'f'.repeat(64) }).returning();
    await lib.runVolumeImportJob(db, gone!.id, { actorId: null }, deps());
    expect((await row(gone!.id)).error).toBe('the uploaded file is gone');
    await lib.runVolumeImportJob(db, 424242, { actorId: null }, deps());
  });

  it('recovers interrupted imports, expires idle ones, prunes old rows and orphan staging', async () => {
    const id = await running();
    expect(await lib.recoverInterruptedVolumeImports(db)).toEqual([id]);
    expect((await row(id)).error).toBe(lib.INTERRUPTED_VOLUME_IMPORT_ERROR);
    const idle = (await create({ sizeBytes: 10, sha256: 'a'.repeat(64) })).json().id as number;
    const later = Date.now() + lib.STALE_VOLUME_IMPORT_MS + 60_000;
    expect(await lib.expireStaleVolumeImports(db, later)).toEqual([idle]);
    expect(await lib.pruneFinishedVolumeImports(db, Date.now() + lib.FINISHED_VOLUME_IMPORT_RETENTION_MS + 60_000)).toBe(2);
    const orphan = path.join(stagingDir, '777.part');
    writeFileSync(orphan, 'x');
    const old = new Date(Date.now() - lib.STALE_VOLUME_IMPORT_MS - 60_000);
    utimesSync(orphan, old, old);
    writeFileSync(path.join(stagingDir, 'notes.txt'), 'x');
    expect(await lib.pruneOrphanVolumeStaging(db, stagingDir)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(await lib.pruneOrphanVolumeStaging(db, path.join(root, 'missing'))).toBe(0);
    expect(lib.safetySnapshotFile('nd-svc-shop-data', new Date('2026-11-11T00:00:00Z'))).toMatch(/volumes[\\/]nd-svc-shop-data[\\/]nd-svc-shop-data-2026-11-11T00-00-00-000Z-pre-import\.tar\.gz$/);
  });
});
