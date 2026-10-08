/**
 * 0.12 per-database backup policy in the scheduler: a database with a policy
 * row runs on its own cron with its own retention and destination; one
 * without keeps the built-in daily run (covered by backupScheduler.test.ts,
 * which runs on a DB with no policy table at all).
 */
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMock = vi.hoisted(() => ({ backupDatabase: vi.fn(async () => undefined) }));
vi.mock('../../src/engine/database.js', () => engineMock);
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/audit.js', () => auditMock);
const remoteMock = vi.hoisted(() => ({
  uploadBackup: vi.fn(async () => undefined),
  deleteRemoteBackupForRetention: vi.fn(async (): Promise<'deleted' | 'unknown-destination'> => 'deleted'),
}));
vi.mock('../../src/lib/backupRemote.js', () => remoteMock);

const tmp = path.join(os.tmpdir(), `nd-backup-policy-${process.pid}-${Date.now()}`);
mkdirSync(tmp, { recursive: true });
vi.stubEnv('NINEDEPLOY_DATA_DIR', tmp);

const { default: backupSchedulerPlugin } = await import('../../src/plugins/backupScheduler.js');
const { notifyBackupPolicyChanged } = await import('../../src/lib/backupPolicy.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Db { id: number; slug: string; name: string; status: string; createdAt?: Date }
interface Policy {
  databaseId: number; enabled: boolean; cron: string; retainCount: number;
  retainRemoteCount: number | null; destinationId: number | null; localOnly: boolean;
}
interface Row { id: number; databaseId: number; scope: string; status: string; path: string; remoteKey?: string | null; createdAt: Date }

const policy = (over: Partial<Policy> & { databaseId: number }): Policy => ({
  enabled: true, cron: '0 */6 * * *', retainCount: 7, retainRemoteCount: null, destinationId: null, localOnly: false, ...over,
});

function makeDb(state: { dbs: Db[]; policies: Policy[]; rows?: Row[] }) {
  const del = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  const setFn = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  const update = vi.fn(() => ({ set: setFn }));
  const db = {
    select: vi.fn(() => ({ from: vi.fn(async () => state.dbs) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1000 }]) })) })),
    delete: del,
    update,
    query: {
      backups: { findMany: vi.fn(async () => state.rows ?? []) },
      databaseBackupPolicies: { findMany: vi.fn(async () => state.policies) },
      // The scheduler reads one database by id; the fixtures key by position.
      databases: { findFirst: vi.fn(async () => state.dbs.find((d) => d.id === currentFire.id)) },
    },
  };
  return { db: db as never, del, update, setFn };
}

/** The policy cron that is firing — croner calls back per database id, and
 *  the fake `findFirst` cannot read a drizzle `where`, so the test pins it. */
const currentFire = { id: 0 };

async function boot(db: never) {
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  await app.register(backupSchedulerPlugin);
  return app;
}

const backedUp = () => (engineMock.backupDatabase.mock.calls as unknown as Array<[Db]>).map(([d]) => d.id);

