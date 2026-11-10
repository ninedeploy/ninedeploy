import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, databaseImports, databases, projects, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import type { FastifyInstance } from 'fastify';
import { migratedDb, closeMigratedDb } from '../lib/githubAppKit.js';
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
const m = vi.hoisted(() => ({ audit: vi.fn(async (..._args: unknown[]) => {}), job: vi.fn(async () => {}), sandbox: vi.fn<() => Promise<string | null>>(), writeHook: null as null | ((body: unknown, write: () => Promise<unknown>) => Promise<unknown>) }));
vi.mock('../../src/lib/audit.js', () => ({ audit: m.audit }));
vi.mock('../../src/lib/databaseImport.js', async original => ({ ...await original<typeof import('../../src/lib/databaseImport.js')>(), runImportJob: m.job }));
vi.mock('../../src/engine/database.js', async original => ({ ...await original<typeof import('../../src/engine/database.js')>(), probeMysqlSandboxFlag: m.sandbox }));
const { databaseImportRoutes } = await import('../../src/modules/databaseImports.js');
const { buildTestApp, asUser } = await import('../helpers.js');
let db: DB, app: FastifyInstance, root: string, databaseId: number;
const narrow = () => asUser({ id: 2, isOperator: false, role: 'member' });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function owned(file: string) { if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) throw new Error('Unowned fixture path'); return file; }
beforeEach(async () => {
 m.writeHook = null; m.audit.mockClear(); m.job.mockReset().mockResolvedValue(undefined); m.sandbox.mockReset().mockResolvedValue(null);
 root = path.resolve(mkdtempSync(path.join(tmpdir(), 'nd-audit-import-chunk-'))); if (!root.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('nd-audit-import-chunk-')) throw new Error('Unowned root');
 db = await migratedDb(); await db.insert(users).values([{ id: 1, email: 'owner@example.test', passwordHash: 'fixture' }, { id: 2, email: 'creator@example.test', passwordHash: 'fixture', isInstanceOperator: true }]);
 const [ws] = await db.insert(workspaces).values({ name: 'Fixture', slug: 'fixture', ownerId: 1 }).returning(); await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: 2, role: 'admin' }); const [project] = await db.insert(projects).values({ name: 'Fixture', slug: 'fixture', workspaceId: ws!.id }).returning();
 const [d] = await db.insert(databases).values({ name: 'fixture', slug: 'fixture', engine: 'mysql', status: 'running', containerName: 'nd-db-fixture', passwordEncrypted: 'v1:fixture', projectId: project!.id }).returning(); databaseId = d!.id;
 app = await buildTestApp({ db, rawBody: true }); await app.register(databaseImportRoutes, { prefix: '/databases', chunkSize: 10, stagingDir: root, maxBytes: 1000 });
});
afterEach(async () => { await app.close(); closeMigratedDb(db); if (!root.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('nd-audit-import-chunk-')) throw new Error('Refusing unowned cleanup'); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

vi.mock('node:fs/promises', async original => {
 const actual = await original<typeof import('node:fs/promises')>();
 return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
  const file = await actual.open(...args);
  if (args[1] === 'r+') {
   const write = file.write.bind(file);
   vi.spyOn(file, 'write').mockImplementation((async (...parts: Parameters<typeof write>) => {
    const perform = () => write(...parts); return m.writeHook ? m.writeHook(parts[0], perform) : perform();
   }) as typeof write);
  }
  return file;
 } };
});
const a = Buffer.from('SELECT 1;\n'), b = Buffer.from('SELECT 2;\n');
async function createUpload(final = true) {
 const res = await app.inject({ method: 'POST', url: `/databases/${databaseId}/imports`, headers: narrow(), payload: { source: 'upload', sizeBytes: final ? a.length : a.length * 2 } }); expect(res.statusCode).toBe(201); const id = res.json().id as number; const row = (await db.query.databaseImports.findFirst({ where: eq(databaseImports.id, id) }))!; return { id, file: owned(row.stagingPath!) };
}
const put = (id: number, body: Buffer) => app.inject({ method: 'PUT', url: `/databases/${databaseId}/imports/${id}/chunks/0`, headers: { ...narrow(), 'content-type': 'application/octet-stream' }, payload: body });

