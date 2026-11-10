import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, databaseImports, databases, projects, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import type { FastifyInstance } from 'fastify';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
const m = vi.hoisted(() => ({ audit: vi.fn(async (..._args: unknown[]) => {}), job: vi.fn(async () => {}), sandbox: vi.fn<() => Promise<string | null>>(), short: 0, schedule: [] as number[], writes: [] as number[][], writeHook: null as null | ((body: unknown, write: () => Promise<unknown>) => Promise<unknown>) }));
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: m.audit }));
vi.mock('../../apps/server/src/lib/databaseImport.js', async original => ({ ...await original<typeof import('../../apps/server/src/lib/databaseImport.js')>(), runImportJob: m.job }));
vi.mock('../../apps/server/src/engine/database.js', async original => ({ ...await original<typeof import('../../apps/server/src/engine/database.js')>(), probeMysqlSandboxFlag: m.sandbox }));
const { databaseImportRoutes } = await import('../../apps/server/src/modules/databaseImports.js');
const { buildTestApp, asUser } = await import('../../apps/server/test/helpers.js');
let db: DB, app: FastifyInstance, root: string, databaseId: number;
const narrow = () => asUser({ id: 2, isOperator: false, role: 'member' });
const full = () => asUser({ id: 2, isOperator: true });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function owned(file: string) { if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) throw new Error('Unowned fixture path'); return file; }
beforeEach(async () => {
 m.short = 0; m.schedule = []; m.writes = []; m.writeHook = null; m.audit.mockClear(); m.job.mockReset().mockResolvedValue(undefined); m.sandbox.mockReset().mockResolvedValue(null);
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
    const [buffer, offset, length, position] = parts as unknown as [Buffer, number, number, number]; m.writes.push([offset,length,position]);
    const limit = m.schedule.length ? m.schedule.shift()! : m.short || length; if(limit < 0) throw new Error('injected after partial write'); return write(buffer, offset, Math.min(length,limit),position);
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
for(const size of [1,3,9,10]) it(`completes each short write size=${size}`, async()=>{ const input=await createUpload();m.short=size;const res=await put(input.id,a);expect(res.statusCode).toBe(200);expect(res.json().receivedBytes).toBe(10);expect(res.json().status).toBe('pending');expect(readFileSync(input.file)).toEqual(a);expect(m.writes.length).toBe(Math.ceil(10/size)); });
it('advances native buffer offset, remaining length and absolute file position',async()=>{ const input=await createUpload(false);expect((await put(input.id,a)).statusCode).toBe(200);m.writes=[];m.schedule=[2,1,4,3];expect((await chunk(input.id,1,b)).statusCode).toBe(200);expect(m.writes).toEqual([[0,10,10],[2,8,12],[3,7,13],[7,3,17]]);expect(readFileSync(input.file)).toEqual(Buffer.concat([a,b])); });
for(const schedule of [[0],[3,0],[3,-1]])it(`unsuccessful partial sequence ${schedule} leaves metadata retryable`,async()=>{const input=await createUpload();m.schedule=[...schedule];const failed=await put(input.id,a);expect(failed.statusCode).toBe(500);const row=(await db.query.databaseImports.findFirst({where:eq(databaseImports.id,input.id)}))!;expect(row.receivedBytes).toBe(0);expect(row.status).toBe('uploading');expect(m.audit.mock.calls.filter(call=>call[2]==='database.import.upload')).toHaveLength(0);m.schedule=[];m.short=2;expect((await put(input.id,b)).statusCode).toBe(200);expect(readFileSync(input.file)).toEqual(b);});
import { afterAll } from 'vitest';let failed=false;afterEach(({task})=>{if(task.result?.errors?.length)failed=true;});afterAll(()=>{if(!failed)console.log('FIX VERIFIED');});
