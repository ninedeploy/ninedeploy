/**
 * R3: engine/postgresPitr.ts — the archive listing, the recovery window and
 * plan, PostgreSQL's recovery log, retention, and the Docker steps of a base
 * backup, a retention pass and a recovery (Docker mocked; the real thing is
 * exercised by the hosted acceptance fixture).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@ninedeploy/db';

const docker = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; input?: string; timeoutMs?: number }>,
  running: new Set<string>(),
  volumes: new Set<string>(),
  listing: '',
  damaged: [] as string[],
  helperLog: [] as string[],
  /** What `pg_is_in_recovery()` answers, in turn; then the helper exits when `exits`. */
  recovery: [] as string[],
  exits: false,
  failBaseBackup: false,
  preflight: '16MB|replica',
  archiver: '12|1793871000|0|',
  /** pg_isready fails this many times before it answers. */
  notReady: 0,
}));

vi.mock('../../src/lib/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/exec.js')>('../../src/lib/exec.js');
  const answer = async (args: string[], opts: { timeoutMs?: number } = {}, input?: Buffer): Promise<string> => {
    docker.calls.push({ args, input: input?.toString(), timeoutMs: opts.timeoutMs });
    const script = args.includes('-c') ? args[args.indexOf('-c') + 1] ?? '' : '';
    if (script.includes('stat -c "W %n %s %Y"')) return docker.listing;
    if (script.includes('gzip -t')) return docker.damaged.map((s) => `${s}\n`).join('');
    if (args.includes('pg_isready')) {
      if (docker.notReady > 0) { docker.notReady--; throw new Error('no response'); }
      return '';
    }
    if (args.includes('pg_basebackup')) {
      if (docker.failBaseBackup) throw new Error('pg_basebackup: error: connection lost');
      return '';
    }
    if (args.includes('psql') && args.includes('-Atqc')) {
      const sql = args.at(-1)!;
      if (sql.includes('wal_segment_size')) return `${docker.preflight}\n`;
      if (sql.includes('pg_stat_archiver')) return `${docker.archiver}\n`;
      if (sql.includes('pg_is_in_recovery')) {
        const next = docker.recovery.shift();
        if (next === undefined && docker.exits) docker.running.delete(args[3]!);
        if (next === 'starting') throw new Error('FATAL: the database system is starting up');
        return `${next ?? 't'}\n`;
      }
    }
    if (args[0] === 'logs') return '';
    if (args[0] === 'ps') return `${'a'.repeat(64)}\n${'b'.repeat(64)}\n`;
    if (args[0] === 'inspect') return args[3] === 'a'.repeat(64) ? '2026-11-05T00:00:00Z /nd-pitr-0b0e4a9c-1111-4222-8333-944455556666\n' : '2026-11-05T09:00:00Z /nd-pitr-0b0e4a9c-1111-4222-8333-944455556677\n';
    if (args[0] === 'run' && args.includes('-d')) docker.running.add(args[args.indexOf('--name') + 1]!);
    return '';
  };
  return {
    ...actual,
    sleep: vi.fn(async () => undefined),
    capture: vi.fn(async (_cmd: string, args: string[], opts?: { timeoutMs?: number }, input?: Buffer) => answer(args, opts, input)),
    run: vi.fn(async (_cmd: string, args: string[], opts: { timeoutMs?: number }, sink: (line: string) => void) => {
      const out = await answer(args, opts);
      if (args[0] === 'logs') for (const line of docker.helperLog) sink(line);
      for (const line of out.split('\n').filter(Boolean)) sink(line);
    }),
  };
});
vi.mock('../../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined), pullDockerImage: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto.js')>('../../src/lib/crypto.js');
  return { ...actual, decrypt: (v: string) => v.replace(/^enc:/, '') };
});
vi.mock('../../src/engine/database.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/engine/database.js')>('../../src/engine/database.js');
  return {
    ...actual,
    containerRunning: vi.fn(async (name: string) => docker.running.has(name)),
    volumeExists: vi.fn(async (name: string) => docker.volumes.has(name)),
    createDockerVolume: vi.fn(async (name: string) => { docker.volumes.add(name); }),
    withDatabaseOperationLock: vi.fn(async (_id: number, _log: unknown, op: () => Promise<unknown>) => op()),
  };
});

