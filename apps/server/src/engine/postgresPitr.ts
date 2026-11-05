/**
 * R3: PostgreSQL point-in-time recovery for databases on the panel host.
 *
 * With `databases.pitr_enabled` the database container archives every
 * finished WAL segment into its archive volume (engine/pitrArchive.ts), and
 * the panel takes `pg_basebackup` base backups into the same volume. A
 * recovery never touches the source: it restores a base backup into a NEW
 * database's volume, replays the archived WAL up to the requested time (or
 * to the end of the archive) in a networkless helper, and only then starts
 * the new database normally.
 *
 * PostgreSQL itself refuses a target it cannot reach ("recovery ended before
 * configured recovery target was reached"). It does NOT refuse a recovery to
 * the end of the archive that stops early at a missing or damaged segment: it
 * promotes there, silently. So the panel checks the segments it needs before
 * the replay (a contiguous run, each `gzip -t` clean) and, for "latest",
 * that the replay ended in the newest archived segment.
 *
 * Segment arithmetic assumes the default 16 MiB WAL segments; enabling PITR
 * refuses a cluster initialised with another size.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '@ninedeploy/db';
import { decrypt } from '../lib/crypto.js';
import { ensureDockerImage } from '../lib/dockerPull.js';
import { capture, run, sleep } from '../lib/exec.js';
import {
  containerRunning,
  createDockerVolume,
  databaseVolumeLabels,
  ENGINES,
  resolveDataDir,
  resolveVolumePath,
  volumeExists,
  withDatabaseOperationLock,
} from './database.js';
import { PITR_ARCHIVE_MOUNT, PITR_BASE_DIR, PITR_HELPER_FLAGS, PITR_OWNERSHIP_CAPS, PITR_RESTORE_COMMAND, PITR_WAL_DIR, pitrArchiveVolume } from './pitrArchive.js';

const swallow = () => {};

/** A refusal the operator can act on: shown as is, never with PostgreSQL's own log lines. */
export class PitrRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PitrRefusal';
  }
}

// ── segments ──────────────────────────────────────────────────────────────

const SEGMENT = /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$/;
/** 16 MiB segments per 4 GiB WAL "xlogid". */
const SEGMENTS_PER_ID = 0x100;
export const PITR_SEGMENT_BYTES = 16 * 1024 * 1024;

/** A segment's timeline and position (its ordinal in the WAL stream), or null for any other file name. */
export function parseSegment(name: string): { timeline: number; ordinal: number } | null {
  const m = SEGMENT.exec(name);
  if (!m) return null;
  const low = Number.parseInt(m[3]!, 16);
  if (low >= SEGMENTS_PER_ID) return null;
  return { timeline: Number.parseInt(m[1]!, 16), ordinal: Number.parseInt(m[2]!, 16) * SEGMENTS_PER_ID + low };
}

export function segmentName(timeline: number, ordinal: number): string {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');
  return `${hex(timeline)}${hex(Math.floor(ordinal / SEGMENTS_PER_ID))}${hex(ordinal % SEGMENTS_PER_ID)}`;
}

/** The ordinal of the segment holding WAL location `hi/lo` (as PostgreSQL prints it). */
export function lsnOrdinal(lsn: string): number | null {
  const m = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(lsn.trim());
  if (!m) return null;
  return Number.parseInt(m[1]!, 16) * SEGMENTS_PER_ID + Math.floor(Number.parseInt(m[2]!, 16) / PITR_SEGMENT_BYTES);
}

// ── inventory ─────────────────────────────────────────────────────────────

export interface PitrSegment { name: string; timeline: number; ordinal: number; sizeBytes: number; archivedAt: Date }
export interface PitrBaseBackup {
  label: string;
  /** The segment replay starts from, and the history file naming it. */
  startSegment: string;
  historyFile: string;
  timeline: number;
  startedAt: Date;
  /** The backup is consistent from here on: the earliest point it can recover to. */
  finishedAt: Date;
  sizeBytes: number;
}
export interface PitrInventory {
  segments: PitrSegment[];
  baseBackups: PitrBaseBackup[];
  /** Base backup directories without a finished backup (running, or failed), with their mtime. */
  pendingBaseDirs: Array<{ label: string; modifiedAt: Date }>;
  /** Interrupted uploads (`*.gz.part`) with their mtime. */
  partialFiles: Array<{ name: string; modifiedAt: Date }>;
  archiveBytes: number;
}

