import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, databaseImports, databases, projects, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import type { FastifyInstance } from 'fastify';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
const m = vi.hoisted(() => ({ audit: vi.fn(async (..._args: unknown[]) => {}), job: vi.fn(async () => {}), sandbox: vi.fn<() => Promise<string | null>>(), short: 0, writeHook: null as null | ((body: unknown, write: () => Promise<unknown>) => Promise<unknown>) }));
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
 m.short = 0; m.writeHook = null; m.audit.mockClear(); m.job.mockReset().mockResolvedValue(undefined); m.sandbox.mockReset().mockResolvedValue(null);
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
    if (m.short) { const [buffer, offset, length, position] = parts as unknown as [Buffer, number, number, number]; return write(buffer, offset, Math.min(length, m.short), position); } return write(...parts);
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

it('control: full successful native write acknowledges exact bytes', async () => { const input = await createUpload(); const res = await put(input.id,a); expect(res.statusCode).toBe(200); expect(readFileSync(input.file)).toEqual(a); expect(res.json().receivedBytes).toBe(a.length); });
it('short successful native writes must persist full chunk before acknowledging', async () => { const input = await createUpload(); m.short = 3; const res = await put(input.id,a); expect(res.statusCode).toBe(200); const actual = readFileSync(input.file); console.log('EXPECTED:',a.toString(),'ACTUAL:', actual.toString(), 'acknowledged:',res.json().receivedBytes); console.log(actual.equals(a) ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); expect(actual).toEqual(a); expect(res.json().receivedBytes).toBe(a.length); });
