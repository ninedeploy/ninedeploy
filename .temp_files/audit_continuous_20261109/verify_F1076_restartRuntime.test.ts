import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployments, services, users, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
import * as lib from '../../apps/server/src/lib/restartLimit.js';
let db: DB;
const limit = { maxRestarts: 3, windowMinutes: 10 };
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
beforeEach(async () => {
 db = await migratedDb(); lib.resetRestartHistory();
 await db.insert(users).values({ id: 1, email: 'restart@example.test', passwordHash: 'x' });
 await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, runtimeId: 'web-1', status: 'running' });
 await lib.setRestartLimit(db, 5, limit); lib.recordRestarts(5, new Map([['c', 0]]), limit, 0);
});
afterEach(() => { closeMigratedDb(db); lib.resetRestartHistory(); });


import { afterAll } from 'vitest';
import { eq } from '../../apps/server/node_modules/drizzle-orm/index.js';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; vi.restoreAllMocks(); });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
for (const type of ['docker', 'pm2'] as const) for (const change of ['runtime', 'deploying-status', 'error', 'stopped', 'type', 'swarm', 'delete'] as const) it(`${type}: ${change} while sampling cannot be clobbered`, async () => {
 await db.update(services).set({ type }); const entered = gate(); const blocked = gate(); const stop = vi.fn(async () => {}); const onTripped = vi.fn();
 const sample = async () => { entered.release(); await blocked.promise; return new Map([['c', 3]]); };
 const run = lib.enforceRestartLimits(db, { sample, samplePm2: sample, stop, stopPm2: stop, onTripped }, 60000);
 try {
  await entered.promise;
  if (change === 'runtime') await db.update(services).set({ runtimeId: 'replacement' });
  else if (change === 'delete') await db.delete(services);
  else if (change === 'type') await db.update(services).set({ type: type === 'docker' ? 'pm2' : 'docker' });
  else if (change === 'swarm') await db.update(services).set({ orchestrator: 'swarm' });
  else await db.update(services).set({ status: change === 'deploying-status' ? 'deploying' : change });
  const expected = await db.query.services.findFirst(); blocked.release(); expect(await run).toEqual([]);
  expect(await db.query.services.findFirst()).toEqual(expected); expect(stop).not.toHaveBeenCalled(); expect(onTripped).not.toHaveBeenCalled();
 } finally { blocked.release(); await run; }
});
for (const type of ['docker', 'pm2'] as const) for (const status of ['queued', 'building', 'deploying'] as const) it(`${type}: new ${status} deployment holds admission`, async () => {
 await db.update(services).set({ type }); const entered = gate(); const blocked = gate(); const stop = vi.fn(async () => {});
 const sample = async () => { entered.release(); await blocked.promise; return new Map([['c', 3]]); };
 const run = lib.enforceRestartLimits(db, { sample, samplePm2: sample, stop, stopPm2: stop }, 60000);
 try {
  await entered.promise; await db.insert(deployments).values({ serviceId: 5, status, trigger: 'user' }); blocked.release(); expect(await run).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect((await db.query.services.findFirst())?.status).toBe('running');
 } finally { blocked.release(); await run; }
});
for (const change of ['runtime', 'deploy'] as const) it(`SQL admission catches ${change} committed after earlier reads`, async () => {
 const entered = gate(); const blocked = gate(); let used = false; const stop = vi.fn(async () => {});
 const original = db.$client.execute.bind(db.$client);
 vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
  const s = args[0]; const sql = typeof s === 'string' ? s : s.sql;
  if (!used && /update "services" set/i.test(sql)) { used = true; entered.release(); await blocked.promise; }
  return original(...args);
 }) as typeof original);
 const run = lib.enforceRestartLimits(db, { sample: async () => new Map([['c', 3]]), stop }, 60000);
 try {
  await entered.promise;
  if (change === 'runtime') await db.update(services).set({ runtimeId: 'sql-replacement' }); else await db.insert(deployments).values({ serviceId: 5, status: 'queued', trigger: 'user' });
  blocked.release(); expect(await run).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect((await db.query.services.findFirst())?.status).toBe('running');
 } finally { blocked.release(); await run; }
});
for (const change of ['runtime', 'deploy'] as const) it(`rejected ${change} sample does not trip a later clean runtime baseline`, async () => {
 const entered = gate(); const blocked = gate(); const stop = vi.fn(async () => {});
 const run = lib.enforceRestartLimits(db, { sample: async () => { entered.release(); await blocked.promise; return new Map([['c', 3]]); }, stop }, 60000);
 try {
  await entered.promise;
  if (change === 'runtime') await db.update(services).set({ runtimeId: 'new-runtime' }); else await db.insert(deployments).values({ serviceId: 5, status: 'building', trigger: 'user' });
  blocked.release(); expect(await run).toEqual([]); await db.delete(deployments);
  expect(await lib.enforceRestartLimits(db, { sample: async () => new Map([['new-c', 0]]), stop }, 60001)).toEqual([]); expect(stop).not.toHaveBeenCalled();
  expect(await lib.enforceRestartLimits(db, { sample: async () => new Map([['new-c', 3]]), stop }, 60002)).toEqual([5]); expect(stop).toHaveBeenCalledOnce();
 } finally { blocked.release(); await run; }
});
for (const status of ['succeeded', 'failed', 'cancelled'] as const) it(`terminal ${status} deployments do not block a valid trip`, async () => {
 await db.insert(deployments).values({ serviceId: 5, status, trigger: 'user' }); const stop = vi.fn(async () => {});
 expect(await lib.enforceRestartLimits(db, { sample: async () => new Map([['c', 3]]), stop }, 60000)).toEqual([5]); expect(stop).toHaveBeenCalledOnce();
});
it('an active deployment for another service does not hold this service', async () => {
 await db.insert(services).values({ id: 6, name: 'other', slug: 'other', type: 'docker' });
 await db.insert(deployments).values({ serviceId: 6, status: 'deploying', trigger: 'user' }); const stop = vi.fn(async () => {});
 expect(await lib.enforceRestartLimits(db, { sample: async () => new Map([['c', 3]]), stop }, 60000)).toEqual([5]); expect(stop).toHaveBeenCalledOnce();
});
