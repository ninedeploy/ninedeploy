import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services, users, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from './githubAppKit.js';
import { sweepAutoUpdates } from '../../src/lib/autoUpdate.js';
const state = vi.hoisted(() => ({ refuse: false }));
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('../../src/lib/hostPrivilege.js', () => ({ assertMayDeployStoredService: vi.fn(async () => { if (state.refuse) throw new Error('controlled refusal'); }) }));
let db: DB;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
beforeEach(async () => {
 db = await migratedDb(); state.refuse = false;
 await db.insert(users).values({ id: 1, email: 'digest@example.test', passwordHash: 'x' });
 await db.insert(services).values({ id: 5, name: 'watched', slug: 'watched', type: 'docker', image: 'nginx:latest', status: 'running', autoUpdate: true, autoUpdateDigest: 'sha256:old' });
});
afterEach(() => { vi.restoreAllMocks(); closeMigratedDb(db); });
it('control: unchanged baseline and accepted update publish their digest', async () => {
 await db.update(services).set({ autoUpdateDigest: null }); await sweepAutoUpdates(db, async () => 'sha256:baseline'); expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:baseline');
 expect((await sweepAutoUpdates(db, async () => 'sha256:new')).enqueued).toBe(1); expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:new');
});
for (const phase of ['baseline', 'refused', 'enqueued'] as const) it(`${phase}: opt-out committed before digest write remains cleared`, async () => {
 if (phase === 'baseline') await db.update(services).set({ autoUpdateDigest: null });
 if (phase === 'refused') { state.refuse = true; await db.update(services).set({ ownerUserId: 1 }); }
 const entered = gate(), blocked = gate(); let used = false; const original = db.$client.execute.bind(db.$client);
 vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
  const s = args[0]; const sql = typeof s === 'string' ? s : s.sql;
  if (!used && /update "services" set "auto_update_digest"/i.test(sql)) { used = true; entered.release(); await blocked.promise; }
  return original(...args);
 }) as typeof original);
 const run = sweepAutoUpdates(db, async () => 'sha256:new');
 try {
  await entered.promise; await db.update(services).set({ autoUpdate: false, autoUpdateDigest: null }); const expected = await db.query.services.findFirst(); blocked.release(); await run;
  const actual = await db.query.services.findFirst(); console.log('EXPECTED: opt-out digest null; ACTUAL:', actual?.autoUpdate, actual?.autoUpdateDigest); console.log(actual?.autoUpdateDigest === null ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); expect(actual).toEqual(expected);
  expect(await db.query.deployments.findMany()).toHaveLength(phase === 'enqueued' ? 1 : 0);
 } finally { blocked.release(); await run; }
});

function holdWrite() {
 const entered = gate(), blocked = gate(); let used = false; const original = db.$client.execute.bind(db.$client);
 const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
  const s = args[0]; const sql = typeof s === 'string' ? s : s.sql;
  if (!used && /update "services" set "auto_update_digest"/i.test(sql)) { used = true; entered.release(); await blocked.promise; }
  return original(...args);
 }) as typeof original);
 return { entered: entered.promise, release: blocked.release, close: () => { blocked.release(); spy.mockRestore(); } };
}
it('a stale first-observation writer preserves a newer independent baseline', async () => {
 await db.update(services).set({ autoUpdateDigest: null }); const held = holdWrite(); const stale = sweepAutoUpdates(db, async () => 'sha256:old-probe');
 try {
  await held.entered; expect((await sweepAutoUpdates(db, async () => 'sha256:fresh')).enqueued).toBe(0); held.release(); await stale;
  expect((await db.query.services.findFirst())?.autoUpdateDigest).toBe('sha256:fresh'); expect(await db.query.deployments.findMany()).toHaveLength(0);
 } finally { held.release(); await stale; held.close(); }
});