/** "2026-11-05 09:31:31 UTC" as PostgreSQL writes it into a backup history file. */
function historyTime(value: string | undefined): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? (?:UTC|GMT)$/.exec(value?.trim() ?? '');
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

const LABEL = /^nd-[0-9TZ]{16,24}$/;
/** A backup history file as PostgreSQL names it; anything else in the archive is not one of ours. */
const HISTORY_FILE = /^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$/;

/**
 * Parse the listing {@link ARCHIVE_LISTING} prints. A base backup counts only
 * once PostgreSQL archived its history file (the backup finished and its
 * last segment is in the archive); a directory without one is pending.
 */
export function parseArchiveListing(text: string): PitrInventory {
  const segments: PitrSegment[] = [];
  const tarballs = new Map<string, { sizeBytes: number; modifiedAt: Date }>();
  const pending: Array<{ label: string; modifiedAt: Date }> = [];
  const partialFiles: Array<{ name: string; modifiedAt: Date }> = [];
  const histories: Array<{ file: string; fields: Map<string, string> }> = [];
  let archiveBytes = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('| ')) {
      const field = /^\| ([A-Z ]+): (.*)$/.exec(line);
      if (field && histories.length) histories.at(-1)!.fields.set(field[1]!, field[2]!);
      continue;
    }
    const [kind, path, size, mtime] = line.trim().split(' ');
    const sizeBytes = Number(size);
    const modifiedAt = new Date(Number(mtime) * 1000);
    if (kind === 'H' && path) {
      // File names come from a directory the database's superuser can write:
      // only PostgreSQL's own pattern ever reaches a command.
      const file = path.replace(/^wal\//, '').replace(/\.gz$/, '');
      histories.push({ file: HISTORY_FILE.test(file) ? file : '', fields: new Map() });
      continue;
    }
    if (!path || !Number.isFinite(sizeBytes) || Number.isNaN(modifiedAt.getTime())) continue;
    if (kind === 'W') {
      archiveBytes += sizeBytes;
      const file = path.replace(/^wal\//, '');
      if (file.endsWith('.part')) { partialFiles.push({ name: file, modifiedAt }); continue; }
      const segment = parseSegment(file.replace(/\.gz$/, ''));
      if (segment && file.endsWith('.gz')) segments.push({ name: file.replace(/\.gz$/, ''), ...segment, sizeBytes, archivedAt: modifiedAt });
    } else if (kind === 'B') {
      archiveBytes += sizeBytes;
      const label = /^base\/([^/]+)\/base\.tar\.gz$/.exec(path)?.[1];
      if (label && LABEL.test(label)) tarballs.set(label, { sizeBytes, modifiedAt });
    } else if (kind === 'D') {
      const label = /^base\/([^/]+)\/?$/.exec(path)?.[1];
      if (label && LABEL.test(label)) pending.push({ label, modifiedAt });
    }
  }
  segments.sort((a, b) => a.timeline - b.timeline || a.ordinal - b.ordinal);
  const baseBackups: PitrBaseBackup[] = [];
  for (const { file, fields } of histories) {
    const label = fields.get('LABEL');
    const tarball = label ? tarballs.get(label) : undefined;
    const startSegment = /\(file ([0-9A-F]{24})\)/.exec(fields.get('START WAL LOCATION') ?? '')?.[1];
    if (!file || !label || !tarball || !startSegment) continue;
    tarballs.delete(label);
    const startedAt = historyTime(fields.get('START TIME')) ?? tarball.modifiedAt;
    baseBackups.push({
      label,
      startSegment,
      historyFile: file,
      timeline: Number(fields.get('START TIMELINE') ?? parseSegment(startSegment)?.timeline ?? 1),
      startedAt,
      finishedAt: historyTime(fields.get('STOP TIME')) ?? tarball.modifiedAt,
      sizeBytes: tarball.sizeBytes,
    });
  }
  // A tarball without a history file is a backup still running (or one that
  // failed after writing it): pending, like a directory without a tarball.
  for (const [label, { modifiedAt }] of tarballs) pending.push({ label, modifiedAt });
  baseBackups.sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime());
  return { segments, baseBackups, pendingBaseDirs: pending, partialFiles, archiveBytes };
}

