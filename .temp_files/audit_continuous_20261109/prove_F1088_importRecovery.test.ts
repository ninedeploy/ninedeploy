import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createClient } from '../../packages/sdk/src/client.js';
import { importData } from '../../apps/cli/src/commands/importData.js';
import type { ImportReceipt } from '../../apps/cli/src/commands/importApply.js';
import type { ImportPlan } from '../../apps/cli/src/lib/importers/plan.js';
const bytes = new TextEncoder().encode('fixture-dump');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const plan: ImportPlan = { planVersion: 1, source: { kind: 'caprover', url: 'https://source.fixture', version: null, scope: '' }, generatedAt: '', services: [], databases: [{ ref: 'pg', name: 'pg', engine: 'postgres', image: 'postgres:16', issues: [] }], notes: [] };
function receipt(): ImportReceipt { return { receiptVersion: 1, panel: 'https://panel.fixture', source: { kind: 'caprover', url: 'https://source.fixture' }, items: { 'database:pg': { kind: 'database', ref: 'pg', name: 'pg', state: 'done', id: 5, at: '', notes: [] } } }; }
function panel(fault: 'none' | 'upload' | 'wait') {
 let row: { id: number; status: string; sizeBytes: number; receivedBytes: number; chunkSize: number; sha256: string } | undefined;
 let disconnected = false, creates = 0, restores = 0, target = 'empty'; let chunks: Uint8Array[] = [];
 const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
 const client = createClient({ baseUrl: 'https://panel.fixture', getToken: () => 'fixture-token', fetch: async (input, init) => {
  const route = new URL(String(input)).pathname, method = init?.method ?? 'GET';
  if (route === '/v1/databases/5/imports' && method === 'POST') {
   if (row && !['completed', 'failed', 'cancelled'].includes(row.status)) return json({ error: { code: 'import_active', message: 'An import is already active' } }, 409);
   const body = JSON.parse(String(init?.body)); creates++; chunks = []; row = { id: 700 + creates, status: 'uploading', sizeBytes: body.sizeBytes, receivedBytes: 0, chunkSize: 4, sha256: body.sha256 }; return json(row);
  }
  if (!row || !route.startsWith(`/v1/databases/5/imports/${row.id}`)) throw new Error('Unexpected fixture route: ' + route);
  if (route.includes('/chunks/') && method === 'PUT') {
   if (fault === 'upload' && !disconnected) { disconnected = true; throw new TypeError('fixture upload connection lost'); }
   const chunk = init?.body as Uint8Array; expect(Number(route.split('/').at(-1))).toBe(row.receivedBytes / row.chunkSize); chunks.push(new Uint8Array(chunk)); row.receivedBytes += chunk.length; return json(row);
  }
  if (route.endsWith('/start') && method === 'POST') {
   const actual = createHash('sha256'); for (const chunk of chunks) actual.update(chunk); expect(row.receivedBytes).toBe(row.sizeBytes); expect(actual.digest('hex')).toBe(row.sha256); restores++; target = 'dump snapshot'; row.status = 'completed'; return json(row, 202);
  }
  if (method === 'GET') {
   if (fault === 'wait' && row.status === 'completed' && !disconnected) { disconnected = true; throw new TypeError('fixture completed-status response lost'); }
   return json(row);
  }
  throw new Error('Unexpected fixture operation');
 } });
 return { client, get creates() { return creates; }, get restores() { return restores; }, get target() { return target; }, writeTarget: () => { target = 'new target writes'; } };
}
const deps = (client: ReturnType<typeof createClient>, r: ImportReceipt) => ({ client, receipt: r, save: () => {}, hashFile: async () => ({ sha256, bytes: bytes.length }), open: () => async function* (offset: number) { yield bytes.subarray(offset); } });
it('control: ordinary SDK upload restores once and receipt skips same dump', async () => {
 const p = panel('none'), r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p.client, r)); await importData(plan, { pg: 'fixture.dump' }, deps(p.client, r)); expect({ state: r.items['data:pg']?.state, creates: p.creates, restores: p.restores }).toEqual({ state: 'done', creates: 1, restores: 1 });
});
for (const fault of ['upload', 'wait'] as const) it(`${fault} failure retries the known job without a second restore`, async () => {
 const p = panel(fault); let r = receipt(); await importData(plan, { pg: 'fixture.dump' }, deps(p.client, r)); expect(r.items['data:pg']).toMatchObject({ state: 'failed', importId: 701 });
 r = JSON.parse(JSON.stringify(r)) as ImportReceipt; if (fault === 'wait') p.writeTarget();
 await importData(plan, { pg: 'fixture.dump' }, deps(p.client, r));
 const actual = { state: r.items['data:pg']?.state, creates: p.creates, restores: p.restores, target: p.target };
 const expected = { state: 'done', creates: 1, restores: 1, target: fault === 'wait' ? 'new target writes' : 'dump snapshot' };
 console.log('EXPECTED:', expected, 'ACTUAL:', actual); console.log(JSON.stringify(actual) === JSON.stringify(expected) ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); expect(actual).toEqual(expected);
});