import {
  archivingFailing, baseBackupLabel, contiguousRun, damagedSegments, lsnOrdinal, parseArchiveListing, parseSegment, PitrRefusal,
  pitrArchiverStats, pitrPreflight, planRecovery, prunePitrArchive, prunePitrRecoveryHelpers, readPitrInventory, readRecoveryLog,
  recoverableRanges, recoverPostgresToPoint, recoveryTargetTime, retentionPlan, segmentName, takePitrBaseBackup,
} from '../../src/engine/postgresPitr.js';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const seg = (n: number) => segmentName(1, n);
/** An archive listing: segments `from..to` archived a minute apart from 09:00, plus base backups. */
function listing(opts: { segments: number[]; bases?: Array<{ label: string; start: number; stop: string }>; pending?: string[]; parts?: string[] }): string {
  const lines: string[] = [];
  for (const n of opts.segments) lines.push(`W wal/${seg(n)}.gz 40000 ${at('2026-11-05T09:00:00Z') + n * 60}`);
  for (const b of opts.bases ?? []) {
    lines.push(`W wal/${seg(b.start)}.00000028.backup.gz 230 ${at(b.stop)}`);
    lines.push(`B base/${b.label}/base.tar.gz 4184641 ${at(b.stop)}`);
  }
  for (const p of opts.parts ?? []) lines.push(`W wal/${p} 100 ${at('2026-11-01T00:00:00Z')}`);
  for (const p of opts.pending ?? []) lines.push(`D base/${p}/ 4096 ${at('2026-11-01T00:00:00Z')}`);
  for (const b of opts.bases ?? []) {
    lines.push(`H wal/${seg(b.start)}.00000028.backup.gz`);
    lines.push(`| START WAL LOCATION: 0/${b.start.toString(16).toUpperCase()}000028 (file ${seg(b.start)})`);
    lines.push(`| STOP WAL LOCATION: 0/${b.start.toString(16).toUpperCase()}000120 (file ${seg(b.start)})`);
    lines.push(`| START TIME: ${b.stop.replace('T', ' ').replace('Z', '')} UTC`);
    lines.push(`| LABEL: ${b.label}`);
    lines.push('| START TIMELINE: 1');
    lines.push(`| STOP TIME: ${b.stop.replace('T', ' ').replace('Z', '')} UTC`);
  }
  return `${lines.join('\n')}\n`;
}

const B1 = { label: 'nd-20261105T090200000Z', start: 3, stop: '2026-11-05T09:02:30Z' };
const B2 = { label: 'nd-20261105T090800000Z', start: 8, stop: '2026-11-05T09:08:30Z' };

const row = (over: Partial<Database> = {}): Database => ({
  id: 7, name: 'main', slug: 'main', engine: 'postgres', version: null, status: 'running', containerName: 'nd-db-main', volumeName: 'nd-db-main-data',
  username: 'nine', passwordEncrypted: 'enc:old', dbName: 'app', memLimitMb: 0, cpuLimitMilli: 0, cpuShares: 0, ownerUserId: 1,
  pitrEnabled: true, pitrRetentionDays: 7, serverId: null, ...over,
} as unknown as Database);

beforeEach(() => {
  docker.calls = [];
  docker.running = new Set(['nd-db-main']);
  docker.volumes = new Set(['nd-db-main-data-wal']);
  docker.listing = listing({ segments: [1, 2, 3, 4, 5, 6], bases: [B1] });
  docker.damaged = [];
  docker.helperLog = [];
  docker.recovery = [];
  docker.exits = false;
  docker.failBaseBackup = false;
  docker.preflight = '16MB|replica';
  docker.archiver = '12|1793871000|0|';
  docker.notReady = 0;
});

