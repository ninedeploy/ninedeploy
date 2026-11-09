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
vi.mock('../../src/lib/audit.js', () => ({
  audit: vi.fn(async (_db: unknown, _actor: unknown, action: string, detail: string) => { audits.push({ action, detail }); }),
}));

import { encrypt } from '../../src/lib/crypto.js';
import type { HttpError } from '../../src/lib/errors.js';
import { PitrRefusal, parseArchiveListing, type PitrInventory } from '../../src/engine/postgresPitr.js';
import {
  failInterruptedPitrRecoveries, INTERRUPTED_RECOVERY_ERROR, pitrBusy, pitrDatabases, pitrMaintenance, pitrStatus, pitrUnavailable,
  prunePitrRecoveries, runPitrBaseBackup, setPitr, startPitrRecovery, type PitrDeps,
} from '../../src/lib/pitr.js';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
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

describe('who can use it', () => {
  it('PostgreSQL on the panel host, not a preview copy', () => {
    const base = { engine: 'postgres', serverId: null, previewCopyOf: null, previewServiceId: null };
    expect(pitrUnavailable(base)).toBeNull();
    expect(pitrUnavailable({ ...base, engine: 'mysql' })).toMatch(/PostgreSQL/);
    expect(pitrUnavailable({ ...base, serverId: 3 })).toMatch(/panel host/);
    expect(pitrUnavailable({ ...base, previewCopyOf: 1 })).toMatch(/preview/);
  });
});

describe('setPitr', () => {
  it('enables: restarts with archiving, audits, and takes the first base backup', async () => {
    const d = await insertDb();
    const deps = fakeDeps();
    const on = await setPitr(db, d, { enabled: true, retentionDays: 3 }, userId, () => undefined, deps);
    expect(on).toMatchObject({ pitrEnabled: true, pitrRetentionDays: 3 });
    expect(deps.calls.slice(0, 2)).toEqual(['stop main', 'start main pitr=true']);
    await vi.waitFor(async () => expect((await reload(d.id)).pitrBaseBackupAt).not.toBeNull());
    expect(deps.calls).toContain('base-backup main');
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['database.pitr_enable', 'database.pitr_base_backup']));
  });
  it('refuses what cannot archive, before touching the container', async () => {
    const deps = fakeDeps();
    const err = (p: Promise<unknown>) => p.then(() => null, (e: HttpError) => [e.statusCode, e.code]);
    expect(await err(setPitr(db, await insertDb({ slug: 'my', name: 'my', engine: 'mysql' }), { enabled: true }, userId, () => undefined, deps))).toEqual([422, 'pitr_unavailable']);
    expect(await err(setPitr(db, await insertDb({ slug: 'off', name: 'off', status: 'stopped' }), { enabled: true }, userId, () => undefined, deps))).toEqual([409, 'conflict']);
    expect(await err(setPitr(db, await insertDb({ slug: 'r', name: 'r' }), { enabled: true, retentionDays: 99 }, userId, () => undefined, deps))).toEqual([422, 'pitr_retention_invalid']);
    const d = await insertDb();
    expect(await err(setPitr(db, d, { enabled: true }, userId, () => undefined, fakeDeps({ preflight: async () => 'wal_level is minimal' })))).toEqual([422, 'pitr_preflight']);
    expect(await err(setPitr(db, d, { enabled: true }, userId, () => undefined, fakeDeps({ archiveExists: async () => true })))).toEqual([409, 'pitr_archive_exists']);
    expect(deps.calls).toEqual([]);
    expect((await reload(d.id)).pitrEnabled).toBe(false);
  });
  it('puts the database back without archiving when it does not start with it', async () => {
    const d = await insertDb();
    const deps = fakeDeps({
      start: vi.fn(async (row: Database) => { if (row.pitrEnabled) throw new Error('archive_command failed'); }),
    });
    await expect(setPitr(db, d, { enabled: true }, userId, () => undefined, deps)).rejects.toMatchObject({ statusCode: 422, code: 'pitr_start_failed' });
    expect(await reload(d.id)).toMatchObject({ pitrEnabled: false, status: 'running' });
    expect(deps.start).toHaveBeenCalledTimes(2);
    // When even that fails, the row says so.
    const worse = fakeDeps({ start: vi.fn(async () => { throw new Error('daemon down'); }) });
    await expect(setPitr(db, d, { enabled: true }, userId, () => undefined, worse)).rejects.toMatchObject({ code: 'pitr_start_failed' });
    expect((await reload(d.id)).status).toBe('error');
  });
  it('changes only the retention when the state is unchanged, and disables by deleting the archive', async () => {
    const d = await insertDb({ pitrEnabled: true, pitrBaseBackupAt: new Date(), pitrLastError: 'x' });
    const deps = fakeDeps();
    expect((await setPitr(db, d, { enabled: true, retentionDays: 14 }, userId, () => undefined, deps)).pitrRetentionDays).toBe(14);
    expect(deps.calls).toEqual([]);
    expect(audits.at(-1)).toMatchObject({ action: 'database.pitr_retention' });
    expect(await setPitr(db, await reload(d.id), { enabled: true }, userId, () => undefined, deps)).toMatchObject({ pitrRetentionDays: 14 });
    const off = await setPitr(db, await reload(d.id), { enabled: false }, userId, () => undefined, deps);
    expect(off).toMatchObject({ pitrEnabled: false, pitrBaseBackupAt: null, pitrLastError: null });
    expect(deps.calls).toEqual(['stop main', 'start main pitr=false', 'remove-archive main']);
    expect(audits.at(-1)).toMatchObject({ action: 'database.pitr_disable' });
  });
  it('disables a stopped database without starting it, and marks a failed restart', async () => {
    const stopped = await insertDb({ slug: 's', name: 's', status: 'stopped', pitrEnabled: true });
    const deps = fakeDeps();
    await setPitr(db, stopped, { enabled: false }, userId, () => undefined, deps);
    expect(deps.calls).toEqual(['remove-archive s']);
    const d = await insertDb({ pitrEnabled: true });
    await expect(setPitr(db, d, { enabled: false }, userId, () => undefined, fakeDeps({ start: async () => { throw new Error('boom'); } }))).rejects.toThrow('boom');
    expect((await reload(d.id)).status).toBe('error');
  });
});