const chunk = (id: number, index: number, body: Buffer) => app.inject({ method: 'PUT', url: `/databases/${databaseId}/imports/${id}/chunks/${index}`, headers: { ...narrow(), 'content-type': 'application/octet-stream' }, payload: body });
async function snapshotGate() {
 const entered = gate(); const execute = db.$client.execute.bind(db.$client); let armed = false;
 vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof execute>) => {
  const statement = args[0], sql = typeof statement === 'string' ? statement : statement.sql; const result = await execute(...args);
  if (armed && /select .* from "database_imports"/i.test(sql)) entered.release(); return result;
 }) as typeof execute);
 return { entered, arm: () => { armed = true; } };
}
for (const final of [false, true]) for (const identical of [false, true]) it(`queued retry preserves winner and advances once final=${final} identical=${identical}`, async () => {
 const input = await createUpload(final), held = gate(), release = gate(); const observed = await snapshotGate(); let writes = 0;
 m.writeHook = async (_body, perform) => { writes++; const result = await perform(); held.release(); await release.promise; return result; };
 const first = put(input.id, a); let second: ReturnType<typeof put> | undefined;
 try { await held.promise; observed.arm(); second = put(input.id, identical ? a : b); await observed.entered.promise; release.release();
  expect((await first).statusCode).toBe(200); expect((await second).statusCode).toBe(200); expect(writes).toBe(1); expect(readFileSync(input.file)).toEqual(a);
  const row = (await db.query.databaseImports.findFirst({ where: eq(databaseImports.id, input.id) }))!; expect(row.receivedBytes).toBe(10); expect(row.status).toBe(final ? 'pending' : 'uploading');
  expect(m.audit.mock.calls.filter(call => call[2] === 'database.import.upload')).toHaveLength(final ? 1 : 0);
 } finally { release.release(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
});
it('next chunk queued behind held first uses fresh offset', async () => {
 const input = await createUpload(false), held = gate(), release = gate(); const observed = await snapshotGate(); let writes = 0;
 m.writeHook = async (_body, perform) => { const result = await perform(); if (++writes === 1) { held.release(); await release.promise; } return result; };
 const first = put(input.id, a); let next: ReturnType<typeof put> | undefined;
 try { await held.promise; observed.arm(); next = chunk(input.id, 1, b); await observed.entered.promise; release.release(); expect((await first).statusCode).toBe(200); expect((await next).statusCode).toBe(200); expect(readFileSync(input.file)).toEqual(Buffer.concat([a,b])); expect(writes).toBe(2); }
 finally { release.release(); await Promise.allSettled([first,...(next ? [next] : [])]); }
});
it('unrelated import completes while another native writer is held', async () => {
 const firstInput = await createUpload(), other = await createUpload(), held = gate(), release = gate();
 m.writeHook = async (body, perform) => { const result = await perform(); if (Buffer.from(body as Buffer).equals(a)) { held.release(); await release.promise; } return result; };
 const first = put(firstInput.id, a); try { await held.promise; expect((await put(other.id,b)).statusCode).toBe(200); expect(readFileSync(other.file)).toEqual(b); } finally { release.release(); await first; }
});
it('native write failure closes ownership and permits retry', async () => {
 const input = await createUpload(); let fail = true; m.writeHook = async (_body,perform) => { if(fail) { fail=false; throw new Error('injected native write failure'); } return perform(); };
 expect((await put(input.id,a)).statusCode).toBe(500); expect((await put(input.id,b)).statusCode).toBe(200); expect(readFileSync(input.file)).toEqual(b);
});
it('validation failure releases admission for valid chunk', async () => {
 const input = await createUpload(); expect((await chunk(input.id,1,a)).statusCode).toBe(409); expect((await put(input.id,Buffer.from('x'))).statusCode).toBe(400); expect((await put(input.id,a)).statusCode).toBe(200); expect(readFileSync(input.file)).toEqual(a);
});