describe('segment arithmetic (16 MiB segments)', () => {
  it('names and orders segments across a 4 GiB boundary and maps WAL locations to them', () => {
    expect(parseSegment('0000000100000000000000FF')).toEqual({ timeline: 1, ordinal: 255 });
    expect(parseSegment('000000010000000100000000')).toEqual({ timeline: 1, ordinal: 256 });
    expect(segmentName(2, 256)).toBe('000000020000000100000000');
    expect(parseSegment('000000010000000000000100')).toBeNull();
    expect(parseSegment('000000010000000000000003.00000028.backup')).toBeNull();
    expect(lsnOrdinal('0/40028C8')).toBe(4);
    expect(lsnOrdinal('1/FF000000')).toBe(511);
    expect(lsnOrdinal('not an lsn')).toBeNull();
    expect(recoveryTargetTime(new Date('2026-11-05T09:31:34.423Z'))).toBe('2026-11-05 09:31:34.423+00');
    expect(baseBackupLabel(new Date('2026-11-05T09:31:30.123Z'))).toBe('nd-20261105T093130123Z');
  });
});

describe('the archive listing', () => {
  it('counts a base backup only with its history file, and keeps pending directories and interrupted uploads apart', () => {
    const base = listing({
      segments: [1, 2, 3, 4],
      bases: [B1],
      pending: ['nd-20261101T000000000Z', 'not-a-label'],
      parts: [`${seg(5)}.gz.part`],
    });
    const text = `${base}B base/nd-20261105T091000000Z/base.tar.gz 99 ${at('2026-11-05T09:10:00Z')}\nW wal/00000002.history.gz 40 ${at('2026-11-05T09:10:00Z')}\ngarbage line\n`;
    const inv = parseArchiveListing(text);
    expect(inv.segments.map((s) => s.name)).toEqual([seg(1), seg(2), seg(3), seg(4)]);
    expect(inv.baseBackups).toEqual([
      expect.objectContaining({ label: B1.label, startSegment: seg(3), historyFile: `${seg(3)}.00000028.backup`, timeline: 1, finishedAt: new Date(B1.stop), sizeBytes: 4184641 }),
    ]);
    // A tarball without its history file is still running (or failed): pending.
    expect(inv.pendingBaseDirs.map((p) => p.label).sort()).toEqual(['nd-20261101T000000000Z', 'nd-20261105T091000000Z']);
    expect(inv.partialFiles.map((p) => p.name)).toEqual([`${seg(5)}.gz.part`]);
    expect(inv.archiveBytes).toBe(4 * 40000 + 230 + 4184641 + 100 + 99 + 40);
    expect(parseArchiveListing('')).toEqual({ segments: [], baseBackups: [], pendingBaseDirs: [], partialFiles: [], archiveBytes: 0 });
  });
  it('ignores a history file not named the way PostgreSQL names one: the archive is writable by the database superuser', () => {
    const text = listing({ segments: [3, 4], bases: [B1] }).replace(`H wal/${seg(3)}.00000028.backup.gz`, 'H wal/x"; rm -rf /; ".backup.gz');
    expect(parseArchiveListing(text).baseBackups).toEqual([]);
  });
  it('falls back to the tarball time when PostgreSQL wrote the history in another zone', () => {
    const text = listing({ segments: [3, 4], bases: [B1] }).replace(/(START|STOP) TIME: (.*) UTC/g, '$1 TIME: $2 CET');
    expect(parseArchiveListing(text).baseBackups[0]!.finishedAt).toEqual(new Date(B1.stop));
  });
});