describe('base backups', () => {
  it('runs one at a time per database and records a failure on the row', async () => {
    const d = await insertDb({ pitrEnabled: true });
    let release!: () => void;
    const slow = fakeDeps({ baseBackup: () => new Promise((r) => { release = () => r('nd-x'); }) });
    const first = runPitrBaseBackup(db, d, userId, () => undefined, slow);
    expect(pitrBusy.baseBackup(d.id)).toBe(true);
    await expect(runPitrBaseBackup(db, d, userId, () => undefined, slow)).rejects.toMatchObject({ statusCode: 409, code: 'pitr_base_backup_running' });
    release();
    expect(await first).toBe('nd-x');
    expect(pitrBusy.baseBackup(d.id)).toBe(false);
    await expect(runPitrBaseBackup(db, d, userId, () => undefined, fakeDeps({ baseBackup: async () => { throw new Error('disk full'); } }))).rejects.toThrow('disk full');
    expect((await reload(d.id)).pitrLastError).toMatch(/last base backup failed/);
    expect(audits.at(-1)).toMatchObject({ action: 'database.pitr_failure', detail: expect.stringMatching(/disk full/) });
  });
});

describe('pitrStatus', () => {
  it('reads nothing from Docker while off, and the window, base backups and archiver when on', async () => {
    const deps = fakeDeps();
    const off = await pitrStatus(await insertDb({ slug: 'o', name: 'o' }), deps);
    expect(off).toMatchObject({ available: true, enabled: false, recoverable: [], archiving: null });
    expect(deps.inventory).not.toHaveBeenCalled();
    const on = await pitrStatus(await insertDb({ pitrEnabled: true, pitrBaseBackupAt: new Date('2026-11-05T09:02:30Z') }), deps);
    expect(on).toMatchObject({
      enabled: true,
      lastBaseBackupAt: '2026-11-05T09:02:30.000Z',
      recoverable: [{ from: '2026-11-05T09:02:30.000Z', to: '2026-11-05T09:04:00.000Z' }],
      baseBackups: [{ label: 'nd-20261105T090200000Z', sizeBytes: 1000 }],
      archiveBytes: 81000,
      segmentCount: 2,
      archiving: { failing: false, archivedCount: 4 },
    });
    const unavailable = await pitrStatus(await insertDb({ slug: 'm', name: 'm', engine: 'mysql', pitrEnabled: true }), deps);
    expect(unavailable).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/PostgreSQL/) });
    const blind = await pitrStatus(await insertDb({ slug: 'b', name: 'b', pitrEnabled: true }), fakeDeps({ archiver: async () => { throw new Error('x'); } }));
    expect(blind.archiving).toBeNull();
  });
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
        expect(secondError).toMatchObject({ statusCode: 409, code: 'pitr_recovery_busy' });
        expect(deps.recover).toHaveBeenCalledOnce();
      } finally {
        releaseAdmission(); await first;
        releaseReplay(); await firstDone.promise;
        if (secondAdmitted) await secondDone.promise;
      }
      expect(pitrBusy.recoveries()).toBe(0);
    });
  }

  it('admits at once, then recovers, starts and probes the new database and records the evidence', async () => {
    const source = await insertDb({ pitrEnabled: true, memLimitMb: 512 });
    const deps = fakeDeps();
    const done = settled();
    const admitted = await startPitrRecovery(db, source, { name: 'Main restored', targetTime: new Date('2026-11-05T09:03:30Z') }, userId, () => undefined, deps, done.resolve);
    const pending = await reload(admitted.databaseId);
    expect(pending).toMatchObject({ slug: 'main-restored', status: 'creating', volumeName: 'nd-db-main-restored-data', memLimitMb: 512, ownerUserId: userId });
    expect(pending.passwordEncrypted).not.toBe(source.passwordEncrypted);
    expect(await done.promise).toEqual({ status: 'completed', error: null });
    expect(await reload(admitted.databaseId)).toMatchObject({ status: 'running', internalHost: 'nd-db-main-restored', internalPort: 5432 });
    const evidence = (await db.query.pitrRecoveries.findFirst({ where: eq(pitrRecoveries.id, admitted.recoveryId) }))!;
    expect(evidence).toMatchObject({ status: 'completed', sourceDatabaseId: source.id, databaseId: admitted.databaseId, baseBackup: 'nd-20261105T090200000Z', recoveredTo: '2026-11-05 09:03:10+00', restoreMs: 1234, requestedBy: userId });
    expect(evidence.targetTime?.toISOString()).toBe('2026-11-05T09:03:30.000Z');
    expect(deps.calls).toEqual(['recover main-restored', 'start main-restored pitr=false']);
    expect(pitrBusy.recoveries()).toBe(0);
  });
  it('removes the new database again when the archive refuses, keeping only the reason', async () => {
    const source = await insertDb({ pitrEnabled: true });
    const deps = fakeDeps({ recover: async () => { throw new PitrRefusal('Nothing after X has been archived yet.'); } });
    const done = settled();
    const admitted = await startPitrRecovery(db, source, { name: 'r1', targetTime: null }, userId, () => undefined, deps, done.resolve);
    expect(await done.promise).toEqual({ status: 'failed', error: 'Nothing after X has been archived yet.' });
    expect(await db.query.databases.findFirst({ where: eq(databases.id, admitted.databaseId) })).toBeUndefined();
    expect(deps.calls).toEqual(['remove-volume nd-db-r1-data']);
    expect((await db.query.pitrRecoveries.findFirst())!).toMatchObject({ status: 'failed', databaseId: null, error: 'Nothing after X has been archived yet.' });
    expect(audits.at(-1)).toMatchObject({ action: 'database.pitr_failure' });
  });
  it('stops a started database that does not accept its credentials; an unexpected error reads generic', async () => {
    const source = await insertDb({ pitrEnabled: true });
    const deps = fakeDeps({ probe: async () => false });
    const done = settled();
    await startPitrRecovery(db, source, { name: 'r2', targetTime: null }, userId, () => undefined, deps, done.resolve);
    expect(await done.promise).toEqual({ status: 'failed', error: 'The recovery failed; the panel log has the details.' });
    expect(deps.calls).toEqual(['recover r2', 'start r2 pitr=false', 'stop r2', 'remove-volume nd-db-r2-data']);
  });
  it('refuses before inserting anything', async () => {
    const off = await insertDb({ slug: 'off', name: 'off' });
    const err = (p: Promise<unknown>) => p.then(() => null, (e: HttpError) => [e.statusCode, e.code]);
    expect(await err(startPitrRecovery(db, off, { name: 'x', targetTime: null }, userId, () => undefined, fakeDeps()))).toEqual([422, 'pitr_disabled']);
    const source = await insertDb({ pitrEnabled: true });
    expect(await err(startPitrRecovery(db, source, { name: 'x', targetTime: new Date(Date.now() + 60_000) }, userId, () => undefined, fakeDeps()))).toEqual([422, 'pitr_target_future']);
    expect(await err(startPitrRecovery(db, source, { name: '!!!', targetTime: null }, userId, () => undefined, fakeDeps()))).toEqual([422, 'pitr_name_invalid']);
    expect(await err(startPitrRecovery(db, source, { name: 'main', targetTime: null }, userId, () => undefined, fakeDeps()))).toEqual([409, 'conflict']);
    expect(await err(startPitrRecovery(db, source, { name: 'x', targetTime: null }, userId, () => undefined, fakeDeps({ volumeExists: async () => true })))).toEqual([409, 'conflict']);
    expect(await err(startPitrRecovery(db, await insertDb({ slug: 'my', name: 'my', engine: 'mysql', pitrEnabled: true }), { name: 'x', targetTime: null }, userId, () => undefined, fakeDeps()))).toEqual([422, 'pitr_unavailable']);
    expect(await db.select().from(pitrRecoveries)).toEqual([]);
    // One at a time on the panel.
    let release!: () => void;
    const slow = fakeDeps({ recover: () => new Promise((r) => { release = () => r({ baseBackup: 'b', recoveredTo: 't', restoreMs: 1 }); }) });
    const done = settled();
    await startPitrRecovery(db, source, { name: 'first', targetTime: null }, userId, () => undefined, slow, done.resolve);
    expect(await err(startPitrRecovery(db, source, { name: 'second', targetTime: null }, userId, () => undefined, slow))).toEqual([409, 'pitr_recovery_busy']);
    // The source's archive is in use: disabling waits.
    expect(await err(setPitr(db, source, { enabled: false }, userId, () => undefined, slow))).toEqual([409, 'pitr_busy']);
    release();
    await done.promise;
  });
  it('fails, at boot, what a previous process left running, and removes its half-made database', async () => {
    const source = await insertDb({ pitrEnabled: true });
    const half = await insertDb({ slug: 'half', name: 'half', status: 'creating', volumeName: 'nd-db-half-data' });
    const kept = await insertDb({ slug: 'kept', name: 'kept', status: 'running' });
    await db.insert(pitrRecoveries).values([
      { sourceDatabaseId: source.id, databaseId: half.id, status: 'running' },
      { sourceDatabaseId: source.id, databaseId: kept.id, status: 'running' },
      { sourceDatabaseId: source.id, databaseId: null, status: 'completed' },
    ]);
    const deps = fakeDeps();
    expect(await failInterruptedPitrRecoveries(db, () => undefined, deps)).toBe(2);
    expect(deps.calls).toEqual(['stop half', 'remove-volume nd-db-half-data']);
    expect(await db.query.databases.findFirst({ where: eq(databases.id, half.id) })).toBeUndefined();
    const rows = await db.select().from(pitrRecoveries);
    expect(rows.map((r) => [r.status, r.databaseId, r.error])).toEqual([
      ['failed', null, INTERRUPTED_RECOVERY_ERROR],
      ['failed', kept.id, INTERRUPTED_RECOVERY_ERROR],
      ['completed', null, null],
    ]);
    expect(await failInterruptedPitrRecoveries(db, () => undefined, deps)).toBe(0);
  });
});

