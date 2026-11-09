import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { servers, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from '../../apps/server/test/lib/githubAppKit.js';
vi.mock('../../apps/server/src/lib/crypto.js', () => ({ decrypt: (value: string) => value }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: vi.fn(async () => { throw new Error('no real docker'); }) }));
vi.mock('../../apps/server/src/lib/agentClient.js', () => ({ agentPing: vi.fn(async () => { throw new Error('must inject ping'); }), agentOp: vi.fn(async () => { throw new Error('must inject stats'); }) }));
const { createNodeHealthWatch, REMOTE_DISK_EVERY_MS: EVERY, REMOTE_DISK_MAX_AGE_MS: AGE } = await import('../../apps/server/src/lib/nodeHealth.js');
let db: DB;
const base = Date.UTC(2026, 10, 10);
const at = (ms: number) => new Date(base + ms);
const high = ['ND-DF /dev/sda1 1000 930 70 93% /'];
const panelDisk = async () => [{ where: 'panel', pct: 40 }];
beforeEach(async () => { db = await migratedDb(); await db.insert(servers).values({ id: 1, name: 'node', host: 'fixture', port: 4600, tokenEncrypted: 'token-fixture', status: 'online', lastSeenAt: at(0) }); });
afterEach(() => { vi.restoreAllMocks(); closeMigratedDb(db); });
it('serial poll cadence keeps last reading until the exact refresh boundary', async () => {
 const stats = vi.fn(async () => high); const watch = createNodeHealthWatch({ ping: async () => {}, stats, panelDisk });
 await watch.cycle(db, at(0)); await watch.cycle(db, at(EVERY - 1)); expect(stats).toHaveBeenCalledOnce(); await watch.cycle(db, at(EVERY)); expect(stats).toHaveBeenCalledTimes(2);
});
it('failed stats preserves prior reading through inclusive age, then expires it', async () => {
 const stats = vi.fn(async () => high); const watch = createNodeHealthWatch({ ping: async () => {}, stats, panelDisk }); await watch.cycle(db, at(0)); stats.mockRejectedValue(new Error('controlled stats outage'));
 expect((await watch.cycle(db, at(EVERY))).find(s => s.kind === 'disk')?.value).toBe(93);
 expect((await watch.cycle(db, at(AGE))).find(s => s.kind === 'disk')?.value).toBe(93);
 expect((await watch.cycle(db, at(AGE + 1))).find(s => s.kind === 'disk')?.value).toBe(40);
});
it('deleted node disappears on next serial registry snapshot', async () => {
 const watch = createNodeHealthWatch({ ping: async () => {}, stats: async () => high, panelDisk }); await watch.cycle(db, at(0)); await db.delete(servers);
 expect((await watch.cycle(db, at(1))).find(s => s.kind === 'disk')).toMatchObject({ value: 40, detail: 'panel 40%' });
});
it('pending node evicts prior cache and reapproval polls immediately', async () => {
 const stats = vi.fn(async () => high); const watch = createNodeHealthWatch({ ping: async () => {}, stats, panelDisk }); await watch.cycle(db, at(0)); await db.update(servers).set({ status: 'pending' });
 expect((await watch.cycle(db, at(1))).find(s => s.kind === 'disk')?.value).toBe(40); expect(stats).toHaveBeenCalledOnce(); await db.update(servers).set({ status: 'online' }); await watch.cycle(db, at(2)); expect(stats).toHaveBeenCalledTimes(2);
});
it('initial unknown registry emits local disk but no false fleet offline sample', async () => {
 vi.spyOn(db.query.servers, 'findMany').mockRejectedValueOnce(new Error('controlled registry failure')); const ping = vi.fn(async () => {}); const stats = vi.fn(async () => high); const watch = createNodeHealthWatch({ ping, stats, panelDisk });
 expect(await watch.cycle(db, at(0))).toEqual([{ serviceId: null, kind: 'disk', value: 40, detail: 'panel 40%' }]); expect(ping).not.toHaveBeenCalled(); expect(stats).not.toHaveBeenCalled();
});
it('malformed remote sample cannot replace a prior valid reading', async () => {
 const stats = vi.fn(async () => high); const watch = createNodeHealthWatch({ ping: async () => {}, stats, panelDisk }); await watch.cycle(db, at(0)); stats.mockResolvedValue(['ND-DF malformed']);
 expect((await watch.cycle(db, at(EVERY))).find(s => s.kind === 'disk')?.value).toBe(93);
});