describe('the recoverable window and the recovery plan', () => {
  it('spans from each base backup to the newest contiguous segment; a gap splits it', () => {
    const inv = parseArchiveListing(listing({ segments: [3, 4, 5, 8, 9, 10], bases: [B1, B2] }));
    expect(contiguousRun(inv, inv.baseBackups[0]!)).toMatchObject({ missing: seg(6) });
    expect(recoverableRanges(inv)).toEqual([
      { from: new Date(B1.stop), to: new Date('2026-11-05T09:05:00Z') },
      { from: new Date(B2.stop), to: new Date('2026-11-05T09:10:00Z') },
    ]);
    // A newer base backup past the gap still recovers to the latest point.
    const latest = planRecovery(inv, null);
    expect(latest).toMatchObject({ base: { label: B2.label }, newestOrdinal: 10 });
    expect((latest as { segments: Array<{ name: string }> }).segments.map((s) => s.name)).toEqual([seg(8), seg(9), seg(10)]);
    // A time inside the first range works from the first base; one in the gap is refused.
    expect(planRecovery(inv, new Date('2026-11-05T09:04:10Z'))).toMatchObject({ base: { label: B1.label } });
    expect(planRecovery(inv, new Date('2026-11-05T09:06:30Z'))).toEqual({ refusal: expect.stringMatching(new RegExp(`Segment ${seg(6)} is missing.*09:05:00Z`)) });
  });
  it('refuses what the archive cannot deliver, in words the operator can act on', () => {
    expect(planRecovery(parseArchiveListing(''), null)).toEqual({ refusal: expect.stringMatching(/No base backup has finished yet/) });
    const gone = parseArchiveListing(listing({ segments: [5, 6], bases: [B1] }));
    expect(planRecovery(gone, null)).toEqual({ refusal: expect.stringMatching(/no longer holds the WAL/) });
    const inv = parseArchiveListing(listing({ segments: [3, 4, 5, 6], bases: [B1] }));
    expect(planRecovery(inv, new Date('2026-11-05T09:01:00Z'))).toEqual({ refusal: expect.stringMatching(/No base backup finished before .*earliest recoverable point is 2026-11-05T09:02:30Z/) });
    expect(planRecovery(inv, new Date('2026-11-05T10:00:00Z'))).toEqual({ refusal: expect.stringMatching(/Nothing after .* has been archived yet/) });
    const holed = parseArchiveListing(listing({ segments: [3, 4, 6], bases: [B1] }));
    expect(planRecovery(holed, null)).toEqual({ refusal: expect.stringMatching(new RegExp(`Segment ${seg(5)} is missing.*stop before it without an error`)) });
    // A time target reads the segments up to the one archived after it, plus two.
    const plan = planRecovery(parseArchiveListing(listing({ segments: [3, 4, 5, 6, 7, 8, 9, 10], bases: [B1] })), new Date('2026-11-05T09:04:30Z'));
    expect((plan as { segments: Array<{ name: string }> }).segments.map((s) => s.name)).toEqual([seg(3), seg(4), seg(5), seg(6), seg(7)]);
  });
});

describe("PostgreSQL's recovery log", () => {
  it('finds where replay ended, where it stopped and why it gave up, ignoring the panel probes', () => {
    expect(readRecoveryLog([
      '2026-11-05 09:33:11.700 UTC [44] FATAL:  the database system is starting up',
      '2026-11-05 09:33:11.778 UTC [32] LOG:  recovery stopping before commit of transaction 756, time 2026-11-05 09:33:02.713224+00',
      '2026-11-05 09:33:11.778 UTC [32] LOG:  redo done at 0/4002830 system usage: CPU: user: 0.00 s',
    ])).toEqual({ redoDoneAt: '0/4002830', stoppedAt: '2026-11-05 09:33:02.713224+00', fatal: null });
    expect(readRecoveryLog(['FATAL:  recovery ended before configured recovery target was reached']).fatal).toBe('target-not-reached');
    expect(readRecoveryLog(['FATAL:  requested recovery stop point is before consistent recovery point']).fatal).toBe('before-consistent');
    expect(readRecoveryLog(['FATAL:  could not open file "pg_wal/x": Permission denied']).fatal).toBe('other');
  });
});

