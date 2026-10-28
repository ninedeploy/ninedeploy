/** G3.3 backup replica destinations (`lib/backupReplicas.ts`, the routes in `modules/backupPolicy.ts`) on a migrated SQLite. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupDestinations, databases, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const lib = await import('../../src/lib/backupReplicas.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { databaseBackupPolicyRoutes } = await import('../../src/modules/backupPolicy.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
  await db.insert(databases).values({ id: 3, name: 'pg', slug: 'pg', engine: 'postgres', passwordEncrypted: 'v1:x', ownerUserId: 1 } as never);
  await db.insert(backupDestinations).values([
    { id: 1, name: 'primary', endpoint: 'https://s3.a.example', bucket: 'a', prefix: 'nd', accessKeyId: 'k', secretKeyEncrypted: encrypt('s'), active: true },
    { id: 2, name: 'eu', endpoint: 'https://s3.b.example', bucket: 'b', prefix: 'nd/', accessKeyId: 'k', secretKeyEncrypted: encrypt('s'), active: false },
    { id: 4, name: 'us', endpoint: 'https://s3.c.example', bucket: 'c', prefix: 'copies', accessKeyId: 'k', secretKeyEncrypted: encrypt('s'), active: false },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

const at = (n: number) => () => new Date(Date.UTC(2026, 9, 1, 0, n));

describe('replicateBackup', () => {
  it('copies each dump to every replica and keeps each one to its own retention', async () => {
    await lib.setBackupReplicas(db, 3, [
      { destinationId: 2, retainCount: 2 },
      { destinationId: 4, retainCount: 1 },
    ]);
    const put = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    for (let i = 0; i < 3; i++) {
      expect(await lib.replicateBackup(db, 3, `/data/backups/pg-${i}.dump`, () => undefined, { put, remove, now: at(i) })).toBe(2);
    }
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'b', secretAccessKey: 's' }), 'nd/pg-0.dump', '/data/backups/pg-0.dump');
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'c' }), 'copies/pg-2.dump', '/data/backups/pg-2.dump');
    // eu keeps 2 (pg-0 pruned once pg-2 landed), us keeps 1 (pg-0, then pg-1 pruned).
    expect(remove.mock.calls.map(([cfg, key]) => `${(cfg as { bucket: string }).bucket}:${key}`).sort()).toEqual(['b:nd/pg-0.dump', 'c:copies/pg-0.dump', 'c:copies/pg-1.dump']);
    const view = await lib.getBackupReplicas(db, 3);
    expect(view.replicas).toEqual([
      { destinationId: 2, retainCount: 2, copies: 2, lastCopyAt: at(2)().toISOString(), lastError: null },
      { destinationId: 4, retainCount: 1, copies: 1, lastCopyAt: at(2)().toISOString(), lastError: null },
    ]);
  });

  it('records a failing destination without failing the others, and keeps a copy whose delete failed', async () => {
    await lib.setBackupReplicas(db, 3, [
      { destinationId: 2, retainCount: 1 },
      { destinationId: 4, retainCount: 1 },
    ]);
    const put = vi.fn(async (cfg: { bucket: string }) => {
      if (cfg.bucket === 'b') throw new Error('403 Forbidden');
    });
    const remove = vi.fn(async () => {
      throw new Error('timeout');
    });
    expect(await lib.replicateBackup(db, 3, '/b/pg-0.dump', () => undefined, { put: put as never, remove, now: at(0) })).toBe(1);
    await lib.replicateBackup(db, 3, '/b/pg-1.dump', () => undefined, { put: put as never, remove, now: at(1) });
    const view = await lib.getBackupReplicas(db, 3);
    expect(view.replicas[0]).toMatchObject({ destinationId: 2, copies: 0, lastError: '403 Forbidden' });
    // The delete of pg-0 at `us` failed: it stays in the log and is retried next time.
    expect(view.replicas[1]).toMatchObject({ destinationId: 4, copies: 2, lastError: 'timeout' });
  });

  it('does nothing without replicas, and reports a destination that was deleted', async () => {
    const put = vi.fn(async () => undefined);
    expect(await lib.replicateBackup(db, 3, '/b/x.dump', () => undefined, { put })).toBe(0);
    await lib.setBackupReplicas(db, 3, [{ destinationId: 99, retainCount: 3 }]);
    await lib.replicateBackup(db, 3, '/b/x.dump', () => undefined, { put });
    expect(put).not.toHaveBeenCalled();
    expect((await lib.getBackupReplicas(db, 3)).replicas[0]?.lastError).toMatch(/no longer exists/);
  });
});

describe('routes', () => {
  it('lets an operator set the list, refuses others, unknown destinations and duplicates', async () => {
    const app = await buildTestApp({ db });
    await app.register(databaseBackupPolicyRoutes, { prefix: '/databases' });
    const put = (payload: unknown, headers = asUser(1)) => app.inject({ method: 'PUT', url: '/databases/3/backup-replicas', headers, payload: payload as object });
    expect((await app.inject({ method: 'GET', url: '/databases/3/backup-replicas', headers: asUser(1) })).json()).toEqual({ databaseId: 3, replicas: [] });
    const ok = await put({ replicas: [{ destinationId: 2, retainCount: 14 }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().replicas[0]).toMatchObject({ destinationId: 2, retainCount: 14, copies: 0 });
    expect((await put({ replicas: [{ destinationId: 77, retainCount: 1 }] })).statusCode).toBe(400);
    expect((await put({ replicas: [{ destinationId: 2, retainCount: 1 }, { destinationId: 2, retainCount: 2 }] })).statusCode).toBe(400);
    expect((await put({ replicas: [1, 2, 3, 4].map((i) => ({ destinationId: i, retainCount: 1 })) })).statusCode).toBe(400);
    expect((await put({ replicas: [] }, asUser({ id: 1, isOperator: false }))).statusCode).toBe(403);
    await app.close();
  });
});
