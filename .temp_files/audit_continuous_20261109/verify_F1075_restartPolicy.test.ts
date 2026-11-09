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

import { afterAll } from 'vitest';
import { eq } from '../../apps/server/node_modules/drizzle-orm/index.js';
import { settings } from '@ninedeploy/db';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
afterEach(() => vi.restoreAllMocks());
const sampleValue = () => new Map([['c', 3]]);
async function currentStatus() { return (await db.query.services.findFirst())?.status; }
for (const type of ['docker', 'pm2'] as const) for (const action of ['raise', 'window', 'disable', 'recreate'] as const) it(`${type}: ${action} during sampling abandons old owner`, async () => {
 await db.update(services).set({ type });
 const entered = gate(); const blocked = gate(); const stop = vi.fn(async () => {}); const onTripped = vi.fn();
 const sample = async () => { entered.release(); await blocked.promise; return sampleValue(); };
 const run = lib.enforceRestartLimits(db, { sample, samplePm2: sample, stop, stopPm2: stop, onTripped }, 60000);
 try {
  await entered.promise;
  if (action === 'disable' || action === 'recreate') await lib.setRestartLimit(db, 5, null);
  const replacement = action === 'raise' ? { ...limit, maxRestarts: 10 } : action === 'window' ? { ...limit, windowMinutes: 20 } : limit;
  if (action !== 'disable') await lib.setRestartLimit(db, 5, replacement);
  blocked.release(); expect(await run).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect(onTripped).not.toHaveBeenCalled(); expect(await currentStatus()).toBe('running');
  expect(await lib.getRestartLimit(db, 5)).toEqual(action === 'disable' ? null : { ...replacement, trippedAt: null });
 } finally { blocked.release(); await run; }
});
for (const action of ['disable', 'raise', 'recreate'] as const) it(`${action} during admitted stop survives trip recording`, async () => {
 const entered = gate(); const blocked = gate(); const onTripped = vi.fn();
 const run = lib.enforceRestartLimits(db, { sample: async () => sampleValue(), stop: async () => { entered.release(); await blocked.promise; }, onTripped }, 60000);
 try {
  await entered.promise; await lib.setRestartLimit(db, 5, null);
  const replacement = action === 'raise' ? { ...limit, maxRestarts: 10 } : limit;
  if (action !== 'disable') await lib.setRestartLimit(db, 5, replacement);
  blocked.release(); expect(await run).toEqual([5]); expect(onTripped).toHaveBeenCalledOnce();
  expect(await lib.getRestartLimit(db, 5)).toEqual(action === 'disable' ? null : { ...replacement, trippedAt: null });
 } finally { blocked.release(); await run; }
});
it('the final SQL admission checks persisted policy after a later direct update', async () => {
 const entered = gate(); const blocked = gate(); let used = false; const stop = vi.fn(async () => {});
 const original = db.$client.execute.bind(db.$client);
 vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
  const statement = args[0]; const sql = typeof statement === 'string' ? statement : statement.sql;
  if (!used && /update "services" set/i.test(sql)) { used = true; entered.release(); await blocked.promise; }
  return original(...args);
 }) as typeof original);
 const run = lib.enforceRestartLimits(db, { sample: async () => sampleValue(), stop }, 60000);
 try {
  await entered.promise; await db.update(settings).set({ value: { maxRestarts: 20, windowMinutes: 10, trippedAt: null } as unknown as boolean }).where(eq(settings.key, 'restart_limit:5'));
  blocked.release(); expect(await run).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect(await currentStatus()).toBe('running'); expect((await lib.getRestartLimit(db, 5))?.maxRestarts).toBe(20);
 } finally { blocked.release(); await run; }
});
it('old stop completion preserves history started by a newly enabled policy', async () => {
 const entered = gate(); const blocked = gate();
 const run = lib.enforceRestartLimits(db, { sample: async () => sampleValue(), stop: async () => { entered.release(); await blocked.promise; } }, 60000);
 try {
  await entered.promise; await lib.setRestartLimit(db, 5, null); await lib.setRestartLimit(db, 5, { ...limit, maxRestarts: 10 });
  lib.recordRestarts(5, new Map([['new', 0]]), limit, 60001); lib.recordRestarts(5, new Map([['new', 2]]), limit, 60002);
  blocked.release(); await run; expect(lib.restartLimitView(await lib.getRestartLimit(db, 5), 5, 60003).recentRestarts).toBe(2);
 } finally { blocked.release(); await run; }
});
it('a later fresh sweep enforces the replacement threshold', async () => {
 await lib.setRestartLimit(db, 5, { ...limit, maxRestarts: 5 }); const stop = vi.fn(async () => {});
 expect(await lib.enforceRestartLimits(db, { sample: async () => sampleValue(), stop }, 60000)).toEqual([]);
 expect(await lib.enforceRestartLimits(db, { sample: async () => new Map([['c', 5]]), stop }, 60001)).toEqual([5]); expect(stop).toHaveBeenCalledOnce();
});