describe('retention', () => {
  it('keeps every base backup inside the window, and always the newest', () => {
    const inv = parseArchiveListing(listing({ segments: [3, 8], bases: [B1, B2] }));
    expect(retentionPlan(inv, 1, new Date('2026-11-05T12:00:00Z'))).toEqual({ removeBases: [], keepFrom: inv.baseBackups[0] });
    expect(retentionPlan(inv, 1, new Date('2026-11-06T09:05:00Z'))).toEqual({ removeBases: [inv.baseBackups[0]], keepFrom: inv.baseBackups[1] });
    expect(retentionPlan(inv, 1, new Date('2026-12-01T00:00:00Z'))).toEqual({ removeBases: [inv.baseBackups[0]], keepFrom: inv.baseBackups[1] });
    expect(retentionPlan(parseArchiveListing(''), 7, new Date())).toEqual({ removeBases: [], keepFrom: null });
  });
  it('removes old base backups, their history and the WAL before the oldest kept one, plus stale leftovers', async () => {
    docker.listing = listing({ segments: [3, 4, 8, 9], bases: [B1, B2], pending: ['nd-20261101T000000000Z'], parts: [`${seg(4)}.gz.part`, 'evil;rm.gz.part'] });
    const out = await prunePitrArchive(row(), 1, () => undefined, new Date('2026-11-06T09:05:00Z'));
    expect(out).toEqual({ removedBases: [B1.label] });
    const script = docker.calls.at(-1)!.args.at(-1)!;
    expect(docker.calls.at(-1)!.args.slice(0, 4)).toEqual(['exec', '-u', 'postgres', 'nd-db-main']);
    expect(script).toContain(`rm -rf "base/${B1.label}" "wal/${seg(3)}.00000028.backup.gz"`);
    expect(script).toContain('rm -rf "base/nd-20261101T000000000Z"');
    expect(script).toContain(`rm -f "wal/${seg(4)}.gz.part"`);
    expect(script).not.toContain('evil');
    expect(script).toContain(`pg_archivecleanup -x .gz /nd-wal-archive/wal ${seg(8)}`);
  });
  it('works on a stopped database through a one-off container with the archive writable', async () => {
    docker.running.clear();
    docker.listing = listing({ segments: [3, 8], bases: [B1, B2] });
    await prunePitrArchive(row(), 1, () => undefined, new Date('2026-11-06T09:05:00Z'));
    const last = docker.calls.at(-1)!.args;
    expect(last.slice(0, 2)).toEqual(['run', '--rm']);
    // The archive is not trusted: no network, no capabilities, no privilege gain.
    expect(last).toEqual(expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'postgres', 'nd-db-main-data-wal:/nd-wal-archive']));
    expect(last).not.toContain('--cap-add');
    // Reads mount it read-only.
    expect(docker.calls[0]!.args).toContain('nd-db-main-data-wal:/nd-wal-archive:ro');
  });
  it('lists nothing for a database without an archive volume', async () => {
    docker.volumes.clear();
    expect((await readPitrInventory(row())).segments).toEqual([]);
    expect(docker.calls).toEqual([]);
  });
});

describe('base backups, preflight and archiver health', () => {
  it('waits for the server, then runs pg_basebackup in the container over the socket, into a labelled directory', async () => {
    docker.notReady = 2;
    const label = await takePitrBaseBackup(row(), () => undefined, new Date('2026-11-05T09:31:30.123Z'));
    expect(label).toBe('nd-20261105T093130123Z');
    expect(docker.calls.filter((c) => c.args.includes('pg_isready'))).toHaveLength(3);
    expect(docker.calls.find((c) => c.args.includes('pg_basebackup'))!.args).toEqual([
      'exec', '-u', 'postgres', 'nd-db-main', 'pg_basebackup', '-h', '/var/run/postgresql', '-U', 'nine',
      '-D', '/nd-wal-archive/base/nd-20261105T093130123Z', '-Ft', '-z', '-X', 'none', '-c', 'fast', '-l', 'nd-20261105T093130123Z',
    ]);
  });
  it('removes the partial directory when the backup fails, and refuses a stopped database', async () => {
    docker.failBaseBackup = true;
    await expect(takePitrBaseBackup(row(), () => undefined, new Date('2026-11-05T09:31:30.123Z'))).rejects.toThrow(/connection lost/);
    expect(docker.calls.at(-1)!.args).toEqual(['exec', '-u', 'postgres', 'nd-db-main', 'rm', '-rf', '/nd-wal-archive/base/nd-20261105T093130123Z']);
    docker.running.clear();
    await expect(takePitrBaseBackup(row(), () => undefined)).rejects.toThrow(/not running/);
    docker.running.add('nd-db-main');
    docker.notReady = 5;
    const backups = () => docker.calls.filter((c) => c.args.includes('pg_basebackup')).length;
    const before = backups();
    await expect(takePitrBaseBackup(row(), () => undefined, new Date(), { attempts: 3, pollMs: 0 })).rejects.toThrow(/did not accept connections/);
    // A server that never answered gets no backup attempt.
    expect(backups()).toBe(before);
  });
  it('refuses a cluster it cannot archive, and reads pg_stat_archiver', async () => {
    expect(await pitrPreflight(row())).toBeNull();
    docker.preflight = '64MB|replica';
    expect(await pitrPreflight(row())).toMatch(/64MB WAL segments/);
    docker.preflight = '16MB|minimal';
    expect(await pitrPreflight(row())).toMatch(/wal_level is minimal/);
    expect(await pitrArchiverStats(row())).toEqual({ archivedCount: 12, lastArchivedAt: new Date(1793871000 * 1000), failedCount: 0, lastFailedAt: null });
    docker.archiver = '12|1793871000|3|1793871060';
    const failing = await pitrArchiverStats(row());
    expect(archivingFailing(failing)).toBe(true);
    expect(archivingFailing({ ...failing!, lastFailedAt: new Date(1793870000 * 1000) })).toBe(false);
    expect(archivingFailing(null)).toBe(false);
    docker.running.clear();
    expect(await pitrPreflight(row())).toMatch(/must be running/);
    expect(await pitrArchiverStats(row())).toBeNull();
  });
  it('checks segments with gzip -t, names passed as arguments', async () => {
    docker.damaged = [seg(4)];
    expect(await damagedSegments(row(), [seg(3), seg(4)], () => undefined)).toEqual([seg(4)]);
    expect(docker.calls[0]!.args.slice(-2)).toEqual([seg(3), seg(4)]);
    await expect(damagedSegments(row(), ['$(reboot)'], () => undefined)).rejects.toThrow(/not a segment name/);
    expect(await damagedSegments(row(), [], () => undefined)).toEqual([]);
  });
  it('sweeps only labelled, exactly named helpers older than the cut-off', async () => {
    expect(await prunePitrRecoveryHelpers(7 * 60 * 60_000, Date.parse('2026-11-05T10:00:00Z'))).toBe(1);
    expect(docker.calls.filter((c) => c.args[0] === 'rm').map((c) => c.args)).toEqual([['rm', '-f', 'a'.repeat(64)]]);
  });
});