/** The archived segments from `base` on, while they are contiguous; `missing` names the first absent one after them. */
export function contiguousRun(inv: PitrInventory, base: PitrBaseBackup): { run: PitrSegment[]; missing: string | null } {
  const start = parseSegment(base.startSegment);
  if (!start) return { run: [], missing: base.startSegment };
  const byOrdinal = new Map(inv.segments.filter((s) => s.timeline === start.timeline).map((s) => [s.ordinal, s]));
  const newest = Math.max(start.ordinal, ...byOrdinal.keys());
  const run: PitrSegment[] = [];
  for (let ordinal = start.ordinal; ordinal <= newest; ordinal++) {
    const segment = byOrdinal.get(ordinal);
    if (!segment) return { run, missing: segmentName(start.timeline, ordinal) };
    run.push(segment);
  }
  return { run, missing: null };
}

export interface PitrRange { from: Date; to: Date }

/**
 * The time ranges a recovery can reach: from each base backup's finish to the
 * newest segment of the contiguous run after it, merged. A gap in the archive
 * splits the window; `to` is when the last segment was archived, an upper
 * bound of the last transaction it holds.
 */
export function recoverableRanges(inv: PitrInventory): PitrRange[] {
  const ranges: PitrRange[] = [];
  for (const base of inv.baseBackups) {
    const { run } = contiguousRun(inv, base);
    if (!run.length) continue;
    const to = run.at(-1)!.archivedAt;
    if (to.getTime() <= base.finishedAt.getTime()) continue;
    const last = ranges.at(-1);
    if (last && base.finishedAt.getTime() <= last.to.getTime()) last.to = new Date(Math.max(last.to.getTime(), to.getTime()));
    else ranges.push({ from: base.finishedAt, to });
  }
  return ranges;
}

export interface PitrRecoveryPlan {
  base: PitrBaseBackup;
  /** Segments the replay reads (checked with `gzip -t` first). */
  segments: PitrSegment[];
  /** "latest": the segment the replay must end in. */
  newestOrdinal: number;
}

const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');

/** Pick the base backup and the segments for a recovery to `target` (null: the end of the archive), or refuse. */
export function planRecovery(inv: PitrInventory, target: Date | null): PitrRecoveryPlan | { refusal: string } {
  const usable = inv.baseBackups.filter((b) => contiguousRun(inv, b).run.length > 0);
  if (!usable.length) {
    return { refusal: inv.baseBackups.length ? 'The archive no longer holds the WAL any base backup starts from.' : 'No base backup has finished yet; the first one is taken when point-in-time recovery is enabled.' };
  }
  const candidates = target ? usable.filter((b) => b.finishedAt.getTime() < target.getTime()) : usable;
  const base = candidates.at(-1);
  if (!base) return { refusal: `No base backup finished before ${iso(target!)}; the earliest recoverable point is ${iso(usable[0]!.finishedAt)}.` };
  const { run, missing } = contiguousRun(inv, base);
  const until = run.at(-1)!.archivedAt;
  if (!target) {
    if (missing) {
      return { refusal: `Segment ${missing} is missing from the archive; a recovery to the latest point would stop before it without an error. Recover to a time before ${iso(until)}, or take a new base backup.` };
    }
    return { base, segments: run, newestOrdinal: run.at(-1)!.ordinal };
  }
  if (target.getTime() > until.getTime()) {
    return {
      refusal: missing
        ? `Segment ${missing} is missing from the archive; the latest point it can recover to is about ${iso(until)}.`
        : `Nothing after ${iso(target)} has been archived yet (the newest segment was archived at ${iso(until)}). Recover to the latest archived point, or try again in a minute.`,
    };
  }
  // Replay reads up to the first segment archived after the target (it holds
  // the target) and, when no transaction follows the target in it, one or two
  // more. A damaged segment beyond those still makes PostgreSQL refuse.
  const end = run.findIndex((s) => s.archivedAt.getTime() >= target.getTime());
  return { base, segments: run.slice(0, end === -1 ? run.length : end + 3), newestOrdinal: run.at(-1)!.ordinal };
}

/** What a recovery's PostgreSQL log says: where replay ended and why it stopped. */
export function readRecoveryLog(lines: string[]): {
  redoDoneAt: string | null;
  stoppedAt: string | null;
  fatal: 'target-not-reached' | 'before-consistent' | 'other' | null;
} {
  let redoDoneAt: string | null = null;
  let stoppedAt: string | null = null;
  let fatal: 'target-not-reached' | 'before-consistent' | 'other' | null = null;
  for (const line of lines) {
    const redo = /redo done at ([0-9A-F]+\/[0-9A-F]+)/i.exec(line);
    if (redo) redoDoneAt = redo[1]!;
    const stop = /recovery stopping (?:before|after) (?:commit|abort) of transaction \d+, time (.+?)\s*$/.exec(line);
    if (stop) stoppedAt = stop[1]!;
    if (/FATAL:\s+recovery ended before configured recovery target was reached/.test(line)) fatal = 'target-not-reached';
    else if (/FATAL:\s+requested recovery stop point is before consistent recovery point/.test(line)) fatal = 'before-consistent';
    // The panel's own readiness probes log "the database system is starting up".
    else if (/FATAL:/.test(line) && !/database system is/.test(line) && fatal === null) fatal = 'other';
  }
  return { redoDoneAt, stoppedAt, fatal };
}

