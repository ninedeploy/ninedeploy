/**
 * 0.14 — `/v1/databases/:id/imports` against a real migrated SQLite: the
 * chunked upload (order, size, idempotent last chunk, the creator rule, the
 * route-level body limit, the encapsulated octet-stream parser that leaves
 * the root rawBody parser alone), the S3 source (operator only, prefix and
 * size checks), start (202 + the job, refusals that fail the row), cancel,
 * and the listing. The job itself is mocked here (test/lib/databaseImport.test.ts).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupDestinations,
  createDb,
  databaseImports,
  databases,
  type DB,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from '@ninedeploy/db';
import { DATABASE_IMPORT_CHUNK_SIZE } from '@ninedeploy/schemas';

vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));

const m = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  runImportJob: vi.fn(async () => undefined),
  downloadS3Import: vi.fn(async () => undefined),
  sandbox: vi.fn(async (): Promise<string | null> => '--sandbox'),
  s3Request: vi.fn(),
}));
vi.mock('../../src/lib/audit.js', () => ({ audit: m.audit }));
vi.mock('../../src/lib/databaseImport.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/databaseImport.js')>()),
  runImportJob: m.runImportJob,
  downloadS3Import: m.downloadS3Import,
}));
vi.mock('../../src/engine/database.js', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/database.js')>()),
  probeMysqlSandboxFlag: m.sandbox,
}));
vi.mock('../../src/lib/s3.js', async (orig) => ({ ...(await orig<typeof import('../../src/lib/s3.js')>()), s3Request: m.s3Request }));

const { databaseImportRoutes } = await import('../../src/modules/databaseImports.js');
const { asUser, buildTestApp } = await import('../helpers.js');
const { encrypt } = await import('../../src/lib/crypto.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'nd-import-routes-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ADMIN = 2;
const ADMIN2 = 3;
const VIEWER = 4;
const OUTSIDER = 5;
const OPERATOR = 6;
const CHUNK = 4;

let db: DB;
let close: () => void;
let pg: number;
let stagingDir: string;
let app: FastifyInstance;
let seq = 0;

async function newDb(engine: string, over: Record<string, unknown> = {}) {
  const [project] = await db.select().from(projects);
  const [row] = await db
    .insert(databases)
    .values({ name: `${engine}${++seq}`, slug: `${engine}${seq}`, engine: engine as never, status: 'running', containerName: `nd-db-${seq}`, passwordEncrypted: 'v1:x', projectId: project!.id, ...over })
    .returning();
  return row!.id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  m.sandbox.mockResolvedValue('--sandbox');
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([1, ADMIN, ADMIN2, VIEWER, OUTSIDER, OPERATOR].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x' })));
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: 1 }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, userId: ADMIN, role: 'admin' },
    { workspaceId: ws!.id, userId: ADMIN2, role: 'admin' },
    { workspaceId: ws!.id, userId: VIEWER, role: 'viewer' },
  ]);
  await db.insert(projects).values({ name: 'P', slug: 'p', workspaceId: ws!.id });
  pg = await newDb('postgres');
  stagingDir = mkdtempSync(path.join(root, 'staging-'));
  app = await buildTestApp({ db, rawBody: true });
  await app.register(databaseImportRoutes, { prefix: '/databases', chunkSize: CHUNK, stagingDir, maxBytes: 1000 });
});
afterEach(async () => {
  await app.close();
  close();
});

const member = (id: number) => asUser({ id, isOperator: false, role: 'member' });
const operator = asUser({ id: OPERATOR, isOperator: true });
const create = (body: unknown, headers = member(ADMIN), id = pg) =>
  app.inject({ method: 'POST', url: `/databases/${id}/imports`, headers, payload: body as object });
const chunk = (importId: number, index: number, data: string | Buffer, headers = member(ADMIN), id = pg) =>
  app.inject({
    method: 'PUT',
    url: `/databases/${id}/imports/${importId}/chunks/${index}`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: Buffer.isBuffer(data) ? data : Buffer.from(data),
  });
const start = (importId: number, headers = member(ADMIN), id = pg) =>
  app.inject({ method: 'POST', url: `/databases/${id}/imports/${importId}/start`, headers });
const row = async (id: number) => (await db.query.databaseImports.findFirst({ where: eq(databaseImports.id, id) }))!;
const actions = () => m.audit.mock.calls.map((c) => c[2]);

async function upload(content: string, headers = member(ADMIN), id = pg) {
  const res = await create({ source: 'upload', sizeBytes: Buffer.byteLength(content), filename: 'dump.sql' }, headers, id);
  expect(res.statusCode).toBe(201);
  const importId = res.json().id as number;
  const buf = Buffer.from(content);
  for (let i = 0; i * CHUNK < buf.length; i++) {
    const put = await chunk(importId, i, buf.subarray(i * CHUNK, (i + 1) * CHUNK), headers, id);
    expect(put.statusCode).toBe(200);
  }
  return importId;
}

describe('upload', () => {
  it('creates a staging file the server names, takes chunks in order and completes', async () => {
    const res = await create({ source: 'upload', sizeBytes: 10, filename: '../../etc/passwd', sha256: 'AB'.repeat(32) });
    expect(res.statusCode).toBe(201);
    const view = res.json();
    expect(view).toMatchObject({ source: 'upload', status: 'uploading', sizeBytes: 10, receivedBytes: 0, chunkSize: CHUNK, options: { singleTransaction: true } });
    expect(view).not.toHaveProperty('stagingPath');
    const stored = await row(view.id);
    expect(stored.stagingPath).toBe(path.join(stagingDir, `${view.id}.part`));
    if (process.platform !== 'win32') expect(statSync(stored.stagingPath!).mode & 0o777).toBe(0o600);
    expect(actions()).toEqual(['database.import.create']);

    expect((await chunk(view.id, 1, 'abcd')).statusCode).toBe(409); // out of order
    expect((await chunk(view.id, 0, 'abc')).statusCode).toBe(400); // short
    expect((await chunk(view.id, 0, 'abcd')).json()).toMatchObject({ receivedBytes: 4, status: 'uploading' });
    // Re-sending the last chunk is idempotent.
    expect((await chunk(view.id, 0, 'abcd')).json()).toMatchObject({ receivedBytes: 4 });
    expect((await chunk(view.id, 0, 'abcdx')).statusCode).toBe(409);
    expect((await chunk(view.id, 1, 'efgh')).statusCode).toBe(200);
    expect((await chunk(view.id, 2, 'ijk')).statusCode).toBe(400); // last chunk is 2 bytes
    const last = await chunk(view.id, 2, 'ij');
    expect(last.json()).toMatchObject({ receivedBytes: 10, status: 'pending' });
    // …and still idempotent once the upload is complete.
    expect((await chunk(view.id, 2, 'ij')).json()).toMatchObject({ status: 'pending' });
    expect((await chunk(view.id, 3, 'kl')).statusCode).toBe(409);
    expect(readFileSync(stored.stagingPath!, 'utf8')).toBe('abcdefghij');
    expect(actions()).toEqual(['database.import.create', 'database.import.upload']);
  });

  it('refuses a malformed index and a non-octet-stream body', async () => {
    const { id } = (await create({ source: 'upload', sizeBytes: 4 })).json();
    expect((await chunk(id, -1 as never, 'abcd')).statusCode).toBe(400);
    const json = await app.inject({ method: 'PUT', url: `/databases/${pg}/imports/${id}/chunks/0`, headers: member(ADMIN), payload: { a: 1 } });
    expect(json.statusCode).toBe(415);
  });

  it('only the creator may upload or start; viewers and outsiders get nothing', async () => {
    const { id } = (await create({ source: 'upload', sizeBytes: 4 })).json();
    expect((await chunk(id, 0, 'abcd', member(ADMIN2))).statusCode).toBe(403);
    expect((await chunk(id, 0, 'abcd', member(VIEWER))).statusCode).toBe(403);
    expect((await chunk(id, 0, 'abcd', member(OUTSIDER))).statusCode).toBe(404);
    expect((await start(id, member(ADMIN2))).statusCode).toBe(403);
    expect((await create({ source: 'upload', sizeBytes: 4 }, member(VIEWER))).statusCode).toBe(403);
    expect((await create({ source: 'upload', sizeBytes: 4 }, member(OUTSIDER))).statusCode).toBe(404);
    expect((await row(id)).receivedBytes).toBe(0);
  });

  it('an import id under another database is not found', async () => {
    const { id } = (await create({ source: 'upload', sizeBytes: 4 })).json();
    const other = await newDb('postgres');
    expect((await app.inject({ method: 'GET', url: `/databases/${other}/imports/${id}`, headers: member(ADMIN) })).statusCode).toBe(404);
    expect((await chunk(id, 0, 'abcd', member(ADMIN), other)).statusCode).toBe(404);
  });

  it('refuses sizes over NINEDEPLOY_IMPORT_MAX_BYTES, unsupported engines and stray options', async () => {
    expect((await create({ source: 'upload', sizeBytes: 1001 })).statusCode).toBe(413);
    const ch = await newDb('clickhouse');
    expect((await create({ source: 'upload', sizeBytes: 4 }, member(ADMIN), ch)).statusCode).toBe(422);
    expect((await create({ source: 'upload', sizeBytes: 4, options: { drop: true } })).statusCode).toBe(422);
    const redis = await newDb('redis');
    expect((await create({ source: 'upload', sizeBytes: 4 }, member(ADMIN), redis)).statusCode).toBe(422);
    expect((await create({ source: 'upload', sizeBytes: 4, options: { confirmReplace: true } }, member(ADMIN), redis)).statusCode).toBe(201);
    expect((await create({ source: 'upload', sizeBytes: 4, options: { bogus: true } })).statusCode).toBe(400);
    expect(await db.select().from(databaseImports)).toHaveLength(1);
  });

  it('lets only an operator, or a database created minutes ago, skip the safety backup', async () => {
    const old = await newDb('postgres', { initializedAt: new Date(Date.now() - 3_600_000) });
    const fresh = await newDb('postgres', { initializedAt: new Date() });
    const body = { source: 'upload', sizeBytes: 4, options: { skipSafetyBackup: true } };
    expect((await create(body, member(ADMIN), old)).statusCode).toBe(403);
    expect((await create(body, member(ADMIN), fresh)).statusCode).toBe(201);
    expect((await create(body, operator, old)).statusCode).toBe(201);
  });
});

describe('body parsing', () => {
  it('has a route-level body limit of one chunk + 1 KiB', async () => {
    const big = await buildTestApp({ db, rawBody: true });
    await big.register(databaseImportRoutes, { prefix: '/databases', stagingDir, maxBytes: 64 * 1024 * 1024 });
    const { id } = (
      await big.inject({ method: 'POST', url: `/databases/${pg}/imports`, headers: member(ADMIN), payload: { source: 'upload', sizeBytes: DATABASE_IMPORT_CHUNK_SIZE * 2 } })
    ).json();
    const put = (bytes: number) =>
      big.inject({
        method: 'PUT',
        url: `/databases/${pg}/imports/${id}/chunks/0`,
        headers: { ...member(ADMIN), 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(bytes, 1),
      });
    expect((await put(DATABASE_IMPORT_CHUNK_SIZE + 1024 + 1)).statusCode).toBe(413);
    expect((await put(DATABASE_IMPORT_CHUNK_SIZE)).statusCode).toBe(200);
    await big.close();
  });

  it('swaps the octet-stream parser inside its own scope only: sibling routes keep the root parser', async () => {
    const sib = await buildTestApp({ db, rawBody: true });
    const report = async (req: { body: unknown }) => ({ isBuffer: Buffer.isBuffer(req.body), type: typeof req.body });
    sib.post('/sibling', report);
    await sib.register(databaseImportRoutes, { prefix: '/databases', chunkSize: CHUNK, stagingDir });
    await sib.register(async (scope) => {
      scope.post('/after', report);
    });
    const send = (url: string) =>
      sib.inject({ method: 'POST', url, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from([0xff, 0x00, 0x41]) });
    // The root rawBody parser hands a latin1 string to everyone else (system import relies on it).
    expect((await send('/sibling')).json()).toEqual({ isBuffer: false, type: 'string' });
    expect((await send('/after')).json()).toEqual({ isBuffer: false, type: 'string' });
    // The chunk route gets the exact bytes.
    const { id } = (await sib.inject({ method: 'POST', url: `/databases/${pg}/imports`, headers: member(ADMIN), payload: { source: 'upload', sizeBytes: 3 } })).json();
    const put = await sib.inject({
      method: 'PUT',
      url: `/databases/${pg}/imports/${id}/chunks/0`,
      headers: { ...member(ADMIN), 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0xff, 0x00, 0x41]),
    });
    expect(put.statusCode).toBe(200);
    expect([...readFileSync((await row(id)).stagingPath!)]).toEqual([0xff, 0x00, 0x41]);
    await sib.close();
  });

  it('authenticates before reading a body', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/databases/${pg}/imports/1/chunks/0`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(CHUNK + 4096),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('S3 source', () => {
  let dest: number;
  beforeEach(async () => {
    const [d] = await db
      .insert(backupDestinations)
      .values({ name: 'R2', endpoint: 'https://r2.invalid', bucket: 'b', prefix: 'ninedeploy', accessKeyId: 'k', secretKeyEncrypted: encrypt('s') })
      .returning();
    dest = d!.id;
  });
  const head = (status: number, length?: number) =>
    m.s3Request.mockResolvedValue(new Response(null, { status, headers: length === undefined ? {} : { 'content-length': String(length) } }));

  it('is operator-only: an admin sending an S3 body gets 403, before any network call', async () => {
    const res = await create({ source: 's3', destinationId: dest, key: 'ninedeploy/a.sql' }, member(ADMIN));
    expect(res.statusCode).toBe(403);
    expect(m.s3Request).not.toHaveBeenCalled();
    expect(await db.select().from(databaseImports)).toHaveLength(0);
  });

  it('checks the destination, the key prefix and the object size, then downloads in the background', async () => {
    expect((await create({ source: 's3', destinationId: 9999, key: 'ninedeploy/a.sql' }, operator)).statusCode).toBe(404);
    expect((await create({ source: 's3', destinationId: dest, key: 'other/a.sql' }, operator)).statusCode).toBe(422);
    expect((await create({ source: 's3', destinationId: dest, key: 'ninedeploy/../a.sql' }, operator)).statusCode).toBe(422);
    head(404);
    expect((await create({ source: 's3', destinationId: dest, key: 'ninedeploy/missing.sql' }, operator)).statusCode).toBe(404);
    head(403);
    expect((await create({ source: 's3', destinationId: dest, key: 'ninedeploy/a.sql' }, operator)).statusCode).toBe(502);
    m.s3Request.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await create({ source: 's3', destinationId: dest, key: 'ninedeploy/a.sql' }, operator)).statusCode).toBe(502);
    head(200, 0);
    expect((await create({ source: 's3', destinationId: dest, key: 'ninedeploy/a.sql' }, operator)).statusCode).toBe(422);
    head(200, 5000);
    expect((await create({ source: 's3', destinationId: dest, key: 'ninedeploy/a.sql' }, operator)).statusCode).toBe(413);
    head(200, 42);
    const ok = await create({ source: 's3', destinationId: dest, key: 'ninedeploy/a.sql' }, operator);
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ source: 's3', status: 'uploading', sizeBytes: 42, destinationId: dest, objectKey: 'ninedeploy/a.sql' });
    expect(m.s3Request).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: 'b', secretAccessKey: 's' }), 'HEAD', 'ninedeploy/a.sql');
    expect(m.downloadS3Import).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), OPERATOR, 'database.import.create', expect.any(String), expect.objectContaining({ source: 's3', key: 'ninedeploy/a.sql' }));
  });

  it('chunks are refused for an S3 import', async () => {
    head(200, 4);
    const { id } = (await create({ source: 's3', destinationId: dest, key: 'ninedeploy/a.sql' }, operator)).json();
    expect((await chunk(id, 0, 'abcd', operator)).statusCode).toBe(409);
  });
});

describe('start', () => {
  it('answers 202 and starts the job with the caller and the sandbox flag', async () => {
    const id = await upload('SELECT 1;\n');
    const res = await start(id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'running', format: 'pg_plain' });
    expect((await row(id)).startedAt).toBeInstanceOf(Date);
    expect(m.runImportJob).toHaveBeenCalledWith(db, id, expect.objectContaining({ actorId: ADMIN, isOperator: false, sandboxFlag: null }));
    expect(actions()).toContain('database.import.start');
    // Not twice.
    expect((await start(id)).statusCode).toBe(409);
  });

  it('refuses an unfinished upload and a stopped database without failing the import', async () => {
    const { id } = (await create({ source: 'upload', sizeBytes: 8 })).json();
    expect((await start(id)).statusCode).toBe(409);
    const stopped = await newDb('postgres', { status: 'stopped' });
    const done = await upload('SELECT 1;', member(ADMIN), stopped);
    expect((await start(done, member(ADMIN), stopped)).statusCode).toBe(409);
    expect((await row(done)).status).toBe('pending');
  });

  it('refuses an envelope from a non-operator: 422, the import fails and the file is deleted', async () => {
    const id = await upload('NDBK1:v1:abc\nxyz');
    const staging = (await row(id)).stagingPath!;
    const res = await start(id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/encrypted NineDeploy backup/);
    expect(await row(id)).toMatchObject({ status: 'failed', stagingPath: null });
    expect(existsSync(staging)).toBe(false);
    expect(actions()).toContain('database.import.fail');
    expect(m.runImportJob).not.toHaveBeenCalled();
  });

  it('lets an operator start an envelope import (decrypted in the job)', async () => {
    const id = await upload('NDBK1:v1:abc\nxyz', operator);
    const res = await start(id, operator);
    expect(res.statusCode).toBe(202);
    expect(res.json().format).toBeNull();
  });

  it('refuses formats the engine cannot take, and clean on plain SQL', async () => {
    const tar = Buffer.alloc(300);
    tar.write('ustar', 257, 'latin1');
    const tarId = await upload(tar.toString('latin1'));
    // latin1 round-trip: write the exact bytes the sniff expects.
    expect((await start(tarId)).statusCode).toBe(422);
    const mongo = await newDb('mongo');
    const sqlIntoMongo = await upload('SELECT 1;', member(ADMIN), mongo);
    expect((await start(sqlIntoMongo, member(ADMIN), mongo)).json().error.message).toMatch(/mongodump --archive/);
    const { id } = (await create({ source: 'upload', sizeBytes: 4, options: { clean: true } })).json();
    await chunk(id, 0, 'SEL;');
    expect((await start(id)).json().error.message).toMatch(/options.clean/);
  });

  it('mysql without a sandbox flag: refused for an admin, allowed for an operator', async () => {
    m.sandbox.mockResolvedValue(null);
    const my = await newDb('mysql');
    const adminImport = await upload('SELECT 1;', member(ADMIN), my);
    const refused = await start(adminImport, member(ADMIN), my);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toMatch(/no sandbox flag/);
    const opImport = await upload('SELECT 1;', operator, my);
    expect((await start(opImport, operator, my)).statusCode).toBe(202);
    expect(m.runImportJob).toHaveBeenCalledWith(db, opImport, expect.objectContaining({ isOperator: true, sandboxFlag: null }));
    m.sandbox.mockResolvedValue('--system-command=OFF');
    const flagged = await upload('SELECT 1;', member(ADMIN), my);
    expect((await start(flagged, member(ADMIN), my)).statusCode).toBe(202);
    expect(m.runImportJob).toHaveBeenLastCalledWith(db, flagged, expect.objectContaining({ sandboxFlag: '--system-command=OFF' }));
  });

  it('re-checks the safety-backup rule at start', async () => {
    const fresh = await newDb('postgres', { initializedAt: new Date() });
    const { id } = (await create({ source: 'upload', sizeBytes: 4, options: { skipSafetyBackup: true } }, member(ADMIN), fresh)).json();
    await chunk(id, 0, 'SEL;', member(ADMIN), fresh);
    await db.update(databases).set({ initializedAt: new Date(Date.now() - 3_600_000) }).where(eq(databases.id, fresh));
    expect((await start(id, member(ADMIN), fresh)).statusCode).toBe(403);
    expect((await row(id)).status).toBe('pending');
  });
});

describe('cancel and listing', () => {
  it('cancels an uploading or pending import and deletes its file; nothing else', async () => {
    const id = await upload('SELECT 1;');
    const staging = (await row(id)).stagingPath!;
    const res = await app.inject({ method: 'DELETE', url: `/databases/${pg}/imports/${id}`, headers: member(ADMIN2) });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect(existsSync(staging)).toBe(false);
    expect(actions()).toContain('database.import.cancel');
    expect((await app.inject({ method: 'DELETE', url: `/databases/${pg}/imports/${id}`, headers: member(ADMIN) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/databases/${pg}/imports/${id}`, headers: member(VIEWER) })).statusCode).toBe(403);
  });

  it('lists newest first for a database admin only', async () => {
    const a = (await create({ source: 'upload', sizeBytes: 4 })).json().id;
    const b = (await create({ source: 'upload', sizeBytes: 4 })).json().id;
    const list = await app.inject({ method: 'GET', url: `/databases/${pg}/imports`, headers: member(ADMIN) });
    expect(list.json().map((r: { id: number }) => r.id)).toEqual([b, a]);
    expect((await app.inject({ method: 'GET', url: `/databases/${pg}/imports`, headers: member(VIEWER) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/databases/${pg}/imports/${a}`, headers: member(ADMIN) })).json().id).toBe(a);
    expect((await app.inject({ method: 'GET', url: `/databases/${pg}/imports/abc`, headers: member(ADMIN) })).statusCode).toBe(400);
  });
});
