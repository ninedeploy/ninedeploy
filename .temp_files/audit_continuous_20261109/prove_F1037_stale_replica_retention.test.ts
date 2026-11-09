import { expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
import { backupDestinations } from '@ninedeploy/db';
import { setBackupReplicas, replicateBackup } from '../../apps/server/src/lib/backupReplicas.js';
import { encrypt } from '../../apps/server/src/lib/crypto.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function scenario(edit: 'same' | 'remove' | 'raise') {
  const db = await migratedDb();
  const deleted: string[] = [];
  try {
    await db.insert(backupDestinations).values({ id: 2, name: 'replica', endpoint: 'https://fixture.invalid', bucket: 'replica', prefix: 'nd', accessKeyId: 'fixture', secretKeyEncrypted: encrypt('fixture') });
    await setBackupReplicas(db, 3, [{ destinationId: 2, retainCount: 1 }]);
    await replicateBackup(db, 3, '/backup/old.dump', () => undefined, { put: async () => undefined, now: () => new Date('2026-11-09T00:00:00Z') });
    const entered = gate(), finish = gate();
    const job = replicateBackup(db, 3, '/backup/new.dump', () => undefined, {
      put: async () => { entered.release(); await finish.promise; },
      remove: async (_cfg, key) => { deleted.push(key); },
      now: () => new Date('2026-11-09T01:00:00Z'),
    });
    await entered.promise;
    try {
      if (edit === 'remove') await setBackupReplicas(db, 3, []);
      if (edit === 'raise') await setBackupReplicas(db, 3, [{ destinationId: 2, retainCount: 2 }]);
    } finally { finish.release(); }
    expect(await job).toBe(1);
    return deleted;
  } finally { closeMigratedDb(db); }
}
it('does not delete a recovery point under policy withdrawn or raised while uploading', async () => {
  const control = await scenario('same'); expect(control).toEqual(['nd/old.dump']);
  console.log('CONTROL EXPECTED: unchanged keep=1 deletes old.dump | ACTUAL:', JSON.stringify(control));
  const removed = await scenario('remove'), raised = await scenario('raise');
  console.log('EXPECTED: removed-policy deletes=[]; raised-policy deletes=[] | ACTUAL:', JSON.stringify({ removed, raised }));
  console.log(removed.length || raised.length ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
  expect({ removed, raised }).toEqual({ removed: [], raised: [] });
});
