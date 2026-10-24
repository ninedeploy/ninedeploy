import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { errorRatePercent, type CanaryReleaseStats } from '@ninedeploy/schemas';

export interface CanaryTrafficSnapshot {
  canary: CanaryReleaseStats;
  stable: CanaryReleaseStats;
  complete: boolean;
}

export interface CanaryTrafficObservation {
  sample(): Promise<CanaryTrafficSnapshot>;
  finish(): Promise<CanaryTrafficSnapshot>;
  close(): Promise<void>;
}

export interface FileCanaryTrafficSnapshot extends CanaryTrafficSnapshot {
  receipt: { windowId: string; sourceId: string; fromOffset: number; toOffset: number; bytes: number; records: number };
}

export interface FileCanaryTrafficObservation extends CanaryTrafficObservation {
  sample(): Promise<FileCanaryTrafficSnapshot>;
  finish(): Promise<FileCanaryTrafficSnapshot>;
}

export const CANARY_TRAFFIC_MAX_BYTES = 32 * 1024 * 1024;
export const CANARY_TRAFFIC_MAX_RECORDS = 100_000;
export const CANARY_TRAFFIC_MAX_LINE = 16 * 1024;
export const CANARY_TRAFFIC_MAX_WINDOWS = 16;
const slots = new Set<string>();
const sources = new Map<string, { file: string; invalidate: () => void }>();
/** The owner tailer defers ordinary rotation while a bounded window reads. */
export function hasCanaryTrafficWindow(file: string): boolean {
  return [...sources.values()].some(source => source.file === path.resolve(file));
}
/** Called before the owner's forced rotation/truncation/purge, including regrowth. */
export function invalidateCanaryTrafficWindows(file: string): void {
  for (const source of sources.values()) if (source.file === path.resolve(file)) source.invalidate();
}
const unavailable = (reason: string) => new Error(`Canary traffic observation unavailable: ${reason}`);

interface Sample { requests: number; errors: number; durations: number[] }
const empty = (): Sample => ({ requests: 0, errors: 0, durations: [] });
const view = (sample: Sample): CanaryReleaseStats => {
  const sorted = [...sample.durations].sort((a, b) => a - b);
  return { requests: sample.requests, errors: sample.errors,
    errorRate: errorRatePercent(sample.errors, sample.requests),
    p95Ms: sorted.length ? Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]!) : null };
};

/**
 * Read the access log independently of the analytics tailer's polling/cursor.
 * Windows count completed JSON records by byte position, not host wall clocks.
 * Rotation, source replacement and incomplete data refuse a verdict. No raw
 * access events or paths leave this reader.
 */
