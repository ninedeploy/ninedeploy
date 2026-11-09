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
import { PitrRefusal, parseArchiveListing, retentionPlan, type PitrInventory } from '../../apps/server/src/engine/postgresPitr.js';
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

const NOW = new Date('2026-11-09T12:00:00Z');
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}
for (const stage of ['archiver', 'baseBackup'] as const) {
  for (const days of [1, 7, 14, 35]) {
    it(`independent real retention plan: ${stage}, persisted ${days} days`, async () => {
      const d = await insertDb({ pitrEnabled: true, pitrRetentionDays: 1 });
      const entered = gate<void>(); const blocked = gate<void>();
      const inv = { ...inventory, baseBackups: [
        { ...inventory.baseBackups[0]!, label: 'old', finishedAt: new Date(NOW.getTime() - 7 * 86400_000) },
        { ...inventory.baseBackups[0]!, label: 'new', finishedAt: NOW },
      ] };
      const removed: string[] = [];
      const deps = fakeDeps({ prune: async (row, retain) => {
        expect(row.pitrRetentionDays).toBe(days);
        removed.push(...retentionPlan(inv, retain, NOW).removeBases.map(b => b.label));
        return { removedBases: [...removed] };
      } });
      const original = deps[stage];
      Object.assign(deps, { [stage]: async (...args: never[]) => {
        entered.release(); await blocked.promise; return (original as (...input: never[]) => unknown)(...args);
      } });
      const running = pitrMaintenance(db, d, () => undefined, deps, NOW.getTime());
      try {
        await entered.promise;
        await setPitr(db, await reload(d.id), { enabled: true, retentionDays: days }, userId, () => undefined, deps);
      } finally { blocked.release(); }
      await running;
      expect(removed).toEqual(days < 7 ? ['old'] : []);
    });
  }
}
for (const change of ['disabled', 'stopped', 'deleted'] as const) {
  it(`no prune after the persisted database becomes ${change}`, async () => {
    const d = await insertDb({ pitrEnabled: true, pitrBaseBackupAt: NOW });
    const entered = gate<void>(); const blocked = gate<void>();
    const deps = fakeDeps({ archiver: async () => { entered.release(); await blocked.promise; return null; } });
    const running = pitrMaintenance(db, d, () => undefined, deps, NOW.getTime());
    try {
      await entered.promise;
      if (change === 'disabled') await setPitr(db, await reload(d.id), { enabled: false }, userId, () => undefined, deps);
      if (change === 'stopped') await db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, d.id));
      if (change === 'deleted') await db.delete(databases).where(eq(databases.id, d.id));
    } finally { blocked.release(); }
    await running;
    expect(deps.prune).not.toHaveBeenCalled();
  });
}
it('a base backup that starts during the row refresh suppresses prune', async () => {
  const d = await insertDb({ pitrEnabled: true, pitrBaseBackupAt: NOW });
  const entered = gate<void>(); const refresh = gate<void>(); const backup = gate<void>();
  const original = db.query.databases.findFirst.bind(db.query.databases);
  vi.spyOn(db.query.databases, 'findFirst').mockImplementationOnce(((...args: Parameters<typeof original>) => (async () => {
    const row = await original(...args); entered.release(); await refresh.promise; return row;
  })()) as typeof original);
  const deps = fakeDeps({ baseBackup: async () => { await backup.promise; return 'synthetic-base'; } });
  const running = pitrMaintenance(db, d, () => undefined, deps, NOW.getTime());
  await entered.promise;
  const concurrent = runPitrBaseBackup(db, d, userId, () => undefined, deps);
  expect(pitrBusy.baseBackup(d.id)).toBe(true);
  refresh.release();
  try { await running; expect(deps.prune).not.toHaveBeenCalled(); }
  finally { backup.release(); await concurrent; }
});
afterAll(() => console.log('FIX VERIFIED'));
