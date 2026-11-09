/**
 * R3: lib/pitr.ts against a real migrated SQLite, with the Docker steps
 * injected (`PitrDeps`): what enabling, disabling, base backups, the
 * scheduler pass and a recovery do to the rows, and what they refuse.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, databases, pitrRecoveries, users, type Database, type DB } from '@ninedeploy/db';

const audits = vi.hoisted(() => [] as Array<{ action: string; detail: string }>);
vi.mock('../../apps/server/src/lib/audit.js', () => ({
  audit: vi.fn(async (_db: unknown, _actor: unknown, action: string, detail: string) => { audits.push({ action, detail }); }),
}));

import { encrypt } from '../../apps/server/src/lib/crypto.js';
import type { HttpError } from '../../apps/server/src/lib/errors.js';
import { PitrRefusal, parseArchiveListing, type PitrInventory } from '../../apps/server/src/engine/postgresPitr.js';
import {
  failInterruptedPitrRecoveries, INTERRUPTED_RECOVERY_ERROR, pitrBusy, pitrDatabases, pitrMaintenance, pitrStatus, pitrUnavailable,
  prunePitrRecoveries, runPitrBaseBackup, setPitr, startPitrRecovery, type PitrDeps,
} from '../../apps/server/src/lib/pitr.js';

const MIGRATIONS = fileURLToPath(new URL('../../packages/db/src/migrations', import.meta.url));
let db: DB;
let close: () => void;
let dir: string;
let userId: number;

const inventory: PitrInventory = parseArchiveListing([
  `W wal/000000010000000000000003.gz 40000 ${Math.floor(Date.parse('2026-11-05T09:03:00Z') / 1000)}`,
  `W wal/000000010000000000000004.gz 40000 ${Math.floor(Date.parse('2026-11-05T09:04:00Z') / 1000)}`,
  `B base/nd-20261105T090200000Z/base.tar.gz 1000 ${Math.floor(Date.parse('2026-11-05T09:02:30Z') / 1000)}`,
  'H wal/000000010000000000000003.00000028.backup.gz',
  '| START WAL LOCATION: 0/3000028 (file 000000010000000000000003)',
  '| START TIME: 2026-11-05 09:02:00 UTC',
  '| LABEL: nd-20261105T090200000Z',
  '| STOP TIME: 2026-11-05 09:02:30 UTC',
].join('\n'));

function fakeDeps(over: Partial<PitrDeps> = {}): PitrDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps: PitrDeps = {
    start: vi.fn(async (d) => { calls.push(`start ${d.slug} pitr=${d.pitrEnabled}`); }),
    stop: vi.fn(async (d) => { calls.push(`stop ${d.slug}`); }),
    probe: vi.fn(async () => true),
    preflight: vi.fn(async () => null),
    archiveExists: vi.fn(async () => false),
    removeArchive: vi.fn(async (d) => { calls.push(`remove-archive ${d.slug}`); }),
    volumeExists: vi.fn(async () => false),
    removeVolume: vi.fn(async (name) => { calls.push(`remove-volume ${name}`); }),
    baseBackup: vi.fn(async (d) => { calls.push(`base-backup ${d.slug}`); return 'nd-20261105T100000000Z'; }),
    prune: vi.fn(async (d, days) => { calls.push(`prune ${d.slug} ${days}`); return { removedBases: [] }; }),
    inventory: vi.fn(async () => inventory),
    archiver: vi.fn(async () => ({ archivedCount: 4, lastArchivedAt: new Date('2026-11-05T09:04:00Z'), failedCount: 0, lastFailedAt: null })),
    recover: vi.fn(async (_s, t) => { calls.push(`recover ${t.slug}`); return { baseBackup: 'nd-20261105T090200000Z', recoveredTo: '2026-11-05 09:03:10+00', restoreMs: 1234 }; }),
    ...over,
  };
  return Object.assign(deps, { calls });
}

async function insertDb(over: Partial<typeof databases.$inferInsert> = {}): Promise<Database> {
  const [row] = await db.insert(databases).values({
    name: 'main', slug: 'main', engine: 'postgres', status: 'running', containerName: 'nd-db-main', volumeName: 'nd-db-main-data',
    username: 'nine', passwordEncrypted: encrypt('pw'), dbName: 'app', ownerUserId: userId, ...over,
  }).returning();
  return row!;
}
const reload = async (id: number) => (await db.query.databases.findFirst({ where: eq(databases.id, id) }))!;
const settled = () => {
  let resolve!: (o: { status: string; error: string | null }) => void;
  const promise = new Promise<{ status: string; error: string | null }>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(async () => {
  audits.length = 0;
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pitr-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  userId = (await db.insert(users).values({ email: 'admin@x.test', passwordHash: 'h' }).returning())[0]!.id;
});
afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}
for (const outcome of ['success', 'prune-error', 'log-error']) for (const action of ['backup', 'recover', 'disable']) {
  it(`independent ${action} admission recovers after ${outcome}`, async () => {
    const d = await insertDb({ pitrEnabled: true, pitrBaseBackupAt: new Date() });
    const entered = gate<void>(); const blocked = gate<void>();
    const deps = fakeDeps({ prune: vi.fn(async () => {
      entered.release(); await blocked.promise;
      if (outcome !== 'success') throw new Error('injected prune failure');
      return { removedBases: [] };
    }) });
    const pruning = pitrMaintenance(db, d, () => { if (outcome === 'log-error') throw new Error('injected logging failure'); }, deps).then(() => null, error => error);
    await entered.promise;
    try {
      expect(pitrBusy.prune(d.id)).toBe(true);
      const attempt = async () => {
        if (action === 'backup') return runPitrBaseBackup(db, d, userId, () => undefined, deps);
        if (action === 'disable') return setPitr(db, d, { enabled: false }, userId, () => undefined, deps);
        return startPitrRecovery(db, d, { name: 'recovery', targetTime: null }, userId, () => undefined, deps);
      };
      await expect(attempt()).rejects.toMatchObject({ statusCode: 409, code: 'pitr_busy' });
      await pitrMaintenance(db, d, () => undefined, deps);
      await pitrMaintenance(db, d, () => undefined, deps);
      expect(deps.prune).toHaveBeenCalledOnce();
      expect(await db.select().from(pitrRecoveries)).toHaveLength(0);
      expect((await reload(d.id)).pitrEnabled).toBe(true);
    } finally { blocked.release(); }
    const error = await pruning;
    if (outcome === 'log-error') expect(error?.message).toBe('injected logging failure'); else expect(error).toBeNull();
    expect(pitrBusy.prune(d.id)).toBe(false);
    if (action === 'backup') expect(await runPitrBaseBackup(db, d, userId, () => undefined, deps)).toBe('nd-20261105T100000000Z');
    if (action === 'disable') expect(await setPitr(db, d, { enabled: false }, userId, () => undefined, deps)).toMatchObject({ pitrEnabled: false });
    if (action === 'recover') {
      const done = settled();
      await startPitrRecovery(db, d, { name: 'retry-recovery', targetTime: null }, userId, () => undefined, deps, done.resolve);
      expect(await done.promise).toMatchObject({ status: 'completed' });
    }
  });
}
it('other archives and retention-only settings remain usable during pruning', async () => {
  const d = await insertDb({ pitrEnabled: true, pitrBaseBackupAt: new Date() });
  const other = await insertDb({ slug: 'other', name: 'other', pitrEnabled: true, pitrBaseBackupAt: new Date() });
  const entered = gate<void>(); const blocked = gate<void>();
  const deps = fakeDeps({ prune: async () => { entered.release(); await blocked.promise; return { removedBases: [] }; } });
  const pruning = pitrMaintenance(db, d, () => undefined, deps);
  await entered.promise;
  try {
    expect(await setPitr(db, d, { enabled: true, retentionDays: 14 }, userId, () => undefined, deps)).toMatchObject({ pitrRetentionDays: 14 });
    const otherDeps = fakeDeps();
    await pitrMaintenance(db, other, () => undefined, otherDeps);
    expect(otherDeps.prune).toHaveBeenCalledOnce();
    await runPitrBaseBackup(db, other, userId, () => undefined, otherDeps);
    const done = settled();
    await startPitrRecovery(db, other, { name: 'other-copy', targetTime: null }, userId, () => undefined, otherDeps, done.resolve);
    expect(await done.promise).toMatchObject({ status: 'completed' });
    expect(await setPitr(db, await reload(other.id), { enabled: false }, userId, () => undefined, otherDeps)).toMatchObject({ pitrEnabled: false });
    expect(pitrBusy.prune(d.id)).toBe(true);
  } finally { blocked.release(); await pruning; }
});
afterAll(() => console.log('FIX VERIFIED'));
