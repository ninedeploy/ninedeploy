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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('a recovery', () => {
  for (const pendingAdmission of [false, true]) {
    it(`enforces the global recovery limit while the first ${pendingAdmission ? 'admission waits' : 'recovery runs (control)'}`, async () => {
      const firstSource = await insertDb({ pitrEnabled: true });
      const secondSource = await insertDb({ slug: 'second-source', name: 'second-source', pitrEnabled: true });
      let entered!: () => void; let releaseAdmission!: () => void; let releaseReplay!: () => void;
      const entering = new Promise<void>((resolve) => { entered = resolve; });
      const admission = new Promise<void>((resolve) => { releaseAdmission = resolve; });
      const replay = new Promise<void>((resolve) => { releaseReplay = resolve; });
      const firstDone = settled(); const secondDone = settled();
      let volumeCalls = 0;
      const deps = fakeDeps({
        volumeExists: async () => { if (++volumeCalls === 1 && pendingAdmission) { entered(); await admission; } return false; },
        recover: vi.fn(async () => { await replay; return { baseBackup: 'synthetic', recoveredTo: 'synthetic', restoreMs: 1 }; }),
      });
      const first = startPitrRecovery(db, firstSource, { name: 'first-restored', targetTime: null }, userId, () => undefined, deps, firstDone.resolve);
      if (pendingAdmission) await entering; else await first;
      let secondAdmitted = false;
      let secondError: unknown;
      try {
        try {
          await startPitrRecovery(db, secondSource, { name: 'second-restored', targetTime: null }, userId, () => undefined, deps, secondDone.resolve);
          secondAdmitted = true;
        } catch (err) { secondError = err; }
        releaseAdmission(); await first;
        console.log('EXPECTED: rejected with pitr_recovery_busy; ACTUAL:', secondAdmitted ? 'second recovery admitted' : secondError); if (pendingAdmission) console.log(secondAdmitted ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED'); expect(secondError).toMatchObject({ statusCode: 409, code: 'pitr_recovery_busy' });
        expect(deps.recover).toHaveBeenCalledOnce();
      } finally {
        releaseAdmission(); await first;
        releaseReplay(); await firstDone.promise;
        if (secondAdmitted) await secondDone.promise;
      }
      expect(pitrBusy.recoveries()).toBe(0);
    });
  }


});
