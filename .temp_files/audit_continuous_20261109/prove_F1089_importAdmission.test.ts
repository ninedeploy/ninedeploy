import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { databaseImports, databases, projects, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import type { FastifyInstance } from 'fastify';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
const m = vi.hoisted(() => ({ audit: vi.fn(async () => {}), job: vi.fn(async () => {}), sandbox: vi.fn<() => Promise<string | null>>() }));
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
 m.audit.mockClear(); m.job.mockReset().mockResolvedValue(undefined); m.sandbox.mockReset().mockResolvedValue(null);
 root = path.resolve(mkdtempSync(path.join(tmpdir(), 'nd-audit-import-admission-'))); if (!root.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('nd-audit-import-admission-')) throw new Error('Unowned root');
 db = await migratedDb(); await db.insert(users).values([{ id: 1, email: 'owner@example.test', passwordHash: 'fixture' }, { id: 2, email: 'creator@example.test', passwordHash: 'fixture', isInstanceOperator: true }]);
 const [ws] = await db.insert(workspaces).values({ name: 'Fixture', slug: 'fixture', ownerId: 1 }).returning(); await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: 2, role: 'admin' }); const [project] = await db.insert(projects).values({ name: 'Fixture', slug: 'fixture', workspaceId: ws!.id }).returning();
 const [d] = await db.insert(databases).values({ name: 'fixture', slug: 'fixture', engine: 'mysql', status: 'running', containerName: 'nd-db-fixture', passwordEncrypted: 'v1:fixture', projectId: project!.id }).returning(); databaseId = d!.id;
 app = await buildTestApp({ db, rawBody: true }); await app.register(databaseImportRoutes, { prefix: '/databases', chunkSize: 64, stagingDir: root, maxBytes: 1000 });
});
afterEach(async () => { await app.close(); closeMigratedDb(db); if (!root.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('nd-audit-import-admission-')) throw new Error('Refusing unowned cleanup'); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function upload() {
 const content = Buffer.from('CREATE TABLE safe_fixture(id INT);\n'); const created = await app.inject({ method: 'POST', url: `/databases/${databaseId}/imports`, headers: narrow(), payload: { source: 'upload', sizeBytes: content.length } }); expect(created.statusCode).toBe(201); const id = created.json().id as number;
 const sent = await app.inject({ method: 'PUT', url: `/databases/${databaseId}/imports/${id}/chunks/0`, headers: { ...narrow(), 'content-type': 'application/octet-stream' }, payload: content }); expect(sent.statusCode).toBe(200); const row = (await db.query.databaseImports.findFirst())!; owned(row.stagingPath!); m.audit.mockClear(); return { id, file: row.stagingPath! };
}
const start = (id: number, operator = false) => app.inject({ method: 'POST', url: `/databases/${databaseId}/imports/${id}/start`, headers: operator ? full() : narrow() });
it('control: ordinary narrow refusal owns failure and removes its own input', async () => {
 const input = await upload(); expect((await start(input.id)).statusCode).toBe(422); expect((await db.query.databaseImports.findFirst())?.status).toBe('failed'); expect(existsSync(input.file)).toBe(false); expect(m.job).not.toHaveBeenCalled();
});
it('control: competing allowed starts dispatch one worker and preserve its file', async () => {
 const input = await upload(); const entered = gate(), blocked = gate(); m.sandbox.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return null; });
 const first = start(input.id, true);
 try { await entered.promise; expect((await start(input.id, true)).statusCode).toBe(202); blocked.release(); expect((await first).statusCode).toBe(409); expect(m.job).toHaveBeenCalledOnce(); expect(existsSync(input.file)).toBe(true); } finally { blocked.release(); await first; }
});
it('a stale refusing start cannot remove staging owned by an admitted worker', async () => {
 const input = await upload(); const entered = gate(), blocked = gate(), workerEntered = gate(), workerBlocked = gate(); m.sandbox.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return null; }); m.job.mockImplementationOnce(async () => { workerEntered.release(); await workerBlocked.promise; });
 const first = start(input.id);
 try {
  await entered.promise; expect((await start(input.id, true)).statusCode).toBe(202); await workerEntered.promise; blocked.release(); const loser = await first; const row = await db.query.databaseImports.findFirst();
  const actual = { response: loser.statusCode, status: row?.status, file: existsSync(input.file), jobs: m.job.mock.calls.length, failures: m.audit.mock.calls.filter(call => call[2] === 'database.import.fail').length };
  console.log('EXPECTED: stale refusal409/running/file kept/one job/no failure audit; ACTUAL:', actual); console.log(actual.file && actual.response === 409 ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); expect(actual).toEqual({ response: 409, status: 'running', file: true, jobs: 1, failures: 0 });
 } finally { blocked.release(); workerBlocked.release(); await first; }
});