describe('the scheduler pass', () => {
  for (const action of ['base-backup', 'recovery', 'disable'] as const) {
    it(`refuses ${action} while archive pruning is gated`, async () => {
      const d = await insertDb({ pitrEnabled: true, pitrBaseBackupAt: new Date() });
      let entered!: () => void; let release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const done = settled(); let recoveryAdmitted = false;
      const deps = fakeDeps({ prune: async () => { entered(); await blocked; return { removedBases: [] }; } });
      const pruning = pitrMaintenance(db, d, () => undefined, deps);
      try {
        await waiting;
        let error: unknown;
        try {
          if (action === 'base-backup') await runPitrBaseBackup(db, d, userId, () => undefined, deps);
          if (action === 'disable') await setPitr(db, d, { enabled: false }, userId, () => undefined, deps);
          if (action === 'recovery') {
            await startPitrRecovery(db, d, { name: 'prune-copy', targetTime: null }, userId, () => undefined, deps, done.resolve);
            recoveryAdmitted = true;
          }
        } catch (err) { error = err; }
        expect(error).toMatchObject({ statusCode: 409, code: 'pitr_busy' });
        expect(deps.baseBackup).not.toHaveBeenCalled();
        expect(deps.recover).not.toHaveBeenCalled();
        expect(deps.removeArchive).not.toHaveBeenCalled();
      } finally { release(); await pruning; if (recoveryAdmitted) await done.promise; }
    });
  }

  it('control: an existing base backup suppresses pruning', async () => {
    const d = await insertDb({ pitrEnabled: true, pitrBaseBackupAt: new Date() });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const deps = fakeDeps({ baseBackup: async () => { await blocked; return 'synthetic'; } });
    const backup = runPitrBaseBackup(db, d, userId, () => undefined, deps);
    try { await pitrMaintenance(db, d, () => undefined, deps); expect(deps.prune).not.toHaveBeenCalled(); }
    finally { release(); await backup; }
  });

  for (const stage of ['archiver', 'baseBackup'] as const) {
    for (const changed of [false, true]) {
      it(`uses persisted retention after gated ${stage} (${changed ? 'changed' : 'control'})`, async () => {
        const d = await insertDb({ pitrEnabled: true, pitrRetentionDays: 1 });
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => { entered = resolve; });
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const deps = fakeDeps();
        const original = deps[stage];
        Object.assign(deps, { [stage]: async (...args: never[]) => {
          entered(); await blocked;
          return (original as (...input: never[]) => unknown)(...args);
        } });
        const running = pitrMaintenance(db, d, () => undefined, deps);
        try {
          await waiting;
          if (changed) await setPitr(db, await reload(d.id), { enabled: true, retentionDays: 14 }, userId, () => undefined, deps);
        } finally { release(); }
        await running;
        expect((await reload(d.id)).pitrRetentionDays).toBe(changed ? 14 : 1);
        expect(deps.prune).toHaveBeenCalledWith(expect.objectContaining({ pitrRetentionDays: changed ? 14 : 1 }), changed ? 14 : 1, expect.any(Function));
      });
    }
  }

  it('takes a base backup when the newest is a day old, then applies the retention', async () => {
    const d = await insertDb({ pitrEnabled: true, pitrRetentionDays: 5, pitrBaseBackupAt: new Date('2026-11-04T08:00:00Z') });
    const deps = fakeDeps();
    await pitrMaintenance(db, d, () => undefined, deps, Date.parse('2026-11-05T09:00:00Z'));
    expect(deps.calls).toEqual(['base-backup main', 'prune main 5']);
    const fresh = await reload(d.id);
    deps.calls.length = 0;
    await pitrMaintenance(db, fresh, () => undefined, deps, fresh.pitrBaseBackupAt!.getTime() + 60_000);
    expect(deps.calls).toEqual(['prune main 5']);
  });
  it('reports failing archiving once, skips the base backup, and clears the report when it recovers', async () => {
    const d = await insertDb({ pitrEnabled: true });
    const failing = fakeDeps({ archiver: async () => ({ archivedCount: 4, lastArchivedAt: new Date('2026-11-05T09:00:00Z'), failedCount: 2, lastFailedAt: new Date('2026-11-05T09:05:00Z') }) });
    await pitrMaintenance(db, d, () => undefined, failing);
    await pitrMaintenance(db, await reload(d.id), () => undefined, failing);
    expect((await reload(d.id)).pitrLastError).toMatch(/WAL archiving is failing \(last failure 2026-11-05T09:05:00.000Z\)/);
    expect(audits.filter((a) => a.action === 'database.pitr_failure')).toHaveLength(1);
    expect(failing.calls).toEqual([]);
    const healthy = fakeDeps();
    await pitrMaintenance(db, await reload(d.id), () => undefined, healthy);
    expect((await reload(d.id)).pitrLastError).toBeNull();
  });
  it('leaves alone what it does not look after, and keeps going when the retention fails', async () => {
    const deps = fakeDeps();
    await pitrMaintenance(db, await insertDb({ slug: 'o', name: 'o' }), () => undefined, deps);
    await pitrMaintenance(db, await insertDb({ slug: 's', name: 's', status: 'stopped', pitrEnabled: true }), () => undefined, deps);
    expect(deps.calls).toEqual([]);
    const logs: string[] = [];
    await pitrMaintenance(db, await insertDb({ pitrEnabled: true, pitrBaseBackupAt: new Date() }), (l) => logs.push(l), fakeDeps({ prune: async () => { throw new Error('ro fs'); } }));
    expect(logs).toEqual([expect.stringMatching(/retention failed for main: ro fs/)]);
    expect((await pitrDatabases(db)).map((r) => r.slug)).toEqual(['main']);
  });
  it('prunes finished recovery rows past the window, never a running one', async () => {
    const old = new Date('2025-01-01T00:00:00Z');
    await db.insert(pitrRecoveries).values([
      { status: 'completed', startedAt: old },
      { status: 'failed', startedAt: old },
      { status: 'running', startedAt: old },
      { status: 'completed', startedAt: new Date('2026-11-01T00:00:00Z') },
    ]);
    await prunePitrRecoveries(db, Date.parse('2026-11-05T00:00:00Z'));
    expect((await db.select().from(pitrRecoveries)).map((r) => r.status)).toEqual(['running', 'completed']);
  });
});
