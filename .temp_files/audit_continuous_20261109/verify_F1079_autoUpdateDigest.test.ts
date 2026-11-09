import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services, users, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
import { sweepAutoUpdates } from '../../apps/server/src/lib/autoUpdate.js';
const state = vi.hoisted(() => ({ refuse: false }));
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('../../apps/server/src/lib/hostPrivilege.js', () => ({ assertMayDeployStoredService: vi.fn(async () => { if (state.refuse) throw new Error('controlled refusal'); }) }));
let db: DB;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
beforeEach(async () => {
 db = await migratedDb(); state.refuse = false;
 await db.insert(users).values({ id: 1, email: 'digest@example.test', passwordHash: 'x' });
 await db.insert(services).values({ id: 5, name: 'watched', slug: 'watched', type: 'docker', image: 'nginx:latest', status: 'running', autoUpdate: true, autoUpdateDigest: 'sha256:old' });
});
afterEach(() => { vi.restoreAllMocks(); closeMigratedDb(db); });

import { afterAll } from 'vitest';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
async function phaseSetup(phase: 'baseline' | 'refused' | 'enqueued') {
 if (phase === 'baseline') await db.update(services).set({ autoUpdateDigest: null });
 if (phase === 'refused') { state.refuse = true; await db.update(services).set({ ownerUserId: 1 }); }
}
function holdWrite() {
 const entered = gate(), blocked = gate(); let used = false; const original = db.$client.execute.bind(db.$client);
 const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
  const s = args[0]; const sql = typeof s === 'string' ? s : s.sql;
  if (!used && /update "services" set "auto_update_digest"/i.test(sql)) { used = true; entered.release(); await blocked.promise; }
  return original(...args);
 }) as typeof original);
 return { entered: entered.promise, release: blocked.release, close: () => { blocked.release(); spy.mockRestore(); } };
}
for (const phase of ['baseline', 'refused', 'enqueued'] as const) for (const change of ['image', 'digest', 'disable', 'stop', 'type', 'delete'] as const) it(`${phase} publication respects ${change} at native write boundary`, async () => {
 await phaseSetup(phase); const held = holdWrite(); const run = sweepAutoUpdates(db, async () => 'sha256:new');
 try {
  await held.entered;
  if (change === 'image') await db.update(services).set({ image: 'redis:latest', autoUpdateDigest: null });
  else if (change === 'digest') await db.update(services).set({ autoUpdateDigest: 'sha256:replacement' });
  else if (change === 'disable') await db.update(services).set({ autoUpdate: false, autoUpdateDigest: null });
  else if (change === 'stop') await db.update(services).set({ status: 'stopped' });
  else if (change === 'type') await db.update(services).set({ type: 'pm2' });
  else await db.delete(services);
  const expected = await db.query.services.findFirst(); held.release(); await run; expect(await db.query.services.findFirst()).toEqual(expected);
 } finally { held.release(); await run; held.close(); }
});
for (const phase of ['baseline', 'refused', 'enqueued'] as const) it(`${phase} unchanged owner still records digest`, async () => {
 await phaseSetup(phase); const result = await sweepAutoUpdates(db, async () => 'sha256:new'); expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:new'); expect(result.enqueued).toBe(phase === 'enqueued' ? 1 : 0);
});
it('a stale first-observation writer preserves a newer independent baseline', async () => {
 await db.update(services).set({ autoUpdateDigest: null }); const held = holdWrite(); const stale = sweepAutoUpdates(db, async () => 'sha256:old-probe');
 try {
  await held.entered; expect((await sweepAutoUpdates(db, async () => 'sha256:fresh')).enqueued).toBe(0); held.release(); await stale;
  expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:fresh'); expect(await db.query.deployments.findMany()).toHaveLength(0);
 } finally { held.release(); await stale; held.close(); }
});
it('legacy empty-string baseline can still be replaced by its first observation', async () => {
 await db.update(services).set({ autoUpdateDigest: '' }); expect((await sweepAutoUpdates(db, async () => 'sha256:first')).enqueued).toBe(0); expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:first');
});