export async function openFileCanaryTraffic(opts: {
  file: string;
  slug: string;
  /** Attest the running proxy, its restart identity, log config and mount. */
  identity: () => Promise<string>;
  maxAgeMs?: number;
  now?: () => number;
}): Promise<FileCanaryTrafficObservation> {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(opts.slug)) throw unavailable('invalid service identity');
  const maxAge = opts.maxAgeMs ?? 3_660_000;
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 3_660_000) throw unavailable('invalid window lifetime');
  if (slots.size >= CANARY_TRAFFIC_MAX_WINDOWS) throw unavailable('too many open windows');
  const windowId = randomUUID();
  slots.add(windowId);
  let handle: FileHandle | undefined;
  try {
    const identity = await opts.identity();
    if (!identity) throw unavailable('proxy identity was not confirmed');
    handle = await open(opts.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    const named = await lstat(opts.file, { bigint: true });
    if (!stat.isFile() || !named.isFile() || named.dev !== stat.dev || named.ino !== stat.ino || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw unavailable('log identity was not confirmed');
    }
    const fromOffset = Number(stat.size);
    const now = opts.now ?? (() => performance.now());
    const openedAt = now();
    const sourceId = createHash('sha256').update(`${identity}\0${stat.dev}\0${stat.ino}`).digest('hex');
    let cursor = fromOffset, bytes = 0, records = 0;
    let pending: Buffer = Buffer.alloc(0), anchor: Buffer = Buffer.alloc(0);
    let closed = false, finished = false, poisoned = false, reading = false;
    const samples = { canary: empty(), stable: empty() };
    const prefix = `svc_${opts.slug}_`;
    const file = handle;

    const readExact = async (position: number, length: number): Promise<Buffer> => {
      const buf = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) {
        const part = await file.read(buf, got, length - got, position + got);
        if (part.bytesRead === 0) throw unavailable('log was truncated');
        got += part.bytesRead;
      }
      return buf;
    };
    // Retain an unfinished prefix already being written when the window opens;
    // count it only if its terminating newline arrives within this window.
    const initialTail = await readExact(Math.max(0, cursor - CANARY_TRAFFIC_MAX_LINE), Math.min(cursor, CANARY_TRAFFIC_MAX_LINE));
    const boundary = initialTail.lastIndexOf(10);
    pending = initialTail.subarray(boundary + 1);
    if (pending.length >= CANARY_TRAFFIC_MAX_LINE) throw unavailable('oversized log record');
    anchor = initialTail.subarray(Math.max(0, initialTail.length - 128));

    const verify = async () => {
      if (closed || finished || poisoned) throw unavailable('window is closed');
      const age = now() - openedAt;
      if (!Number.isFinite(age) || age < 0 || age > maxAge) throw unavailable('window expired');
      if (await opts.identity() !== identity) throw unavailable('proxy was replaced or restarted');
      const current = await file.stat({ bigint: true });
      const pathStat = await lstat(opts.file, { bigint: true });
      if (!current.isFile() || !pathStat.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
        throw unavailable('log was replaced or rotated');
      }
      if (current.size < BigInt(cursor) || current.size > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable('log was truncated');
      if (anchor.length && !(await readExact(cursor - anchor.length, anchor.length)).equals(anchor)) throw unavailable('log was rewritten');
      if (closed || finished || poisoned) throw unavailable('window is closed');
      return Number(current.size);
    };

    const ingest = (raw: Buffer) => {
      if (raw.length === 0) return;
      if (raw.length > CANARY_TRAFFIC_MAX_LINE) throw unavailable('oversized log record');
      if (++records > CANARY_TRAFFIC_MAX_RECORDS) throw unavailable('record limit exceeded');
      let row: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        row = parsed as Record<string, unknown>;
      } catch { throw unavailable('malformed log record'); }
      if (typeof row.StartUTC !== 'string' || !Number.isFinite(Date.parse(row.StartUTC)) ||
        !Number.isSafeInteger(row.DownstreamStatus) || Number(row.DownstreamStatus) < 0 || Number(row.DownstreamStatus) > 599 ||
        !Number.isSafeInteger(row.Duration) || Number(row.Duration) < 0) throw unavailable('incomplete log record');
      if (typeof row.ServiceName !== 'string' || row.ServiceName.length === 0) {
        // An unmatched HTTP request has no service leaf; a missing service on
        // a successful/server-error response cannot establish attribution.
        if (Number(row.DownstreamStatus) < 400 || Number(row.DownstreamStatus) >= 500) throw unavailable('missing response attribution');
        return;
      }
      if (!row.ServiceName.startsWith(prefix)) return;
      const match = /^\d+_(canary|stable)@file$/.exec(row.ServiceName.slice(prefix.length));
      if (!match) return;
      if (Number(row.DownstreamStatus) < 100) throw unavailable('missing HTTP response status');
      const sample = samples[match[1] as 'canary' | 'stable'];
      sample.requests++;
      if (Number(row.DownstreamStatus) >= 500) sample.errors++;
      sample.durations.push(Number(row.Duration) / 1e6);
    };

    const read = async (complete: boolean): Promise<FileCanaryTrafficSnapshot> => {
      if (reading) throw unavailable('concurrent window read');
      reading = true;
      try {
        const end = await verify();
        if (end - cursor + bytes > CANARY_TRAFFIC_MAX_BYTES) throw unavailable('byte limit exceeded');
        while (cursor < end) {
          const chunk = await readExact(cursor, Math.min(64 * 1024, end - cursor));
          cursor += chunk.length; bytes += chunk.length;
          const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          let start = 0, newline = data.indexOf(10);
          while (newline >= 0) {
            ingest(data.subarray(start, newline)); start = newline + 1;
            newline = data.indexOf(10, start);
          }
          pending = Buffer.from(data.subarray(start));
          if (pending.length > CANARY_TRAFFIC_MAX_LINE) throw unavailable('oversized log record');
        }
        anchor = await readExact(Math.max(0, cursor - 128), Math.min(cursor, 128));
        await verify();
        if (now() - openedAt > maxAge) throw unavailable('window expired');
        if (complete && pending.length) throw unavailable('final log record is incomplete');
        const result = { canary: view(samples.canary), stable: view(samples.stable), complete,
          receipt: { windowId, sourceId, fromOffset, toOffset: cursor, bytes, records } };
        if (complete) finished = true;
        return result;
      } catch (err) {
        poisoned = true;
        // Filesystem errors can contain a private host path.
        if (err instanceof Error && err.message.startsWith('Canary traffic observation unavailable:')) throw err;
        throw unavailable('source could not be read');
      } finally { reading = false; }
    };
    await verify();
    sources.set(windowId, { file: path.resolve(opts.file), invalidate: () => { poisoned = true; } });
    return {
      sample: () => read(false), finish: () => read(true),
      close: async () => {
        if (closed) return;
        closed = true;
        try { await file.close(); } finally { slots.delete(windowId); sources.delete(windowId); }
      },
    };
  } catch (err) {
    await handle?.close().catch(() => undefined);
    slots.delete(windowId);
    sources.delete(windowId);
    if (err instanceof Error && err.message.startsWith('Canary traffic observation unavailable:')) throw err;
    throw unavailable('source could not be opened');
  }
}
