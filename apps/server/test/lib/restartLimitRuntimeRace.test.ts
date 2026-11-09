import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployments, services, users, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from './githubAppKit.js';
import * as lib from '../../src/lib/restartLimit.js';
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

it('control: unchanged runtime without deployment is stopped', async () => {
 const stop = vi.fn(async () => {});
 expect(await lib.enforceRestartLimits(db, { sample: async () => new Map([['c', 3]]), stop }, 60000)).toEqual([5]); expect(stop).toHaveBeenCalledOnce();
});
for (const change of ['runtime', 'deploy'] as const) it(`${change} during sampling prevents stale stop admission`, async () => {
 const entered = gate(); const blocked = gate(); const stop = vi.fn(async () => {}); const onTripped = vi.fn();
 const run = lib.enforceRestartLimits(db, { sample: async () => { entered.release(); await blocked.promise; return new Map([['c', 3]]); }, stop, onTripped }, 60000);
 try {
  await entered.promise;
  if (change === 'runtime') await db.update(services).set({ runtimeId: 'replacement-2', status: 'running' });
  else await db.insert(deployments).values({ serviceId: 5, status: 'deploying', trigger: 'user' });
  blocked.release(); const stopped = await run; const svc = await db.query.services.findFirst();
  const actual = { stopped, status: svc?.status, calls: stop.mock.calls.length };
  console.log('EXPECTED: no stop, running current service; ACTUAL:', actual); console.log(actual.calls ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
  expect(actual).toEqual({ stopped: [], status: 'running', calls: 0 }); expect(onTripped).not.toHaveBeenCalled(); expect((await lib.getRestartLimit(db, 5))?.trippedAt).toBeNull();
 } finally { blocked.release(); await run; }
});

afterEach(() => vi.restoreAllMocks());
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