describe('a recovery into a new database', () => {
  const target = row({ id: 8, name: 'restored', slug: 'restored', containerName: 'nd-db-restored', volumeName: 'nd-db-restored-data', passwordEncrypted: 'enc:new-secret' });
  const opts = { now: (() => { let t = 0; return () => (t += 1000); })(), pollMs: 0, timeoutMs: 60_000 };

  it('restores the base backup, replays to the end of the archive, re-keys the role and stops cleanly', async () => {
    docker.recovery = ['starting', 't', 'f'];
    docker.helperLog = ['LOG:  redo done at 0/6002830 system usage', 'LOG:  archive recovery complete'];
    const out = await recoverPostgresToPoint(row(), target, null, () => undefined, { ...opts, now: (() => { let t = 0; return () => (t += 1000); })() });
    expect(out).toMatchObject({ baseBackup: B1.label, recoveredTo: 'the end of the archive (0/6002830)' });
    expect(docker.volumes.has('nd-db-restored-data')).toBe(true);
    const prepare = docker.calls.find((c) => c.args.includes('prepare'))!;
    expect(prepare.args).toContain('nd-db-main-data-wal:/nd-wal-archive:ro');
    expect(prepare.args.slice(-4)).toEqual(['prepare', '/var/lib/postgresql/18/docker', `/nd-wal-archive/base/${B1.label}/base.tar.gz`, '/var/lib/postgresql']);
    expect(prepare.input).toContain(`restore_command = 'gzip -dc /nd-wal-archive/wal/%f.gz > "%p"'`);
    expect(prepare.input).toContain("recovery_target_action = 'promote'");
    expect(prepare.input).not.toMatch(/recovery_target_time =/);
    const helper = docker.calls.find((c) => c.args[0] === 'run' && c.args.includes('-d'))!.args;
    expect(helper).toEqual(expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'postgres', '--label', 'ninedeploy.role=pitr-recovery', '-c', 'listen_addresses=', '-c', 'archive_mode=off']));
    expect(helper).not.toContain('--cap-add');
    // Root only to own the restored files.
    expect(prepare.args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--user', '0']));
    const rekey = docker.calls.find((c) => c.args.includes('-f'))!;
    expect(rekey.input).toContain(`ALTER ROLE "nine" WITH PASSWORD 'new-secret'`);
    expect(rekey.input).toContain('ALTER SYSTEM RESET restore_command;');
    // The password never reaches argv.
    expect(docker.calls.some((c) => c.args.some((a) => a.includes('new-secret')))).toBe(false);
    expect(docker.calls.some((c) => c.args[0] === 'stop')).toBe(true);
    expect(docker.calls.at(-1)!.args.slice(0, 2)).toEqual(['rm', '-f']);
  });

  it('replays up to a time and reports the transaction PostgreSQL stopped before', async () => {
    docker.recovery = ['f'];
    docker.helperLog = ['LOG:  recovery stopping before commit of transaction 756, time 2026-11-05 09:04:02.713224+00', 'LOG:  redo done at 0/4002830'];
    const out = await recoverPostgresToPoint(row(), target, new Date('2026-11-05T09:04:00Z'), () => undefined, { ...opts, now: (() => { let t = 0; return () => (t += 1000); })() });
    expect(out.recoveredTo).toBe('2026-11-05 09:04:02.713224+00');
    expect(docker.calls.find((c) => c.args.includes('prepare'))!.input).toContain("recovery_target_time = '2026-11-05 09:04:00.000+00'");
  });

  it('refuses a "latest" recovery that stopped before the newest archived segment', async () => {
    docker.recovery = ['f'];
    docker.helperLog = ['LOG:  redo done at 0/4002830'];
    await expect(recoverPostgresToPoint(row(), target, null, () => undefined, { ...opts, now: (() => { let t = 0; return () => (t += 1000); })() }))
      .rejects.toThrow(new RegExp(`stopped in segment ${seg(4)}, before the newest archived segment ${seg(6)}`));
    expect(docker.calls.at(-1)!.args.slice(0, 2)).toEqual(['rm', '-f']);
  });

  it("maps PostgreSQL's refusals and a stopped replay to clear reasons", async () => {
    for (const [line, expected] of [
      ['FATAL:  recovery ended before configured recovery target was reached', /does not reach .*no transaction after it has been archived/],
      ['FATAL:  requested recovery stop point is before consistent recovery point', /before the base backup .* became consistent/],
    ] as const) {
      docker.volumes.delete('nd-db-restored-data');
      docker.exits = true;
      docker.helperLog = [line];
      const err = await recoverPostgresToPoint(row(), target, new Date('2026-11-05T09:04:00Z'), () => undefined, { ...opts, now: (() => { let t = 0; return () => (t += 1000); })() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PitrRefusal);
      expect((err as Error).message).toMatch(expected);
    }
    docker.volumes.delete('nd-db-restored-data');
    docker.helperLog = ['FATAL:  could not open file'];
    const logged: string[] = [];
    await expect(recoverPostgresToPoint(row(), target, null, (l) => logged.push(l), { ...opts, now: (() => { let t = 0; return () => (t += 1000); })() })).rejects.toThrow('PostgreSQL stopped during the WAL replay');
    expect(logged).toContain('postgres: FATAL:  could not open file');
  });

  it('stops a replay that runs past its time limit', async () => {
    docker.recovery = Array.from({ length: 100 }, () => 't');
    await expect(recoverPostgresToPoint(row(), target, null, () => undefined, { now: (() => { let t = 0; return () => (t += 30_000); })(), pollMs: 0, timeoutMs: 60_000 }))
      .rejects.toThrow('The WAL replay did not finish in time');
  });

  it('refuses before creating anything: an unreachable plan, a damaged segment, an existing volume', async () => {
    await expect(recoverPostgresToPoint(row(), target, new Date('2026-11-05T08:00:00Z'), () => undefined, opts)).rejects.toBeInstanceOf(PitrRefusal);
    docker.damaged = [seg(5)];
    await expect(recoverPostgresToPoint(row(), target, null, () => undefined, opts)).rejects.toThrow(new RegExp(`Segment ${seg(5)} in the archive is damaged`));
    docker.damaged = [];
    docker.volumes.add('nd-db-restored-data');
    await expect(recoverPostgresToPoint(row(), target, null, () => undefined, opts)).rejects.toThrow(/already exists/);
    expect(docker.calls.some((c) => c.args.includes('prepare'))).toBe(false);
  });
});