// ── archive access ────────────────────────────────────────────────────────

function pgImage(d: Database): string {
  return ENGINES.postgres!.image(d.version ?? undefined);
}

function archiveVolumeOf(d: Database): string {
  if (!d.volumeName) throw new Error('database has no volume name');
  return pitrArchiveVolume(d.volumeName);
}

const ARCHIVE_LISTING = [
  `cd ${PITR_ARCHIVE_MOUNT} 2>/dev/null || exit 0`,
  // One stat for every file: thousands of segments, one process.
  'set -- wal/*; [ -e "$1" ] && stat -c "W %n %s %Y" "$@"',
  'for d in base/*/; do [ -d "$d" ] || continue; if [ -f "$d"base.tar.gz ]; then stat -c "B %n %s %Y" "$d"base.tar.gz; else stat -c "D %n %s %Y" "$d"; fi; done',
  'for f in wal/*.backup.gz; do [ -e "$f" ] || continue; echo "H $f"; gzip -dc "$f" 2>/dev/null | sed "s/^/| /"; done',
  'exit 0',
].join('\n');

/**
 * Run `script` (sh) as the image's postgres user with the archive mounted:
 * in the running database container when there is one, otherwise in a
 * one-off networkless container of the database's image.
 */
async function inArchive(d: Database, script: string, opts: { write?: boolean; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<string> {
  const options = { timeoutMs: opts.timeoutMs ?? 120_000, maxOutputBytes: opts.maxOutputBytes ?? 16 * 1024 * 1024 };
  if (d.containerName && (await containerRunning(d.containerName))) {
    return capture('docker', ['exec', '-u', 'postgres', d.containerName, 'sh', '-c', script], options);
  }
  const mount = `${archiveVolumeOf(d)}:${PITR_ARCHIVE_MOUNT}${opts.write ? '' : ':ro'}`;
  return capture('docker', ['run', '--rm', ...PITR_HELPER_FLAGS, '--user', 'postgres', '-v', mount, '--entrypoint', 'sh', pgImage(d), '-c', script], options);
}

/** The archive's segments and base backups. */
export async function readPitrInventory(d: Database): Promise<PitrInventory> {
  if (!(await volumeExists(archiveVolumeOf(d)))) return parseArchiveListing('');
  return parseArchiveListing(await inArchive(d, ARCHIVE_LISTING));
}

/** Segments of `names` whose gzip stream is damaged or truncated (in archive order). */
export async function damagedSegments(d: Database, names: string[], log: (line: string) => void): Promise<string[]> {
  if (!names.length) return [];
  for (const name of names) if (!SEGMENT.test(name)) throw new Error(`not a segment name: ${name}`);
  log(`Checking ${names.length} archived WAL segment(s) …`);
  // Names travel as positional arguments, never inside the script.
  const script = `cd ${PITR_WAL_DIR} || exit 3\nfor s in "$@"; do gzip -t "$s.gz" 2>/dev/null || echo "$s"; done\nexit 0`;
  const args = ['sh', '-c', script, 'check', ...names];
  const options = { timeoutMs: 30 * 60_000, heartbeatMs: 60_000, heartbeatLabel: 'Checking archived WAL', onProgress: log };
  const out = d.containerName && (await containerRunning(d.containerName))
    ? await capture('docker', ['exec', '-u', 'postgres', d.containerName, ...args], options)
    : await capture('docker', ['run', '--rm', ...PITR_HELPER_FLAGS, '--user', 'postgres', '-v', `${archiveVolumeOf(d)}:${PITR_ARCHIVE_MOUNT}:ro`, '--entrypoint', args[0]!, pgImage(d), ...args.slice(1)], options);
  return out.split('\n').map((l) => l.trim()).filter((l) => SEGMENT.test(l));
}

function psqlArgs(d: Database, container: string, sql: string): string[] {
  return ['exec', '-u', 'postgres', container, 'psql', '-h', '/var/run/postgresql', '-U', d.username ?? 'nine', '-d', 'postgres', '-X', '-Atqc', sql];
}

/** Why `d` cannot archive, or null. Checked when PITR is enabled, against the running server. */
export async function pitrPreflight(d: Database): Promise<string | null> {
  if (!d.containerName || !(await containerRunning(d.containerName))) return 'The database must be running to enable point-in-time recovery.';
  const out = await capture('docker', psqlArgs(d, d.containerName, "SELECT current_setting('wal_segment_size') || '|' || current_setting('wal_level')"), { timeoutMs: 30_000 });
  const [segmentSize, walLevel] = out.trim().split('|');
  if (segmentSize !== '16MB') return `This cluster uses ${segmentSize ?? 'an unknown'} WAL segments; point-in-time recovery supports the default 16MB.`;
  if (walLevel === 'minimal') return 'wal_level is minimal (set with ALTER SYSTEM); archiving needs replica or logical.';
  return null;
}

export interface PitrArchiverStats {
  archivedCount: number;
  lastArchivedAt: Date | null;
  failedCount: number;
  lastFailedAt: Date | null;
}

/** pg_stat_archiver of the running database, or null when it is not running. */
export async function pitrArchiverStats(d: Database): Promise<PitrArchiverStats | null> {
  if (!d.containerName || !(await containerRunning(d.containerName))) return null;
  const sql = "SELECT archived_count || '|' || coalesce(extract(epoch FROM last_archived_time)::bigint::text, '') || '|' || failed_count || '|' || coalesce(extract(epoch FROM last_failed_time)::bigint::text, '') FROM pg_stat_archiver";
  const [archived, lastArchived, failed, lastFailed] = (await capture('docker', psqlArgs(d, d.containerName, sql), { timeoutMs: 30_000 })).trim().split('|');
  const at = (v: string | undefined) => (v ? new Date(Number(v) * 1000) : null);
  return { archivedCount: Number(archived) || 0, lastArchivedAt: at(lastArchived), failedCount: Number(failed) || 0, lastFailedAt: at(lastFailed) };
}

/** True when archiving is failing now: the last failure is newer than the last success. */
export function archivingFailing(stats: PitrArchiverStats | null): boolean {
  return !!stats?.lastFailedAt && (!stats.lastArchivedAt || stats.lastFailedAt.getTime() > stats.lastArchivedAt.getTime());
}

// ── base backups and retention ────────────────────────────────────────────

/** A sortable, unique base backup label: `nd-20261105T093130123Z`. */
export function baseBackupLabel(now = new Date()): string {
  return `nd-${now.toISOString().replace(/[-:.]/g, '')}`;
}

/** Base backups longer than this are stopped (the server waits for its last segment to be archived). */
export const PITR_BASE_BACKUP_TIMEOUT_MS = 6 * 60 * 60_000;

/**
 * Wait until the server in `cn` accepts connections on its socket. Enabling
 * PITR restarts the database and takes the first base backup right away;
 * `docker run -d` returns before PostgreSQL is up (or done with crash recovery).
 */
async function waitForPostgres(cn: string, attempts: number, pollMs: number): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await capture('docker', ['exec', '-u', 'postgres', cn, 'pg_isready', '-q', '-h', '/var/run/postgresql'], { timeoutMs: 10_000 });
      return;
    } catch { /* still starting */ }
    await sleep(pollMs);
  }
  throw new Error('PostgreSQL did not accept connections for the base backup');
}

