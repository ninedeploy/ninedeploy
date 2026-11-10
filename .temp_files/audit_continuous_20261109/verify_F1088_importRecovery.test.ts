import { createHash } from 'node:crypto';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createClient } from '../../packages/sdk/src/client.js';
import { importData } from '../../apps/cli/src/commands/importData.js';
import type { ImportReceipt } from '../../apps/cli/src/commands/importApply.js';
import type { ImportPlan } from '../../apps/cli/src/lib/importers/plan.js';
const bytes = new TextEncoder().encode('fixture-dump');
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const plan: ImportPlan = { planVersion: 1, source: { kind: 'caprover', url: 'https://source.fixture', version: null, scope: '' }, generatedAt: '', services: [], databases: [{ ref: 'pg', name: 'pg', engine: 'postgres', image: 'postgres:16', issues: [] }], notes: [] };
function receipt(): ImportReceipt { return { receiptVersion: 1, panel: 'https://panel.fixture', source: { kind: 'caprover', url: 'https://source.fixture' }, items: { 'database:pg': { kind: 'database', ref: 'pg', name: 'pg', state: 'done', id: 5, at: '', notes: [] } } }; }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; vi.restoreAllMocks(); });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
function panel(fault: 'none' | 'upload' | 'chunk-response' | 'start-response' | 'wait', startStatus = 'completed') {
 let row: { id: number; status: string; sizeBytes: number; receivedBytes: number; chunkSize: number; sha256: string } | undefined;
 let disconnected = false, creates = 0, restores = 0, target = 'empty'; let chunks: Uint8Array[] = []; let readFailure: 'throw' | 'missing' | null = null;
 const offsets: number[] = [], creationBodies: Array<Record<string, unknown>> = [];
 const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
 const client = createClient({ baseUrl: 'https://panel.fixture', getToken: () => 'fixture-token', fetch: async (input, init) => {
  const route = new URL(String(input)).pathname, method = init?.method ?? 'GET';
  if (route === '/v1/databases/5/imports' && method === 'POST') {
   if (row && !['completed', 'completed_with_warnings', 'failed', 'cancelled', 'expired'].includes(row.status)) return json({ error: { code: 'import_active', message: 'An import is already active' } }, 409);
   const body = JSON.parse(String(init?.body)); creationBodies.push(body); creates++; chunks = []; row = { id: 700 + creates, status: 'uploading', sizeBytes: body.sizeBytes, receivedBytes: 0, chunkSize: 4, sha256: body.sha256 }; return json(row);
  }
  if (!row || !route.startsWith(`/v1/databases/5/imports/${row.id}`)) throw new Error(`Unexpected fixture route: ${route}`);
  if (route.includes('/chunks/') && method === 'PUT') {
   if (fault === 'upload' && !disconnected) { disconnected = true; throw new TypeError('fixture upload disconnected'); }
   const chunk = init?.body as Uint8Array; expect(Number(route.split('/').at(-1))).toBe(row.receivedBytes / row.chunkSize); chunks.push(new Uint8Array(chunk)); row.receivedBytes += chunk.length;
   if (fault === 'chunk-response' && !disconnected) { disconnected = true; throw new TypeError('fixture accepted chunk response lost'); }
   return json(row);
  }
  if (route.endsWith('/start') && method === 'POST') {
   const actual = createHash('sha256'); for (const chunk of chunks) actual.update(chunk); expect(row.receivedBytes).toBe(row.sizeBytes); expect(actual.digest('hex')).toBe(row.sha256); restores++; target = startStatus === 'running' ? 'restoring' : 'dump snapshot'; row.status = startStatus;
   if (fault === 'start-response' && !disconnected) { disconnected = true; throw new TypeError('fixture accepted start response lost'); }
   return json(row, 202);
  }
  if (method === 'GET') {
   if (readFailure === 'throw') throw new TypeError('fixture status unavailable');
   if (readFailure === 'missing') return json({ error: { code: 'import_missing', message: 'fixture metadata missing' } }, 404);
   if (fault === 'wait' && row.status === startStatus && !disconnected) { disconnected = true; throw new TypeError('fixture status response lost'); }
   return json(row);
  }
  throw new Error('Unexpected fixture operation');
 } });
 return { client, offsets, creationBodies, get creates() { return creates; }, get restores() { return restores; }, get target() { return target; }, writeTarget: () => { target = 'new target writes'; }, setStatus: (status: string) => { if (!row) throw new Error('no row'); row.status = status; }, setReadFailure: (mode: 'throw' | 'missing' | null) => { readFailure = mode; }, finish: () => { if (!row) throw new Error('no row'); row.status = 'completed'; target = 'dump snapshot'; } };
}
function deps(p: ReturnType<typeof panel>, r: ImportReceipt, data = bytes) { return { client: p.client, receipt: r, save: () => {}, hashFile: async () => ({ sha256: hash(data), bytes: data.length }), open: () => async function* (offset: number) { p.offsets.push(offset); yield data.subarray(offset); } }; }
for (const fault of ['upload', 'chunk-response', 'start-response', 'wait'] as const) it(`known-id retry reconciles ${fault} after receipt serialization`, async () => {
 const p = panel(fault); let r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); expect(r.items['data:pg']?.state).toBe('failed'); r = JSON.parse(JSON.stringify(r)) as ImportReceipt;
 if (p.restores) p.writeTarget(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); expect(r.items['data:pg']).toMatchObject({ state: 'done', importId: 701 }); expect(p.creates).toBe(1); expect(p.restores).toBe(1);
 if (fault === 'chunk-response') expect(p.offsets).toEqual([0, 4]); if (fault === 'start-response' || fault === 'wait') expect(p.target).toBe('new target writes');
});
it('fresh upload and repeated done receipt create one restore', async () => {
 const p = panel('none'), r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); expect(p.creates).toBe(1); expect(p.restores).toBe(1);
});
for (const unknown of ['throw', 'missing'] as const) it(`unknown ${unknown} reconciliation never creates a replacement`, async () => {
 const p = panel('wait'), r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); p.writeTarget(); p.setReadFailure(unknown); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); expect(r.items['data:pg']).toMatchObject({ state: 'failed', importId: 701 }); expect(p.creates).toBe(1); expect(p.restores).toBe(1); expect(p.target).toBe('new target writes');
 p.setReadFailure(null); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); expect(r.items['data:pg']?.state).toBe('done');
});
it('running restore is only awaited through a gated completion, never restarted', async () => {
 const p = panel('wait', 'running'), r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); const entered = gate(), blocked = gate(); const wait = p.client.databases.imports.wait;
 vi.spyOn(p.client.databases.imports, 'wait').mockImplementation(async (...args: Parameters<typeof wait>) => { entered.release(); await blocked.promise; return wait(...args); });
 const retry = importData(plan, { pg: 'fixture.dump' }, deps(p, r));
 try { await Promise.race([entered.promise, retry.then(() => { throw new Error('recovery ended without waiting for its known job'); })]); expect(p.creates).toBe(1); expect(p.restores).toBe(1); p.finish(); blocked.release(); await retry; expect(r.items['data:pg']).toMatchObject({ state: 'done', importId: 701 }); } finally { blocked.release(); await retry; }
});
it('completed-with-warnings remote job records done without repeating restore', async () => {
 const p = panel('wait'), r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); p.setStatus('completed_with_warnings'); p.writeTarget(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); expect(r.items['data:pg']?.notes[0]).toContain('with warnings'); expect(p.restores).toBe(1); expect(p.target).toBe('new target writes');
});
for (const status of ['failed', 'cancelled', 'expired']) it(`confirmed remote ${status} permits a fresh explicit attempt`, async () => {
 const p = panel('upload'), r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); p.setStatus(status); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); expect(r.items['data:pg']).toMatchObject({ state: 'done', importId: 702 }); expect(p.creates).toBe(2); expect(p.restores).toBe(1);
});
it('different dump cannot replace an unresolved known completed job', async () => {
 const p = panel('wait'), r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); p.writeTarget(); const before = JSON.parse(JSON.stringify(r));
 await expect(importData(plan, { pg: 'different.dump' }, deps(p, r, new TextEncoder().encode('different-fixture-dump')))).rejects.toThrow(/different|already/); expect(r).toEqual(before); expect(p.creates).toBe(1); expect(p.restores).toBe(1); expect(p.target).toBe('new target writes');
});
it('different dump still refuses after a recorded done receipt', async () => {
 const p = panel('none'), r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p, r)); await expect(importData(plan, { pg: 'different.dump' }, deps(p, r, new TextEncoder().encode('different')))).rejects.toThrow(/already/); expect(p.restores).toBe(1);
});
it('RDB recovery never sends confirmReplace for a second restore after a lost completion response', async () => {
 const p = panel('wait'), r = receipt(); const redisPlan: ImportPlan = { ...plan, databases: [{ ...plan.databases[0]!, engine: 'redis', image: 'redis:7' }] };
 await importData(redisPlan, { pg: 'fixture.rdb' }, deps(p, r)); expect(r.items['data:pg']?.state).toBe('failed'); expect(p.creationBodies[0]?.options).toEqual({ confirmReplace: true }); p.writeTarget(); await importData(redisPlan, { pg: 'fixture.rdb' }, deps(p, r)); expect(r.items['data:pg']?.state).toBe('done'); expect(p.creationBodies).toHaveLength(1); expect(p.restores).toBe(1); expect(p.target).toBe('new target writes');
});
it('an actual saved pending onCreated checkpoint resumes without rewriting failed state', async () => {
 const p = panel('upload'), original = receipt(); const snapshots: ImportReceipt[] = [];
 await importData(plan, { pg: 'fixture.dump' }, { ...deps(p, original), save: current => { snapshots.push(JSON.parse(JSON.stringify(current)) as ImportReceipt); } });
 const saved = snapshots.find(r => r.items['data:pg']?.state === 'pending' && r.items['data:pg']?.importId === 701); expect(saved).toBeDefined();
 const recovered = JSON.parse(JSON.stringify(saved)) as ImportReceipt; await importData(plan, { pg: 'fixture.dump' }, deps(p, recovered)); expect(recovered.items['data:pg']).toMatchObject({ state: 'done', importId: 701 }); expect(p.creates).toBe(1); expect(p.restores).toBe(1);
});
