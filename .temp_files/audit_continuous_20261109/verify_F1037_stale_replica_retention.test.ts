import { expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
import { backupDestinations } from '@ninedeploy/db';
import { getBackupReplicas, setBackupReplicas, replicateBackup } from '../../apps/server/src/lib/backupReplicas.js';
import { encrypt } from '../../apps/server/src/lib/crypto.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const now = (n: number) => () => new Date(Date.UTC(2026, 10, 9, 0, n));
it('gates policy changes during upload and deletion, preserves current policy and failure isolation', async () => {
  for (const phase of ['upload', 'delete'] as const) {
    for (const action of ['same', 'remove', 'raise', 'lower'] as const) {
      const db = await migratedDb();
      try {
        await db.insert(backupDestinations).values({ id: 2, name: 'replica', endpoint: 'https://fixture.invalid', bucket: 'replica', prefix: 'nd', accessKeyId: 'fixture', secretKeyEncrypted: encrypt('fixture') });
        await setBackupReplicas(db, 3, [{ destinationId: 2, retainCount: 3 }]);
        const noop = async () => undefined;
        for (let i = 0; i < 3; i++) await replicateBackup(db, 3, `/b/pg-${i}.dump`, noop, { put: noop, now: now(i) });
        const initial = phase === 'upload' && action === 'lower' ? 3 : 1;
        await setBackupReplicas(db, 3, [{ destinationId: 2, retainCount: initial }]);
        const entered = gate(), resume = gate();
        const deleted: string[] = [];
        const job = replicateBackup(db, 3, '/b/pg-3.dump', noop, {
          put: async () => { if (phase === 'upload') { entered.release(); await resume.promise; } },
          remove: async (_cfg, key) => { deleted.push(key); if (phase === 'delete' && deleted.length === 1) { entered.release(); await resume.promise; } },
          now: now(3),
        });
        await entered.promise;
        const keep = action === 'raise' ? 3 : action === 'lower' ? 1 : initial;
        try { if (action !== 'same') await setBackupReplicas(db, 3, action === 'remove' ? [] : [{ destinationId: 2, retainCount: keep }]); }
        finally { resume.release(); }
        expect(await job).toBe(1);
        const allowedDeletes = action === 'remove' ? (phase === 'delete' ? 1 : 0) : action === 'raise' ? 1 : 3;
        expect(deleted).toHaveLength(allowedDeletes);
        const view = await getBackupReplicas(db, 3);
        if (action === 'remove') expect(view.replicas).toEqual([]);
        else expect(view.replicas[0]).toMatchObject({ retainCount: keep, copies: 4 - allowedDeletes, lastError: null });
      } finally { closeMigratedDb(db); }
    }
  }
  const db = await migratedDb();
  try {
    const put = vi.fn();
    expect(await replicateBackup(db, 3, '/b/empty.dump', () => undefined, { put })).toBe(0); expect(put).not.toHaveBeenCalled();
    await db.insert(backupDestinations).values([
      { id: 2, name: 'failing', endpoint: 'https://fixture.invalid', bucket: 'a', prefix: 'nd', accessKeyId: 'fixture', secretKeyEncrypted: encrypt('fixture') },
      { id: 4, name: 'healthy', endpoint: 'https://fixture.invalid', bucket: 'b', prefix: 'nd', accessKeyId: 'fixture', secretKeyEncrypted: encrypt('fixture') },
    ]);
    await setBackupReplicas(db, 3, [{ destinationId: 2, retainCount: 1 }, { destinationId: 4, retainCount: 1 }]);
    expect(await replicateBackup(db, 3, '/b/x.dump', () => undefined, { put: async cfg => { if (cfg.bucket === 'a') throw new Error('upload refused'); }, now: now(9) })).toBe(1);
    expect((await getBackupReplicas(db, 3)).replicas.map(r => [r.copies, r.lastError])).toEqual([[0, 'upload refused'], [1, null]]);
    console.log('FIX VERIFIED');
  } finally { closeMigratedDb(db); }
});