/**
 * Take a base backup into the archive. It runs inside the database container
 * over the local socket, under the database's operation lock (a dump or a
 * restore of the same database waits, or gets 409). `-X none`: the WAL it
 * needs is archived anyway, and pg_basebackup waits until it is.
 */
export async function takePitrBaseBackup(
  d: Database,
  log: (line: string) => void,
  now = new Date(),
  ready: { attempts?: number; pollMs?: number } = {},
): Promise<string> {
  const cn = d.containerName;
  if (!cn) throw new Error('database has no container name');
  return withDatabaseOperationLock(d.id, log, async () => {
    if (!(await containerRunning(cn))) throw new Error('The database is not running');
    await waitForPostgres(cn, ready.attempts ?? 90, ready.pollMs ?? 2_000);
    const label = baseBackupLabel(now);
    const dir = `${PITR_BASE_DIR}/${label}`;
    log(`Taking base backup ${label} …`);
    try {
      await run(
        'docker',
        ['exec', '-u', 'postgres', cn, 'pg_basebackup', '-h', '/var/run/postgresql', '-U', d.username ?? 'nine', '-D', dir, '-Ft', '-z', '-X', 'none', '-c', 'fast', '-l', label],
        { timeoutMs: PITR_BASE_BACKUP_TIMEOUT_MS, heartbeatMs: 60_000, heartbeatLabel: `Base backup ${label}` },
        log,
      );
    } catch (err) {
      await run('docker', ['exec', '-u', 'postgres', cn, 'rm', '-rf', dir], {}, swallow).catch(() => undefined);
      throw err;
    }
    log(`Base backup ${label} finished`);
    return label;
  });
}

