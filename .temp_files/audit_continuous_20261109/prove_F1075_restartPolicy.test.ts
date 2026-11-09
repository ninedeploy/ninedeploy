import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services, users, type DB } from '@ninedeploy/db';
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
it('control: unchanged policy stops the loop and records one trip', async () => {
 const stop = vi.fn(async () => {}); const onTripped = vi.fn();
 expect(await lib.enforceRestartLimits(db, { sample: async () => new Map([['c', 3]]), stop, onTripped }, 60000)).toEqual([5]);
 expect(stop).toHaveBeenCalledOnce(); expect(onTripped).toHaveBeenCalledOnce(); expect((await lib.getRestartLimit(db, 5))?.trippedAt).not.toBeNull();
});
it('a raised threshold completed during sampling prevents the stale policy stop', async () => {
 const entered = gate(); const blocked = gate(); const stop = vi.fn(async () => {}); const onTripped = vi.fn();
 const run = lib.enforceRestartLimits(db, { sample: async () => { entered.release(); await blocked.promise; return new Map([['c', 3]]); }, stop, onTripped }, 60000);
 try {
  await entered.promise; await lib.setRestartLimit(db, 5, { ...limit, maxRestarts: 10 }); blocked.release(); await run;
  const actual = { stops: stop.mock.calls.length, maxRestarts: (await lib.getRestartLimit(db, 5))?.maxRestarts };
  console.log('EXPECTED: no stop and maxRestarts10; ACTUAL:', actual); console.log(actual.stops ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
  expect(actual).toEqual({ stops: 0, maxRestarts: 10 }); expect(onTripped).not.toHaveBeenCalled();
 } finally { blocked.release(); await run; }
});
it('disabling the policy during an admitted stop does not recreate its setting', async () => {
 const entered = gate(); const blocked = gate();
 const run = lib.enforceRestartLimits(db, { sample: async () => new Map([['c', 3]]), stop: async () => { entered.release(); await blocked.promise; } }, 60000);
 try {
  await entered.promise; await lib.setRestartLimit(db, 5, null); blocked.release(); await run;
  const actual = await lib.getRestartLimit(db, 5); console.log('EXPECTED: disabled/null; ACTUAL:', actual); console.log(actual ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED'); expect(actual).toBeNull();
 } finally { blocked.release(); await run; }
});