beforeEach(() => {
  vi.useFakeTimers();
  // Local midnight, so a '0 */6 * * *' policy fires at +6h, +12h, …
  vi.setSystemTime(new Date(2026, 9, 8, 0, 0, 0));
  engineMock.backupDatabase.mockReset();
  remoteMock.uploadBackup.mockClear();
  remoteMock.deleteRemoteBackupForRetention.mockClear();
  auditMock.audit.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('backup scheduler — per-database policy', () => {
  it('runs a policy database on its own cron and leaves it out of the built-in daily run', async () => {
    const { db } = makeDb({
      dbs: [{ id: 1, slug: 'a', name: 'A', status: 'running' }, { id: 2, slug: 'b', name: 'B', status: 'running' }],
      policies: [policy({ databaseId: 2 })],
    });
    currentFire.id = 2;
    const app = await boot(db);
    try {
      await vi.advanceTimersByTimeAsync(6 * HOUR);
      expect(backedUp()).toEqual([2]);
      await vi.advanceTimersByTimeAsync(18 * HOUR);
      // 06/12/18/24h for B; the built-in daily tick covers only A.
      expect(backedUp().filter((id) => id === 2)).toHaveLength(4);
      expect(backedUp().filter((id) => id === 1)).toHaveLength(1);
      // Same audit as every scheduled backup (notification fan-out).
      expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), null, 'backup.create', 'B', { scope: 'scheduled' });
    } finally {
      await app.close();
    }
  });

  it('applies the policy retention count instead of the built-in 7', async () => {
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1, databaseId: 2, scope: 'scheduled', status: 'completed',
      path: path.join(tmp, `b-${i}.dump`), createdAt: new Date(Date.now() - i * HOUR),
    }));
    const { db, del } = makeDb({ dbs: [{ id: 2, slug: 'b', name: 'B', status: 'running' }], policies: [policy({ databaseId: 2, retainCount: 2 })], rows });
    currentFire.id = 2;
    const app = await boot(db);
    try {
      await vi.advanceTimersByTimeAsync(6 * HOUR);
      const deletes = del.mock.results.reduce((n, r) => n + (r.value as { where: ReturnType<typeof vi.fn> }).where.mock.calls.length, 0);
      expect(deletes).toBe(3); // 5 completed, keep 2
    } finally {
      await app.close();
    }
  });

  it('uploads to the destination the policy names, and not at all when local-only', async () => {
    const { db } = makeDb({
      dbs: [{ id: 2, slug: 'b', name: 'B', status: 'running' }],
      policies: [policy({ databaseId: 2, destinationId: 5 })],
    });
    currentFire.id = 2;
    const app = await boot(db);
    try {
      await vi.advanceTimersByTimeAsync(6 * HOUR);
      expect(remoteMock.uploadBackup).toHaveBeenCalledWith(expect.anything(), 1000, expect.any(String), expect.any(Function), { destinationId: 5 });
    } finally {
      await app.close();
    }

    remoteMock.uploadBackup.mockClear();
    const local = makeDb({ dbs: [{ id: 2, slug: 'b', name: 'B', status: 'running' }], policies: [policy({ databaseId: 2, localOnly: true })] });
    const app2 = await boot(local.db);
    try {
      await vi.advanceTimersByTimeAsync(6 * HOUR);
      expect(engineMock.backupDatabase).toHaveBeenCalled();
      expect(remoteMock.uploadBackup).not.toHaveBeenCalled();
    } finally {
      await app2.close();
    }
  });

  it('a disabled policy takes no scheduled backups and is exempt from the missed-backup watchdog', async () => {
    const old = new Date(Date.now() - 10 * DAY);
    const { db } = makeDb({
      dbs: [{ id: 2, slug: 'b', name: 'B', status: 'running', createdAt: old }],
      policies: [policy({ databaseId: 2, enabled: false })],
    });
    currentFire.id = 2;
    const app = await boot(db);
    try {
      await vi.advanceTimersByTimeAsync(2 * DAY);
      expect(engineMock.backupDatabase).not.toHaveBeenCalled();
      expect(auditMock.audit).not.toHaveBeenCalledWith(expect.anything(), null, 'backup.missed', expect.anything());
    } finally {
      await app.close();
    }
  });

  it('judges a weekly policy against its own cadence in the missed-backup watchdog', async () => {
    const created = new Date(Date.now() - 30 * DAY);
    const threeDaysAgo = new Date(Date.now() - 3 * DAY);
    const { db } = makeDb({
      dbs: [
        { id: 1, slug: 'a', name: 'A', status: 'running', createdAt: created },
        { id: 2, slug: 'w', name: 'W', status: 'running', createdAt: created },
      ],
      policies: [policy({ databaseId: 2, cron: '0 3 * * 0' })],
      rows: [
        { id: 1, databaseId: 1, scope: 'scheduled', status: 'completed', path: 'x', createdAt: threeDaysAgo },
        { id: 2, databaseId: 2, scope: 'scheduled', status: 'completed', path: 'y', createdAt: threeDaysAgo },
      ],
    });
    engineMock.backupDatabase.mockRejectedValue(new Error('no docker in tests'));
    currentFire.id = 2;
    const app = await boot(db);
    try {
      // Built-in anchor: 3 days overdue → first tick after the 5-minute grace.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), null, 'backup.missed', expect.stringContaining('A:'));
      expect(auditMock.audit).not.toHaveBeenCalledWith(expect.anything(), null, 'backup.missed', expect.stringContaining('W:'));
    } finally {
      await app.close();
    }
  });

  it('re-arms when a policy is saved, and disarms when it is disabled', async () => {
    const state = { dbs: [{ id: 2, slug: 'b', name: 'B', status: 'running' }], policies: [] as Policy[] };
    const { db } = makeDb(state);
    currentFire.id = 2;
    const app = await boot(db);
    try {
      state.policies = [policy({ databaseId: 2, cron: '0 * * * *' })];
      notifyBackupPolicyChanged(2);
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(backedUp()).toEqual([2]);

      state.policies = [policy({ databaseId: 2, cron: '0 * * * *', enabled: false })];
      notifyBackupPolicyChanged(2);
      await vi.advanceTimersByTimeAsync(5 * HOUR);
      expect(backedUp()).toEqual([2]);
    } finally {
      await app.close();
    }
  });

  it('trims remote copies past retainRemoteCount without dropping the local dumps', async () => {
    const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1, databaseId: 2, scope: 'scheduled', status: 'completed', remoteKey: `k/${i}`,
      path: path.join(tmp, `r-${i}.dump`), createdAt: new Date(Date.now() - i * HOUR),
    }));
    const { db, del, setFn } = makeDb({
      dbs: [{ id: 2, slug: 'b', name: 'B', status: 'running' }],
      policies: [policy({ databaseId: 2, retainCount: 3, retainRemoteCount: 1 })],
      rows,
    });
    currentFire.id = 2;
    const app = await boot(db);
    try {
      await vi.advanceTimersByTimeAsync(6 * HOUR);
      expect(remoteMock.deleteRemoteBackupForRetention).toHaveBeenCalledTimes(2);
      expect(setFn).toHaveBeenCalledWith({ remoteKey: null, destinationId: null });
      expect(del).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('a policy read error skips the built-in run instead of pruning a policy database to 7', async () => {
    const { db } = makeDb({ dbs: [{ id: 1, slug: 'a', name: 'A', status: 'running' }], policies: [] });
    (db as unknown as { query: { databaseBackupPolicies: { findMany: ReturnType<typeof vi.fn> } } }).query.databaseBackupPolicies.findMany
      .mockRejectedValue(new Error('SQLITE_BUSY'));
    const app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(backupSchedulerPlugin);
    const errorSpy = vi.spyOn(app.log, 'error');
    try {
      await vi.advanceTimersByTimeAsync(DAY);
      expect(engineMock.backupDatabase).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith({ err: expect.objectContaining({ message: 'SQLITE_BUSY' }) }, 'backup scheduler tick failed');
    } finally {
      await app.close();
    }
  });
});