/** Leftovers older than this are removed by the retention sweep. */
const STALE_LEFTOVER_MS = 24 * 60 * 60_000;
/** An interrupted `archive_command` upload: a segment, a backup history or a timeline history file. */
const PARTIAL_UPLOAD = /^(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)\.gz\.part$/;

/** What a retention pass removes: base backups past the retention (the newest stays), with the WAL only they need. */
export function retentionPlan(inv: PitrInventory, retentionDays: number, now: Date): { removeBases: PitrBaseBackup[]; keepFrom: PitrBaseBackup | null } {
  const bases = inv.baseBackups;
  if (!bases.length) return { removeBases: [], keepFrom: null };
  const horizon = now.getTime() - retentionDays * 24 * 60 * 60_000;
  let firstKept = bases.findIndex((b) => b.finishedAt.getTime() >= horizon);
  // Every base backup is past the retention: the newest one stays.
  if (firstKept === -1) firstKept = bases.length - 1;
  return { removeBases: bases.slice(0, firstKept), keepFrom: bases[firstKept]! };
}

/**
 * Apply the retention: remove old base backups and their history files, the
 * WAL before the oldest kept base backup (`pg_archivecleanup`), and stale
 * leftovers (a base backup directory that never finished, an interrupted
 * upload). Never runs while `busy` (a recovery reading this archive, or a
 * base backup writing it).
 */
export async function prunePitrArchive(d: Database, retentionDays: number, log: (line: string) => void, now = new Date()): Promise<{ removedBases: string[] }> {
  const inv = await readPitrInventory(d);
  const { removeBases, keepFrom } = retentionPlan(inv, retentionDays, now);
  const stale = now.getTime() - STALE_LEFTOVER_MS;
  const staleDirs = inv.pendingBaseDirs.filter((p) => p.modifiedAt.getTime() < stale).map((p) => p.label);
  const staleParts = inv.partialFiles.filter((p) => p.modifiedAt.getTime() < stale).map((p) => p.name);
  if (!removeBases.length && !staleDirs.length && !staleParts.length && !keepFrom) return { removedBases: [] };
  const lines = [`cd ${PITR_ARCHIVE_MOUNT} || exit 3`];
  // Labels and file names come from the listing, validated by the parser's patterns.
  for (const b of removeBases) lines.push(`rm -rf "base/${b.label}" "wal/${b.historyFile}.gz"`);
  for (const label of staleDirs) lines.push(`rm -rf "base/${label}"`);
  for (const name of staleParts) if (PARTIAL_UPLOAD.test(name)) lines.push(`rm -f "wal/${name}"`);
  if (keepFrom) lines.push(`pg_archivecleanup -x .gz ${PITR_WAL_DIR} ${keepFrom.startSegment}`);
  lines.push('exit 0');
  await inArchive(d, lines.join('\n'), { write: true, timeoutMs: 10 * 60_000 });
  if (removeBases.length) log(`WAL archive retention: removed ${removeBases.length} base backup(s) older than ${retentionDays} day(s)`);
  return { removedBases: removeBases.map((b) => b.label) };
}

/** Delete the archive volume (PITR switched off). The database container must already run without it. */
export async function removePitrArchive(d: Database, log: (line: string) => void): Promise<void> {
  const volume = archiveVolumeOf(d);
  if (!(await volumeExists(volume))) return;
  log(`Deleting WAL archive volume ${volume} …`);
  await run('docker', ['volume', 'rm', volume], {}, log);
}

// ── recovery ──────────────────────────────────────────────────────────────

/** A replay longer than this is stopped. */
export const PITR_RECOVERY_TIMEOUT_MS = 6 * 60 * 60_000;
const POLL_MS = 2_000;

export interface PitrRecoveryOutcome {
  baseBackup: string;
  /** PostgreSQL's own words for where replay stopped: a transaction time, or the end of the archive. */
  recoveredTo: string;
  restoreMs: number;
}

