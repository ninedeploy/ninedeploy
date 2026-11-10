import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, databaseImports, databases, projects, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import type { FastifyInstance } from 'fastify';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
const m = vi.hoisted(() => ({ audit: vi.fn(async (..._args: unknown[]) => {}), job: vi.fn(async () => {}), sandbox: vi.fn<() => Promise<string | null>>() }));
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
async function upload(target = databaseId) {
 const content = Buffer.from('CREATE TABLE safe_fixture(id INT);\n'); const created = await app.inject({ method: 'POST', url: `/databases/${target}/imports`, headers: narrow(), payload: { source: 'upload', sizeBytes: content.length } }); expect(created.statusCode).toBe(201); const id = created.json().id as number;
 const sent = await app.inject({ method: 'PUT', url: `/databases/${target}/imports/${id}/chunks/0`, headers: { ...narrow(), 'content-type': 'application/octet-stream' }, payload: content }); expect(sent.statusCode).toBe(200); const row = (await db.query.databaseImports.findFirst({ where: eq(databaseImports.id, id) }))!; owned(row.stagingPath!); m.audit.mockClear(); return { id, file: row.stagingPath! };
}
const start = (id: number, operator = false, target = databaseId) => app.inject({ method: 'POST', url: `/databases/${target}/imports/${id}/start`, headers: operator ? full() : narrow() });

import { afterAll } from 'vitest';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
const actions = (action: string) => m.audit.mock.calls.filter(call => call[2] === action).length;
for (const engine of ['mysql', 'mariadb'] as const) {
 it(`${engine}: winning refusal still fails and cleans its own upload`, async () => {
  await db.update(databases).set({ engine }).where(eq(databases.id, databaseId)); const input = await upload(); expect((await start(input.id)).statusCode).toBe(422); expect((await db.query.databaseImports.findFirst())?.status).toBe('failed'); expect(existsSync(input.file)).toBe(false); expect(actions('database.import.fail')).toBe(1); expect(m.job).not.toHaveBeenCalled();
 });
 it(`${engine}: older refusal loses to admitted start without touching its staging`, async () => {
  await db.update(databases).set({ engine }).where(eq(databases.id, databaseId)); const input = await upload(); const entered = gate(), blocked = gate(), workerEntered = gate(), workerBlocked = gate();
  m.sandbox.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return null; }); m.job.mockImplementationOnce(async () => { workerEntered.release(); await workerBlocked.promise; }); const first = start(input.id);
  try { await entered.promise; expect((await start(input.id, true)).statusCode).toBe(202); await workerEntered.promise; blocked.release(); expect((await first).statusCode).toBe(409); expect((await db.query.databaseImports.findFirst())?.status).toBe('running'); expect(existsSync(input.file)).toBe(true); expect(m.job).toHaveBeenCalledOnce(); expect(actions('database.import.fail')).toBe(0); expect(actions('database.import.start')).toBe(1); } finally { blocked.release(); workerBlocked.release(); await first; }
 });
 it(`${engine}: older refusal loses to cancellation without a second failure receipt`, async () => {
  await db.update(databases).set({ engine }).where(eq(databases.id, databaseId)); const input = await upload(); const entered = gate(), blocked = gate(); m.sandbox.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return null; }); const first = start(input.id);
  try { await entered.promise; const cancelled = await app.inject({ method: 'DELETE', url: `/databases/${databaseId}/imports/${input.id}`, headers: narrow() }); expect(cancelled.statusCode).toBe(200); blocked.release(); expect((await first).statusCode).toBe(409); expect((await db.query.databaseImports.findFirst())?.status).toBe('cancelled'); expect(existsSync(input.file)).toBe(false); expect(actions('database.import.cancel')).toBe(1); expect(actions('database.import.fail')).toBe(0); expect(m.job).not.toHaveBeenCalled(); } finally { blocked.release(); await first; }
 });
}
it('four competing allowed starts retain one admitted worker', async () => {
 const input = await upload(); const entered = gate(), blocked = gate(); m.sandbox.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return null; }); const first = start(input.id, true); let rest: ReturnType<typeof start>[] = [];
 try { await entered.promise; rest = [start(input.id, true), start(input.id, true), start(input.id, true)]; const replies = await Promise.all(rest); blocked.release(); replies.push(await first); expect(replies.map(r => r.statusCode).sort()).toEqual([202, 409, 409, 409]); expect(m.job).toHaveBeenCalledOnce(); expect(existsSync(input.file)).toBe(true); expect(actions('database.import.start')).toBe(1); expect(actions('database.import.fail')).toBe(0); } finally { blocked.release(); await Promise.all([first, ...rest]); }
});
it('SQL refusal-write failure preserves pending input and emits no success-shaped failure audit', async () => {
 const input = await upload(); const original = db.$client.execute.bind(db.$client); let used = false;
 vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => { const s = args[0]; const sql = typeof s === 'string' ? s : s.sql; if (!used && /update "database_imports" set "status"/i.test(sql)) { used = true; throw new Error('controlled refusal persistence failure'); } return original(...args); }) as typeof original);
 expect((await start(input.id)).statusCode).toBe(500); expect(existsSync(input.file)).toBe(true); expect((await db.query.databaseImports.findFirst())?.status).toBe('pending'); expect(actions('database.import.fail')).toBe(0); expect(m.job).not.toHaveBeenCalled();
});
it('another database import can finish refusal while this one waits', async () => {
 const firstInput = await upload(); const [project] = await db.select().from(projects); const [other] = await db.insert(databases).values({ name: 'other', slug: 'other', engine: 'mysql', status: 'running', containerName: 'nd-db-other', passwordEncrypted: 'v1:fixture', projectId: project!.id }).returning(); const secondInput = await upload(other!.id);
 const entered = gate(), blocked = gate(); m.sandbox.mockImplementationOnce(async () => { entered.release(); await blocked.promise; return null; }); const first = start(firstInput.id);
 try { await entered.promise; expect((await start(secondInput.id, false, other!.id)).statusCode).toBe(422); expect(existsSync(secondInput.file)).toBe(false); expect(existsSync(firstInput.file)).toBe(true); blocked.release(); expect((await first).statusCode).toBe(422); } finally { blocked.release(); await first; }
});
it('another creator remains forbidden before probing or touching files', async () => {
 const input = await upload(); await db.insert(users).values({ id: 3, email: 'other-actor@example.test', passwordHash: 'fixture', isInstanceOperator: true });
 const other = await app.inject({ method: 'POST', url: `/databases/${databaseId}/imports/${input.id}/start`, headers: asUser({ id: 3, isOperator: true }) }); expect(other.statusCode).toBe(403); expect(m.sandbox).not.toHaveBeenCalled(); expect(m.job).not.toHaveBeenCalled(); expect(existsSync(input.file)).toBe(true);
});
