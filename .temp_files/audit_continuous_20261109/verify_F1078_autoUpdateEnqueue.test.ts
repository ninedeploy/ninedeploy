import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployments, services, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
import { sweepAutoUpdates } from '../../apps/server/src/lib/autoUpdate.js';
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: vi.fn(async () => {}) }));
let db: DB;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
beforeEach(async () => { db = await migratedDb(); await db.insert(services).values({ id: 5, name: 'watched', slug: 'watched', type: 'docker', image: 'nginx:latest', status: 'running', autoUpdate: true, autoUpdateDigest: 'sha256:old' }); });
afterEach(() => { vi.restoreAllMocks(); closeMigratedDb(db); });

import { afterAll } from 'vitest';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
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
for (const change of ['disable', 'stop', 'image', 'digest', 'type', 'delete'] as const) it(`conditional INSERT rejects ${change} after all application reads`, async () => {
 const held = holdSql(/insert into "deployments"/i); const run = sweepAutoUpdates(db, async () => 'sha256:new');
 try {
  await held.entered;
  if (change === 'disable') await db.update(services).set({ autoUpdate: false, autoUpdateDigest: null });
  else if (change === 'stop') await db.update(services).set({ status: 'stopped' });
  else if (change === 'image') await db.update(services).set({ image: 'redis:latest', autoUpdateDigest: null });
  else if (change === 'digest') await db.update(services).set({ autoUpdateDigest: 'sha256:replacement' });
  else if (change === 'type') await db.update(services).set({ type: 'pm2' });
  else await db.delete(services);
  const expected = await db.query.services.findFirst(); held.release(); expect(await run).toEqual({ probed: 1, enqueued: 0, skipped: 1 }); expect(await db.query.deployments.findMany()).toHaveLength(0); expect(await db.query.services.findFirst()).toEqual(expected);
 } finally { held.release(); await run; held.close(); }
});
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
it('unrelated INSERT error propagates without digest advance and a clean retry can enqueue', async () => {
 const original = db.$client.execute.bind(db.$client); let injected = false;
 const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
  const s = args[0]; const sql = typeof s === 'string' ? s : s.sql;
  if (!injected && /insert into "deployments"/i.test(sql)) { injected = true; throw new Error('injected unrelated SQL failure'); }
  return original(...args);
 }) as typeof original);
 await expect(sweepAutoUpdates(db, async () => 'sha256:new')).rejects.toThrow(); expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:old'); expect(await db.query.deployments.findMany()).toHaveLength(0);
 spy.mockRestore(); expect((await sweepAutoUpdates(db, async () => 'sha256:new')).enqueued).toBe(1);
});
for (const status of ['succeeded', 'failed', 'cancelled'] as const) it(`terminal ${status} deployment allows a fresh update`, async () => {
 await db.insert(deployments).values({ serviceId: 5, status, trigger: 'user' }); expect((await sweepAutoUpdates(db, async () => 'sha256:new')).enqueued).toBe(1);
 expect((await db.query.deployments.findMany()).filter(row => row.trigger === 'schedule')).toHaveLength(1);
});
it('another service active work does not suppress this update', async () => {
 await db.insert(services).values({ id: 6, name: 'other', slug: 'other', type: 'docker' }); await db.insert(deployments).values({ serviceId: 6, status: 'queued', trigger: 'user' });
 expect((await sweepAutoUpdates(db, async () => 'sha256:new')).enqueued).toBe(1); expect((await db.query.deployments.findMany()).filter(row => row.serviceId === 5)).toHaveLength(1);
});
it('first observation remains baseline-only and unchanged digest enqueues nothing', async () => {
 await db.update(services).set({ autoUpdateDigest: null }); expect((await sweepAutoUpdates(db, async () => 'sha256:new')).enqueued).toBe(0);
 expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:new'); expect((await sweepAutoUpdates(db, async () => 'sha256:new')).enqueued).toBe(0); expect(await db.query.deployments.findMany()).toHaveLength(0);
});