/**
 * `recovery_target_time` takes a numeric UTC offset: PostgreSQL refuses time
 * zone abbreviations there, and `Z` is one ("2026-11-05 09:31:34.423+00").
 */
export function recoveryTargetTime(at: Date): string {
  return at.toISOString().replace('T', ' ').replace('Z', '+00');
}

async function containerLog(name: string): Promise<string[]> {
  const lines: string[] = [];
  await run('docker', ['logs', '--tail', '400', name], { timeoutMs: 30_000 }, (line) => lines.push(line)).catch(() => undefined);
  return lines;
}

/**
 * Recover `source`'s archive into `target`'s (new, absent) volume: up to
 * `targetTime`, or to the end of the archive when it is null. On success the
 * volume holds a promoted cluster whose role password is `target`'s, ready
 * for `startDatabase(target)`. Throws {@link PitrRefusal} when the archive
 * cannot deliver what was asked; the caller removes the volume on any error.
 */
export async function recoverPostgresToPoint(
  source: Database,
  target: Database,
  targetTime: Date | null,
  log: (line: string) => void,
  deps: { now?: () => number; pollMs?: number; timeoutMs?: number } = {},
): Promise<PitrRecoveryOutcome> {
  const now = deps.now ?? Date.now;
  const cfg = ENGINES.postgres!;
  if (!target.volumeName) throw new Error('the new database has no volume name');
  const image = pgImage(source);
  await ensureDockerImage(image, log);

  const inv = await readPitrInventory(source);
  const plan = planRecovery(inv, targetTime);
  if ('refusal' in plan) throw new PitrRefusal(plan.refusal);
  const damaged = await damagedSegments(source, plan.segments.map((s) => s.name), log);
  if (damaged.length) {
    throw new PitrRefusal(`Segment ${damaged[0]} in the archive is damaged; replay cannot pass it. Pick an earlier time, or take a new base backup after it.`);
  }

  if (await volumeExists(target.volumeName)) throw new PitrRefusal(`A volume named ${target.volumeName} already exists; pick another name.`);
  await createDockerVolume(target.volumeName, log, databaseVolumeLabels(target, { 'ninedeploy.database.recovered-from': source.slug }));

  const mount = resolveVolumePath(cfg, source.version);
  const dataDir = resolveDataDir(cfg, source.version);
  const archive = `${archiveVolumeOf(source)}:${PITR_ARCHIVE_MOUNT}:ro`;
  const settings = [
    `restore_command = '${PITR_RESTORE_COMMAND}'`,
    "recovery_target_timeline = 'current'",
    "recovery_target_action = 'promote'",
    ...(targetTime ? [`recovery_target_time = '${recoveryTargetTime(targetTime)}'`] : []),
    '',
  ].join('\n');
  log(`Restoring base backup ${plan.base.label} …`);
  await capture(
    'docker',
    [
      // Root only for ownership: a crafted base backup lands in the new volume of its own database.
      'run', '--rm', '-i', ...PITR_HELPER_FLAGS, ...PITR_OWNERSHIP_CAPS, '--user', '0', '-v', `${target.volumeName}:${mount}`, '-v', archive, '--entrypoint', 'sh', image,
      '-c', 'set -eu; mkdir -p "$1"; tar -xzf "$2" -C "$1"; touch "$1/recovery.signal"; cat >> "$1/postgresql.auto.conf"; chown -R postgres:postgres "$3"; chmod 700 "$1"',
      'prepare', dataDir, `${PITR_BASE_DIR}/${plan.base.label}/base.tar.gz`, mount,
    ],
    { timeoutMs: PITR_RECOVERY_TIMEOUT_MS, heartbeatMs: 60_000, heartbeatLabel: `Restoring base backup ${plan.base.label}`, onProgress: log },
    Buffer.from(settings),
  );

  const helper = `nd-pitr-${randomUUID()}`;
  const started = now();
  try {
    // PostgreSQL itself, as `postgres` from the start (the data directory is its own): no capabilities at all.
    const args = ['run', '-d', '--name', helper, ...PITR_HELPER_FLAGS, '--user', 'postgres', '--label', 'ninedeploy.role=pitr-recovery', '--label', `ninedeploy.pitr.source=${source.slug}`];
    if (source.memLimitMb > 0) args.push('--memory', `${source.memLimitMb}m`, '--memory-swap', `${source.memLimitMb}m`);
    if (source.cpuLimitMilli > 0) args.push('--cpus', String(source.cpuLimitMilli / 1000));
    args.push('-v', `${target.volumeName}:${mount}`, '-v', archive, image, '-c', 'listen_addresses=', '-c', 'archive_mode=off');
    log(targetTime ? `Replaying the archived WAL up to ${targetTime.toISOString()} …` : 'Replaying the archived WAL to its end …');
    await run('docker', args, {}, log);

    let promoted = false;
    let lastHeartbeat = started;
    while (now() - started < (deps.timeoutMs ?? PITR_RECOVERY_TIMEOUT_MS)) {
      if (!(await containerRunning(helper))) break;
      try {
        if ((await capture('docker', psqlArgs(source, helper, 'SELECT pg_is_in_recovery()'), { timeoutMs: 15_000 })).trim() === 'f') { promoted = true; break; }
      } catch { /* still starting or replaying */ }
      if (now() - lastHeartbeat >= 60_000) { log('Still replaying …'); lastHeartbeat = now(); }
      await sleep(deps.pollMs ?? POLL_MS);
    }
    const restoreMs = now() - started;
    const helperLog = await containerLog(helper);
    const recovery = readRecoveryLog(helperLog);
    if (!promoted) {
      // The operation log (not the API answer) keeps PostgreSQL's own words.
      for (const line of helperLog.filter((l) => /LOG:|FATAL:|ERROR:|PANIC:/.test(l)).slice(-12)) log(`postgres: ${line}`);
      if (recovery.fatal === 'target-not-reached') {
        throw new PitrRefusal(targetTime
          ? `The archive does not reach ${iso(targetTime)}: no transaction after it has been archived yet. Recover to the latest archived point, or try again in a minute.`
          : 'The archive ended before a consistent point was reached.');
      }
      if (recovery.fatal === 'before-consistent') throw new PitrRefusal(`${targetTime ? iso(targetTime) : 'The target'} is before the base backup ${plan.base.label} became consistent; pick a later time.`);
      throw new Error(now() - started >= (deps.timeoutMs ?? PITR_RECOVERY_TIMEOUT_MS) ? 'The WAL replay did not finish in time' : 'PostgreSQL stopped during the WAL replay');
    }
    let recoveredTo: string;
    if (targetTime) {
      if (!recovery.stoppedAt) throw new Error('PostgreSQL promoted without reporting where replay stopped');
      recoveredTo = recovery.stoppedAt;
    } else {
      const ended = recovery.redoDoneAt ? lsnOrdinal(recovery.redoDoneAt) : null;
      if (ended !== plan.newestOrdinal) {
        throw new PitrRefusal(`The replay stopped${ended === null ? '' : ` in segment ${segmentName(plan.base.timeline, ended)}`}, before the newest archived segment ${segmentName(plan.base.timeline, plan.newestOrdinal)}: the archive is damaged there. Recover to an earlier time.`);
      }
      recoveredTo = `the end of the archive (${recovery.redoDoneAt})`;
    }

    // The new database's own credentials; recovery settings out of the cluster.
    const role = (target.username ?? cfg.username() ?? 'nine').replace(/"/g, '""');
    const password = decrypt(target.passwordEncrypted).replace(/'/g, "''");
    const sql = [
      `ALTER ROLE "${role}" WITH PASSWORD '${password}' VALID UNTIL 'infinity';`,
      'ALTER SYSTEM RESET restore_command;',
      'ALTER SYSTEM RESET recovery_target_time;',
      'ALTER SYSTEM RESET recovery_target_action;',
      'ALTER SYSTEM RESET recovery_target_timeline;',
      'CHECKPOINT;',
      '',
    ].join('\n');
    await capture('docker', ['exec', '-i', '-u', 'postgres', helper, 'psql', '-h', '/var/run/postgresql', '-U', source.username ?? 'nine', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { timeoutMs: 120_000 }, Buffer.from(sql));
    await run('docker', ['stop', '-t', '120', helper], { timeoutMs: 180_000 }, log);
    log(`Recovered to ${recoveredTo} in ${Math.round(restoreMs / 1000)} s`);
    return { baseBackup: plan.base.label, recoveredTo, restoreMs };
  } finally {
    await run('docker', ['rm', '-f', helper], {}, swallow).catch(() => undefined);
  }
}

// The housekeeping sweep of leftover recovery helpers lives in a light module.
export { prunePitrRecoveryHelpers } from '../lib/pitrHousekeeping.js';
