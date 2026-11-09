import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployments, services, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from './githubAppKit.js';
import { sweepAutoUpdates } from '../../src/lib/autoUpdate.js';
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => {}) }));
let db: DB;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
beforeEach(async () => { db = await migratedDb(); await db.insert(services).values({ id: 5, name: 'watched', slug: 'watched', type: 'docker', image: 'nginx:latest', status: 'running', autoUpdate: true, autoUpdateDigest: 'sha256:old' }); });
afterEach(() => { vi.restoreAllMocks(); closeMigratedDb(db); });
it('control: eligible unchanged service enqueues scheduled work', async () => {
 expect(await sweepAutoUpdates(db, async () => 'sha256:new')).toEqual({ probed: 1, enqueued: 1, skipped: 0 });
 expect(await db.query.deployments.findFirst()).toMatchObject({ serviceId: 5, status: 'queued', trigger: 'schedule' });
 expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:new');
});
for (const change of ['disable', 'stop', 'image'] as const) it(`${change} after probe check but before final enqueue discards stale result`, async () => {
 const entered = gate(); const blocked = gate(); let used = false; const original = db.$client.execute.bind(db.$client);
 vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
  const s = args[0]; const sql = typeof s === 'string' ? s : s.sql; const result = await original(...args);
  if (!used && /select .* from "deployments"/i.test(sql)) { used = true; entered.release(); await blocked.promise; }
  return result;
 }) as typeof original);
 const run = sweepAutoUpdates(db, async () => 'sha256:new');
 try {
  await entered.promise;
  if (change === 'disable') await db.update(services).set({ autoUpdate: false, autoUpdateDigest: null });
  if (change === 'stop') await db.update(services).set({ status: 'stopped' });
  if (change === 'image') await db.update(services).set({ image: 'redis:latest', autoUpdateDigest: null });
  const expected = await db.query.services.findFirst(); blocked.release(); const result = await run; const rows = await db.query.deployments.findMany();
  console.log('EXPECTED: 0 enqueued, operator state unchanged; ACTUAL:', result.enqueued, rows.length, (await db.query.services.findFirst())?.autoUpdateDigest);
  console.log(rows.length ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
  expect(rows).toHaveLength(0); expect(result).toEqual({ probed: 1, enqueued: 0, skipped: 1 }); expect(await db.query.services.findFirst()).toEqual(expected);
 } finally { blocked.release(); await run; }
});

function holdSql(pattern: RegExp, after = false) {
 const entered = gate(), blocked = gate(); let used = false; const original = db.$client.execute.bind(db.$client);
 const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
  const s = args[0]; const sql = typeof s === 'string' ? s : s.sql; const held = !used && pattern.test(sql); if (held) used = true;
  if (held && !after) { entered.release(); await blocked.promise; }
  const result = await original(...args);
  if (held && after) { entered.release(); await blocked.promise; }
  return result;
 }) as typeof original);
 return { entered: entered.promise, release: blocked.release, close: () => { blocked.release(); spy.mockRestore(); } };
}
for (const status of ['queued', 'building', 'deploying'] as const) it(`manual ${status} work wins immediately before INSERT`, async () => {
 const held = holdSql(/insert into "deployments"/i); const run = sweepAutoUpdates(db, async () => 'sha256:new');
 try {
  await held.entered; await db.insert(deployments).values({ serviceId: 5, status, trigger: 'user' }); held.release(); expect(await run).toEqual({ probed: 1, enqueued: 0, skipped: 1 });
  expect(await db.query.deployments.findMany()).toMatchObject([{ trigger: 'user', status }]); expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:old');
 } finally { held.release(); await run; held.close(); }
});
it('overlapping independent sweeps admit one deployment after both saw no in-flight job', async () => {
 const held = holdSql(/select .* from "deployments"/i, true); const stale = sweepAutoUpdates(db, async () => 'sha256:new');
 try {
  await held.entered; const fresh = await sweepAutoUpdates(db, async () => 'sha256:new'); expect(fresh.enqueued).toBe(1); held.release(); expect((await stale).enqueued).toBe(0);
  expect(await db.query.deployments.findMany()).toHaveLength(1); expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:new');
 } finally { held.release(); await stale; held.close(); }
});
