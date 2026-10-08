import { closeSync, existsSync, openSync, readSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { domains, services, settings, trafficRollups, type DB } from '@ninedeploy/db';
import {
  TRAFFIC_LATENCY_BUCKETS,
  TRAFFIC_LATENCY_EDGES_MS,
  TRAFFIC_RETENTION_DAYS_DEFAULT,
  TRAFFIC_RETENTION_DAYS_MAX,
  TRAFFIC_RETENTION_DAYS_MIN,
  trafficRangeGranularity,
  type TrafficCounters,
  type TrafficGranularity,
  type TrafficPercentiles,
  type TrafficRange,
  type TrafficScopeTotal,
  type TrafficStatus,
} from '@ninedeploy/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { TRAEFIK_CONTAINER } from '../engine/dockerNames.js';
import { audit } from './audit.js';
import { run } from './exec.js';
import { getSetting, getSettingJson, setSetting, setSettingJson } from './settings.js';

/**
 * Traffic analytics (0.15, opt-in everywhere — owner decision O3): the
 * access-log parser, the minute/hour aggregator, the rollup writer, the file
 * tailer with its rotation, the retention sweep and the summary queries.
 * Design: DESIGN.md §2.2–§2.4. Owner: task T3.
 *
 * Privacy: Traefik writes only the fields listed in `engine/proxy.ts`
 * (`TRAFFIC_ACCESS_LOG_BLOCK`); this module reads router, host, status, size,
 * duration and start time, and keeps aggregate counters only. No client
 * address, path, query string or header is ever read or stored.
 *
 * Import direction: `engine/proxy.ts` imports this module (the constants and
 * the switch below), never the other way round (test/importCycles.test.ts).
 */

// ── constants and paths ────────────────────────────────────────────────────

/** The directory the analytics access log lives in, inside the Traefik container. */
export const TRAFFIC_LOG_CONTAINER_DIR = '/var/log/ninedeploy-traffic';
/** The analytics access log's file name (the same on the host side). */
export const TRAFFIC_LOG_FILE = 'access.log';
/** The rotated file the tailer drains, then deletes. */
export const TRAFFIC_ROTATED_FILE = `${TRAFFIC_LOG_FILE}.1`;
/** Settings key of the opt-in switch (absent = off). */
export const TRAFFIC_ANALYTICS_ENABLED_KEY = 'traffic_analytics_enabled';
/** Settings key of the hour-row retention in days (absent = 30). */
export const TRAFFIC_RETENTION_DAYS_KEY = 'traffic_retention_days';
/** Settings key of the tailer cursor `{dev, ino, offset}`; written with the rows it covers. */
export const TRAFFIC_LOG_CURSOR_KEY = 'traffic_log_cursor';

/**
 * Host-side directory of the analytics access log (`<data>/traffic-logs`).
 * Deliberately OUTSIDE `<data>/traefik`, which the system export archives
 * whole (lib/systemArchive.ts): request logs never ship in an export.
 */
export const trafficLogDir = () => path.join(config.paths.dataDir, 'traffic-logs');

/** Poll interval of the tailer. */
export const TRAFFIC_POLL_MS = 10_000;
/** At most this much log is read per tick, so a backlog never blocks the event loop. */
export const TRAFFIC_TICK_CAP_BYTES = 32 * 1024 * 1024;
/** The live log is rotated (rename + USR1) once it is read past this size. */
export const TRAFFIC_ROTATE_BYTES = 64 * 1024 * 1024;
/** At start, a log this large (Traefik kept writing while the panel was down) is skipped to its tail. */
export const TRAFFIC_HARD_CAP_BYTES = 1024 * 1024 * 1024;
/** Minute rows (granularity 60) are kept this long. */
export const TRAFFIC_MINUTE_RETENTION_MS = 48 * 60 * 60 * 1000;
/** Retention deletes run in batches of this many rows. */
export const TRAFFIC_PRUNE_BATCH = 5000;
/** The domain → service map used for attribution is reloaded this often. */
const ATTRIBUTION_TTL_MS = 60_000;

// ── settings ───────────────────────────────────────────────────────────────

/** Whether traffic analytics is enabled (a missing row is off). Throws on a database error. */
export async function trafficAnalyticsEnabled(db: DB): Promise<boolean> {
  return getSetting(db, TRAFFIC_ANALYTICS_ENABLED_KEY, false);
}

export async function setTrafficAnalyticsEnabled(db: DB, enabled: boolean): Promise<void> {
  await setSetting(db, TRAFFIC_ANALYTICS_ENABLED_KEY, enabled);
}

/** Hour-row retention in days: the stored value when it is a valid integer in range, else 30. */
export async function getTrafficRetentionDays(db: DB): Promise<number> {
  const raw = await getSettingJson<unknown>(db, TRAFFIC_RETENTION_DAYS_KEY, null);
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= TRAFFIC_RETENTION_DAYS_MIN && n <= TRAFFIC_RETENTION_DAYS_MAX
    ? n
    : TRAFFIC_RETENTION_DAYS_DEFAULT;
}

export async function setTrafficRetentionDays(db: DB, days: number): Promise<void> {
  await setSettingJson(db, TRAFFIC_RETENTION_DAYS_KEY, days);
}

// ── parsing and attribution ────────────────────────────────────────────────

/** What one access-log line contributes. */
export interface TrafficHit {
  /** Unix ms the request started (`StartUTC`, else the line's `time`, else now). */
  startMs: number;
  /** Router name with any `@provider` suffix stripped; null when no router matched. */
  router: string | null;
  host: string | null;
  status: number;
  bytesOut: number;
  durationMs: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Parse one Traefik v3 JSON access-log line. Returns null for a line that is
 * not a JSON object (counted as malformed by the caller). Missing fields
 * default to zero / null: a request is still a request. `Duration` is in
 * nanoseconds.
 */
export function parseAccessLogLine(line: string, nowMs: number = Date.now()): TrafficHit | null {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  const started = [d.StartUTC, d.time]
    .map((t) => (typeof t === 'string' ? Date.parse(t) : Number.NaN))
    .find((t) => Number.isFinite(t));
  const router = typeof d.RouterName === 'string' && d.RouterName ? d.RouterName.replace(/@[A-Za-z0-9_-]+$/, '') : null;
  const host = typeof d.RequestHost === 'string' && d.RequestHost ? d.RequestHost.slice(0, 253) : null;
  return {
    startMs: started ?? nowMs,
    router,
    host,
    status: Math.trunc(num(d.DownstreamStatus)),
    bytesOut: Math.trunc(num(d.DownstreamContentSize)),
    durationMs: num(d.Duration) / 1e6,
  };
}

/** Where a router's traffic is counted. */
export type RouterAttribution =
  | { kind: 'panel' }
  | { kind: 'custom' }
  | { kind: 'domain'; domainId: number; slug: string }
  | { kind: 'other' };

const DOMAIN_ROUTER = /^(.+)_(\d+)(?:_http)?$/;

/**
 * Classify a router name (suffix already stripped). Generated domain routers
 * are `<slug>_<domainId>[_http]`, the panel's `ninedeploy_panel[_http]`, and
 * the operator's custom ones `custom-*` / `custom_*` (0.14). A custom name can
 * also LOOK like a domain router (`custom-app_5`), so the caller confirms a
 * domain match against the database and falls back to {@link customOrOther}.
 */
export function attributeRouter(router: string | null): RouterAttribution {
  if (!router) return { kind: 'other' };
  if (router === 'ninedeploy_panel' || router === 'ninedeploy_panel_http') return { kind: 'panel' };
  const m = DOMAIN_ROUTER.exec(router);
  if (m) {
    const domainId = Number(m[2]);
    if (Number.isSafeInteger(domainId) && domainId > 0) return { kind: 'domain', domainId, slug: m[1]! };
  }
  return customOrOther(router);
}

/** The fallback classification for a name that is not a confirmed domain router. */
export function customOrOther(router: string): RouterAttribution {
  return /^custom[-_]/.test(router) ? { kind: 'custom' } : { kind: 'other' };
}

/** The rollup row a hit lands in. */
export interface TrafficScope {
  scopeKey: string;
  domainId: number | null;
  serviceId: number | null;
  host: string | null;
}

/** Domain id → its service id and that service's slug, as the router names were rendered. */
export type DomainIndex = Map<number, { serviceId: number; slug: string }>;

export async function loadDomainIndex(db: DB): Promise<DomainIndex> {
  const rows = await db
    .select({ id: domains.id, serviceId: domains.serviceId, slug: services.slug })
    .from(domains)
    .innerJoin(services, eq(domains.serviceId, services.id));
  return new Map(rows.map((r) => [r.id, { serviceId: r.serviceId, slug: r.slug }]));
}

/** Resolve a hit to its rollup scope. A domain router whose id/slug no longer match a row falls back. */
export function scopeFor(hit: TrafficHit, index: DomainIndex): TrafficScope {
  const a = attributeRouter(hit.router);
  if (a.kind === 'domain') {
    const known = index.get(a.domainId);
    if (known && known.slug === a.slug) {
      return { scopeKey: `d:${a.domainId}`, domainId: a.domainId, serviceId: known.serviceId, host: hit.host };
    }
    const fallback = customOrOther(hit.router!);
    return { scopeKey: fallback.kind, domainId: null, serviceId: null, host: null };
  }
  if (a.kind === 'panel') return { scopeKey: 'panel', domainId: null, serviceId: null, host: hit.host };
  return { scopeKey: a.kind, domainId: null, serviceId: null, host: null };
}

// ── histogram ──────────────────────────────────────────────────────────────

/** The latency bucket a duration falls in: the first edge it does not exceed, else the overflow. */
export function latencyBucket(ms: number): number {
  for (let i = 0; i < TRAFFIC_LATENCY_EDGES_MS.length; i++) if (ms <= TRAFFIC_LATENCY_EDGES_MS[i]!) return i;
  return TRAFFIC_LATENCY_EDGES_MS.length;
}

export function emptyHist(): number[] {
  return new Array<number>(TRAFFIC_LATENCY_BUCKETS).fill(0);
}

/** Element-wise sum; a stored histogram of the wrong shape counts as empty. */
export function mergeHist(into: number[], add: readonly unknown[] | null | undefined): number[] {
  if (!Array.isArray(add) || add.length !== TRAFFIC_LATENCY_BUCKETS) return into;
  for (let i = 0; i < TRAFFIC_LATENCY_BUCKETS; i++) into[i] = (into[i] ?? 0) + num(add[i]);
  return into;
}

/**
 * Estimate a percentile (0–1) from the histogram by linear interpolation
 * inside the bucket that holds the rank. The overflow bucket's upper bound is
 * the largest duration seen (at least the last edge). Null without requests.
 */
export function percentileFromHist(hist: readonly number[], p: number, maxMs = 0): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const rank = p * total;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i] ?? 0;
    if (n <= 0) continue;
    if (seen + n >= rank) {
      const lower = i === 0 ? 0 : TRAFFIC_LATENCY_EDGES_MS[i - 1]!;
      const lastEdge = TRAFFIC_LATENCY_EDGES_MS[TRAFFIC_LATENCY_EDGES_MS.length - 1]!;
      const upper = i < TRAFFIC_LATENCY_EDGES_MS.length ? TRAFFIC_LATENCY_EDGES_MS[i]! : Math.max(maxMs, lastEdge);
      const est = lower + ((rank - seen) / n) * (upper - lower);
      return Math.round(Math.min(est, maxMs > 0 ? Math.max(maxMs, lower) : est) * 100) / 100;
    }
    seen += n;
  }
  return null;
}

export function percentiles(hist: readonly number[], maxMs: number): TrafficPercentiles {
  return {
    p50Ms: percentileFromHist(hist, 0.5, maxMs),
    p95Ms: percentileFromHist(hist, 0.95, maxMs),
    p99Ms: percentileFromHist(hist, 0.99, maxMs),
  };
}

// ── aggregation ────────────────────────────────────────────────────────────

/** One in-memory rollup row: a (granularity, bucket, scope) key and its counters. */
export interface RollupDelta extends TrafficCounters, TrafficScope {
  granularity: TrafficGranularity;
  bucketStart: number;
  latencyHist: number[];
}

const zeroCounters = (): TrafficCounters => ({
  requests: 0,
  status1xx: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0,
  statusOther: 0,
  bytesOut: 0,
  durationSumMs: 0,
  durationMaxMs: 0,
});

const STATUS_FIELD = ['status1xx', 'status2xx', 'status3xx', 'status4xx', 'status5xx'] as const;

/** Folds hits into minute AND hour rows at once, so no compaction job is needed. */
export class TrafficAggregator {
  private readonly rows = new Map<string, RollupDelta>();

  add(hit: TrafficHit, scope: TrafficScope): void {
    const sec = Math.floor(hit.startMs / 1000);
    for (const granularity of [60, 3600] as const) {
      const bucketStart = sec - (((sec % granularity) + granularity) % granularity);
      const key = `${granularity}|${bucketStart}|${scope.scopeKey}`;
      let row = this.rows.get(key);
      if (!row) {
        row = { granularity, bucketStart, ...scope, ...zeroCounters(), latencyHist: emptyHist() };
        this.rows.set(key, row);
      }
      if (!row.host && scope.host) row.host = scope.host;
      row.requests += 1;
      const cls = Math.floor(hit.status / 100);
      if (cls >= 1 && cls <= 5) row[STATUS_FIELD[cls - 1]!] += 1;
      else row.statusOther += 1;
      row.bytesOut += hit.bytesOut;
      const ms = Math.round(hit.durationMs);
      row.durationSumMs += ms;
      row.durationMaxMs = Math.max(row.durationMaxMs, ms);
      row.latencyHist[latencyBucket(hit.durationMs)]! += 1;
    }
  }

  get size(): number {
    return this.rows.size;
  }

  entries(): RollupDelta[] {
    return [...this.rows.values()];
  }
}

// ── persistence ────────────────────────────────────────────────────────────

/** Which file the tailer has read up to where. `dev`/`ino` are strings: Windows inode numbers exceed 2^53. */
export interface TrafficCursor {
  dev: string;
  ino: string;
  offset: number;
}

export async function loadTrafficCursor(db: DB): Promise<TrafficCursor | null> {
  const raw = await getSettingJson<Partial<TrafficCursor>>(db, TRAFFIC_LOG_CURSOR_KEY, null);
  if (!raw || typeof raw !== 'object') return null;
  const { dev, ino, offset } = raw;
  if (typeof dev !== 'string' || typeof ino !== 'string' || typeof offset !== 'number' || !(offset >= 0)) return null;
  return { dev, ino, offset };
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * Write a tick's rollups AND the cursor that covers them in one transaction:
 * a crash between ticks re-reads nothing and drops nothing. Counters add,
 * the max takes the max, the histogram merges element-wise.
 */
export async function commitRollups(db: DB, deltas: readonly RollupDelta[], cursor: TrafficCursor | null): Promise<void> {
  await db.transaction(async (tx: Tx) => {
    for (const d of deltas) {
      const key = and(
        eq(trafficRollups.granularity, d.granularity),
        eq(trafficRollups.bucketStart, d.bucketStart),
        eq(trafficRollups.scopeKey, d.scopeKey),
      );
      const [prev] = await tx.select().from(trafficRollups).where(key).limit(1);
      if (!prev) {
        await tx.insert(trafficRollups).values({
          granularity: d.granularity,
          bucketStart: d.bucketStart,
          scopeKey: d.scopeKey,
          domainId: d.domainId,
          serviceId: d.serviceId,
          host: d.host,
          requests: d.requests,
          status1xx: d.status1xx,
          status2xx: d.status2xx,
          status3xx: d.status3xx,
          status4xx: d.status4xx,
          status5xx: d.status5xx,
          statusOther: d.statusOther,
          bytesOut: d.bytesOut,
          durationSumMs: d.durationSumMs,
          durationMaxMs: d.durationMaxMs,
          latencyHist: d.latencyHist,
        });
        continue;
      }
      await tx
        .update(trafficRollups)
        .set({
          host: prev.host ?? d.host,
          domainId: prev.domainId ?? d.domainId,
          serviceId: prev.serviceId ?? d.serviceId,
          requests: prev.requests + d.requests,
          status1xx: prev.status1xx + d.status1xx,
          status2xx: prev.status2xx + d.status2xx,
          status3xx: prev.status3xx + d.status3xx,
          status4xx: prev.status4xx + d.status4xx,
          status5xx: prev.status5xx + d.status5xx,
          statusOther: prev.statusOther + d.statusOther,
          bytesOut: prev.bytesOut + d.bytesOut,
          durationSumMs: prev.durationSumMs + d.durationSumMs,
          durationMaxMs: Math.max(prev.durationMaxMs, d.durationMaxMs),
          latencyHist: mergeHist(mergeHist(emptyHist(), prev.latencyHist), d.latencyHist),
        })
        .where(eq(trafficRollups.id, prev.id));
    }
    if (!cursor) {
      await tx.delete(settings).where(eq(settings.key, TRAFFIC_LOG_CURSOR_KEY));
      return;
    }
    await tx
      .insert(settings)
      .values({ key: TRAFFIC_LOG_CURSOR_KEY, value: cursor as unknown as boolean, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: cursor as unknown as boolean, updatedAt: new Date() } });
  });
}

// ── the tailer ─────────────────────────────────────────────────────────────

interface FileId {
  dev: string;
  ino: string;
  size: number;
}

function fileId(file: string): FileId | null {
  try {
    const st = statSync(file, { bigint: true });
    return { dev: String(st.dev), ino: String(st.ino), size: Number(st.size) };
  } catch {
    return null;
  }
}

const sameFile = (c: TrafficCursor | null, f: FileId | null): c is TrafficCursor =>
  !!c && !!f && c.dev === f.dev && c.ino === f.ino;

/** Ask Traefik to reopen its access log (documented: SIGUSR1 closes and reopens log files). */
export async function signalTraefikReopen(): Promise<void> {
  await run('docker', ['kill', '--signal', 'USR1', TRAEFIK_CONTAINER], {}, () => undefined);
}

export interface TrafficTailerDeps {
  db: DB;
  log?: (msg: string, err?: unknown) => void;
  /** The host directory holding `access.log` (default `<data>/traffic-logs`). */
  dir?: string;
  now?: () => number;
  /** Rotation's reopen signal (default `docker kill --signal USR1 ninedeploy-traefik`). */
  reopen?: () => Promise<void>;
}

export interface TrafficTailerState {
  status: TrafficStatus;
  lastError: string | null;
  lastIngestAt: string | null;
  malformedLines: number;
}

export interface TickResult {
  /** Bytes consumed from the log files this tick. */
  bytes: number;
  lines: number;
  malformed: number;
  rotated: boolean;
  skippedBytes: number;
}

/**
 * Tails `<data>/traffic-logs/access.log` into `traffic_rollups`.
 *
 * Rotation (DESIGN §2.3) is rename + SIGUSR1: once the live file is past
 * {@link TRAFFIC_ROTATE_BYTES} it is renamed to `access.log.1` and Traefik is
 * told to reopen (it then creates a fresh `access.log`). The cursor follows
 * the inode, so lines Traefik appends to the renamed file before it reopens
 * are drained on a later tick, then the file is deleted. Lossless, and it
 * needs no write permission on the root-owned file, only on the directory the
 * panel created. If the signal cannot be delivered the rename is undone and
 * the file is truncated after reading instead (Traefik writes with O_APPEND),
 * which loses at most the lines written during the attempt; a panel that may
 * not truncate (docker mode: the file is Traefik's) retries the rotation on a
 * later tick and reports the error.
 */
export class TrafficTailer {
  private readonly db: DB;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly reopen: () => Promise<void>;
  private readonly log: (msg: string, err?: unknown) => void;
  private index: DomainIndex | null = null;
  private indexAt = 0;
  private started = false;
  private rotWaitTicks = 0;
  private rotateRetryAt = 0;
  readonly state: TrafficTailerState = { status: 'off', lastError: null, lastIngestAt: null, malformedLines: 0 };

  constructor(deps: TrafficTailerDeps) {
    this.db = deps.db;
    this.dir = deps.dir ?? trafficLogDir();
    this.now = deps.now ?? Date.now;
    this.reopen = deps.reopen ?? signalTraefikReopen;
    this.log = deps.log ?? (() => undefined);
  }

  get livePath(): string {
    return path.join(this.dir, TRAFFIC_LOG_FILE);
  }

  get rotatedPath(): string {
    return path.join(this.dir, TRAFFIC_ROTATED_FILE);
  }

  private async domainIndex(): Promise<DomainIndex> {
    if (!this.index || this.now() - this.indexAt >= ATTRIBUTION_TTL_MS) {
      this.index = await loadDomainIndex(this.db);
      this.indexAt = this.now();
    }
    return this.index;
  }

  /** Read complete lines from `file` starting at `offset`, at most the tick cap. */
  private readLines(file: string, offset: number, size: number, cap: number): { consumed: number; lines: string[]; malformed: number } {
    const want = Math.min(size - offset, cap);
    if (want <= 0) return { consumed: 0, lines: [], malformed: 0 };
    const buf = Buffer.allocUnsafe(want);
    const fd = openSync(file, 'r');
    let got = 0;
    try {
      while (got < want) {
        const n = readSync(fd, buf, got, want - got, offset + got);
        if (n <= 0) break;
        got += n;
      }
    } finally {
      closeSync(fd);
    }
    const last = buf.lastIndexOf(0x0a, got - 1);
    if (last < 0) {
      // No newline at all: a partial line waits for the next tick, unless it
      // already fills the whole cap (it can never complete) — then skip it.
      return got >= cap ? { consumed: got, lines: [], malformed: 1 } : { consumed: 0, lines: [], malformed: 0 };
    }
    const text = buf.subarray(0, last).toString('utf8');
    return { consumed: last + 1, lines: text.split('\n'), malformed: 0 };
  }

  private async ingest(lines: string[], agg: TrafficAggregator): Promise<{ lines: number; malformed: number }> {
    let count = 0;
    let malformed = 0;
    const index = lines.length ? await this.domainIndex() : new Map();
    const now = this.now();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const hit = parseAccessLogLine(line, now);
      if (!hit) {
        malformed++;
        continue;
      }
      agg.add(hit, scopeFor(hit, index));
      count++;
    }
    return { lines: count, malformed };
  }

  /** Read from `file` at the cursor, commit the rollups with the advanced cursor. */
  private async consume(file: string, cursor: TrafficCursor, size: number, cap: number, result: TickResult): Promise<TrafficCursor> {
    const read = this.readLines(file, cursor.offset, size, cap);
    if (read.consumed === 0) return cursor;
    const agg = new TrafficAggregator();
    const { lines, malformed } = await this.ingest(read.lines, agg);
    const next = { ...cursor, offset: cursor.offset + read.consumed };
    await commitRollups(this.db, agg.entries(), next);
    result.bytes += read.consumed;
    result.lines += lines;
    result.malformed += malformed + read.malformed;
    this.state.malformedLines += malformed + read.malformed;
    if (lines > 0) this.state.lastIngestAt = new Date(this.now()).toISOString();
    return next;
  }

  /**
   * One poll. `rotate: false` (the final drain on disable) never renames.
   * Never throws for a missing file; a database or filesystem error throws to
   * the caller, which records it and retries on the next tick.
   */
  async tick(opts: { rotate?: boolean; cap?: number } = {}): Promise<TickResult> {
    const rotate = opts.rotate ?? true;
    const cap = opts.cap ?? TRAFFIC_TICK_CAP_BYTES;
    const result: TickResult = { bytes: 0, lines: 0, malformed: 0, rotated: false, skippedBytes: 0 };
    let cursor = await loadTrafficCursor(this.db);
    // The final drain on disable must never take the boot-time hard-cap skip.
    if (!rotate) this.started = true;

    // 1. A rotated file: drain it (the cursor follows its inode), then delete it.
    const rot = fileId(this.rotatedPath);
    if (rot) {
      if (sameFile(cursor, rot)) {
        const capped = rot.size - cursor.offset > cap;
        cursor = await this.consume(this.rotatedPath, cursor, rot.size, cap, result);
        if (capped) return result; // more next tick
        // Read to the end. A partial last line can never complete in a
        // rotated file: it is dropped (counted as malformed).
        if (cursor.offset < rot.size) {
          result.malformed++;
          this.state.malformedLines++;
        }
        const live = fileId(this.livePath);
        const next = live ? { dev: live.dev, ino: live.ino, offset: 0 } : null;
        await commitRollups(this.db, [], next);
        cursor = next;
      }
      if (fileId(this.livePath) || this.rotWaitTicks >= 3 || !rotate) {
        rmSync(this.rotatedPath, { force: true });
        this.rotWaitTicks = 0;
      } else {
        // Traefik has not reopened yet (a crash between rename and signal):
        // ask again, and give it a few ticks before the file is dropped.
        this.rotWaitTicks++;
        await this.reopen().catch((err) => this.log('traffic analytics: reopen signal failed', err));
        return result;
      }
    }

    // 2. The live file.
    const live = fileId(this.livePath);
    if (!live) return result;
    let reset = false;
    if (!sameFile(cursor, live) || cursor.offset > live.size) {
      // A new inode (first read, Traefik recreated the file) or a truncation.
      cursor = { dev: live.dev, ino: live.ino, offset: 0 };
      reset = true;
    }
    if (!this.started && live.size - cursor.offset > TRAFFIC_HARD_CAP_BYTES) {
      // Traefik kept appending while the panel was down: skip to the tail.
      result.skippedBytes = live.size - cursor.offset;
      cursor = { ...cursor, offset: live.size };
      await commitRollups(this.db, [], cursor);
      void audit(this.db, null, 'traffic.log_skipped', TRAFFIC_LOG_FILE, { skippedBytes: result.skippedBytes });
      this.log(`traffic analytics: skipped ${result.skippedBytes} bytes of access log written while the panel was down`);
    } else {
      const before = cursor;
      cursor = await this.consume(this.livePath, cursor, live.size, cap, result);
      if (reset && cursor === before) await commitRollups(this.db, [], cursor);
    }
    this.started = true;

    // 3. Rotation, once the live file is large and nothing is left to drain.
    if (rotate && live.size > TRAFFIC_ROTATE_BYTES && !existsSync(this.rotatedPath) && this.now() >= this.rotateRetryAt) {
      result.rotated = await this.rotate(cursor, live.size);
    }
    return result;
  }

  private async rotate(cursor: TrafficCursor, size: number): Promise<boolean> {
    renameSync(this.livePath, this.rotatedPath);
    try {
      await this.reopen();
      return true;
    } catch (err) {
      // Undo, unless Traefik already created a new live file.
      if (!existsSync(this.livePath)) renameSync(this.rotatedPath, this.livePath);
      this.log('traffic analytics: USR1 reopen failed; falling back to truncate-after-read', err);
      if (cursor.offset >= size) {
        try {
          truncateSync(this.livePath, 0);
          await commitRollups(this.db, [], { ...cursor, offset: 0 });
          return true;
        } catch (truncErr) {
          this.log('traffic analytics: truncate failed; rotation retried later', truncErr);
        }
      }
      this.rotateRetryAt = this.now() + 10 * TRAFFIC_POLL_MS;
      throw new Error(`access log rotation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One scheduled tick: never throws; a failure is recorded in `state` and retried next tick. */
  async poll(): Promise<void> {
    try {
      await this.tick();
      this.state.status = 'running';
      this.state.lastError = null;
    } catch (err) {
      this.state.status = 'error';
      this.state.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.log('traffic analytics tick failed', err);
    }
  }

  /** Drain both files to their end (no rotation), then delete them and forget the cursor. */
  async drainAndPurge(maxTicks = 64): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      const r = await this.tick({ rotate: false });
      if (r.bytes === 0 && !fileId(this.rotatedPath)) break;
    }
    rmSync(this.livePath, { force: true });
    rmSync(this.rotatedPath, { force: true });
    await commitRollups(this.db, [], null);
  }
}

// ── the process-wide tailer (started by plugins/trafficAnalytics.ts and the settings PUT) ──

let active: TrafficTailer | null = null;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let lastIngestAt: string | null = null;

function schedule(tailer: TrafficTailer, delay: number): void {
  timer = setTimeout(() => {
    timer = null;
    if (active !== tailer) return;
    inFlight = tailer.poll().finally(() => {
      inFlight = null;
      if (active === tailer) schedule(tailer, TRAFFIC_POLL_MS);
    });
  }, delay);
  timer.unref();
}

/** Start the tailer (idempotent). It ticks at once, then every {@link TRAFFIC_POLL_MS}. */
export function startTrafficTailer(deps: TrafficTailerDeps): TrafficTailer {
  if (active) return active;
  const tailer = new TrafficTailer(deps);
  tailer.state.status = 'starting';
  active = tailer;
  schedule(tailer, 0);
  return tailer;
}

/** Whether the process-wide tailer is running. */
export function trafficTailerActive(): boolean {
  return active !== null;
}

/**
 * Stop the tailer. With `purge` (analytics was disabled and Traefik recreated
 * without the file): drain what Traefik wrote before the recreate, then
 * delete the log files and forget the cursor. Rollup rows stay until
 * retention. Waits for an in-flight tick, so two readers never overlap.
 */
export async function stopTrafficTailer(opts: { purge?: Pick<TrafficTailerDeps, 'db' | 'log' | 'dir'> } = {}): Promise<void> {
  const tailer = active;
  active = null;
  if (timer) clearTimeout(timer);
  timer = null;
  if (inFlight) await inFlight;
  if (tailer?.state.lastIngestAt) lastIngestAt = tailer.state.lastIngestAt;
  if (opts.purge) await new TrafficTailer(opts.purge).drainAndPurge();
}

/** The tailer's state for `GET /v1/traffic/settings` (`off` while it is not running). */
export function trafficTailerState(dir: string = trafficLogDir()): TrafficTailerState & { logBytes: number } {
  const state: TrafficTailerState = active
    ? { ...active.state }
    : { status: 'off', lastError: null, lastIngestAt, malformedLines: 0 };
  const bytes = (f: string) => fileId(path.join(dir, f))?.size ?? 0;
  return { ...state, logBytes: bytes(TRAFFIC_LOG_FILE) + bytes(TRAFFIC_ROTATED_FILE) };
}

// ── retention ──────────────────────────────────────────────────────────────

/**
 * Retention for `traffic_rollups` (DESIGN §2.3, §5), run hourly by
 * housekeeping (step `traffic-rollups`): minute rows older than 48h, hour
 * rows older than `traffic_retention_days` (default 30, 1–400), deleted in
 * batches of 5000 so one sweep never holds the write lock for long.
 * Returns the number of rows deleted.
 */
export async function pruneTrafficRollups(db: DB, now: number = Date.now()): Promise<number> {
  const days = await getTrafficRetentionDays(db);
  const cutoffs: Array<[TrafficGranularity, number]> = [
    [60, Math.floor((now - TRAFFIC_MINUTE_RETENTION_MS) / 1000)],
    [3600, Math.floor(now / 1000) - days * 86_400],
  ];
  let deleted = 0;
  for (const [granularity, cutoff] of cutoffs) {
    for (;;) {
      const res = (await db.run(
        sql`DELETE FROM traffic_rollups WHERE id IN (SELECT id FROM traffic_rollups WHERE granularity = ${granularity} AND bucket_start < ${cutoff} LIMIT ${TRAFFIC_PRUNE_BATCH})`,
      )) as unknown as { rowsAffected?: number };
      const n = Number(res?.rowsAffected ?? 0);
      deleted += n;
      if (n < TRAFFIC_PRUNE_BATCH) break;
    }
  }
  return deleted;
}

// ── summaries ──────────────────────────────────────────────────────────────

const RANGE_SECONDS: Record<TrafficRange, number> = { '1h': 3600, '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400 };

/** The first bucket a range covers: the current bucket plus the range's worth before it. */
export function rangeStart(range: TrafficRange, nowMs: number): { granularity: TrafficGranularity; since: number } {
  const granularity = trafficRangeGranularity(range);
  const nowSec = Math.floor(nowMs / 1000);
  const current = nowSec - (nowSec % granularity);
  return { granularity, since: current - RANGE_SECONDS[range] + granularity };
}

const COUNTER_SQL = sql.raw(`SUM(requests) AS requests, SUM(status_1xx) AS status1xx, SUM(status_2xx) AS status2xx,
  SUM(status_3xx) AS status3xx, SUM(status_4xx) AS status4xx, SUM(status_5xx) AS status5xx,
  SUM(status_other) AS statusOther, SUM(bytes_out) AS bytesOut, SUM(duration_sum_ms) AS durationSumMs,
  MAX(duration_max_ms) AS durationMaxMs`);

type CounterRow = { [K in keyof TrafficCounters]: number | null };

const counters = (r: CounterRow | undefined): TrafficCounters => ({
  requests: Number(r?.requests ?? 0),
  status1xx: Number(r?.status1xx ?? 0),
  status2xx: Number(r?.status2xx ?? 0),
  status3xx: Number(r?.status3xx ?? 0),
  status4xx: Number(r?.status4xx ?? 0),
  status5xx: Number(r?.status5xx ?? 0),
  statusOther: Number(r?.statusOther ?? 0),
  bytesOut: Number(r?.bytesOut ?? 0),
  durationSumMs: Number(r?.durationSumMs ?? 0),
  durationMaxMs: Number(r?.durationMaxMs ?? 0),
});

export interface TrafficReport {
  granularity: TrafficGranularity;
  totals: TrafficCounters & TrafficPercentiles;
  series: Array<TrafficCounters & { t: string }>;
  scopes: TrafficScopeTotal[];
}

/**
 * Aggregate the rollups of one range — the whole instance, or one service's
 * rows (`serviceId`, the snapshot taken at ingest). Counters are summed in
 * SQL; histograms are merged with `json_each` for the percentiles. The
 * series is sparse: buckets without requests are absent.
 */
export async function trafficReport(
  db: DB,
  opts: { range: TrafficRange; serviceId?: number; now?: number },
): Promise<TrafficReport> {
  const { granularity, since } = rangeStart(opts.range, opts.now ?? Date.now());
  const where =
    opts.serviceId === undefined
      ? sql`granularity = ${granularity} AND bucket_start >= ${since}`
      : sql`granularity = ${granularity} AND bucket_start >= ${since} AND service_id = ${opts.serviceId}`;

  const seriesRows = (await db.all(
    sql`SELECT bucket_start AS bucketStart, ${COUNTER_SQL} FROM traffic_rollups WHERE ${where} GROUP BY bucket_start ORDER BY bucket_start`,
  )) as Array<CounterRow & { bucketStart: number }>;
  const scopeRows = (await db.all(
    sql`SELECT scope_key AS scopeKey, MAX(domain_id) AS domainId, MAX(service_id) AS serviceId, MAX(host) AS host, ${COUNTER_SQL}
        FROM traffic_rollups WHERE ${where} GROUP BY scope_key`,
  )) as Array<CounterRow & { scopeKey: string; domainId: number | null; serviceId: number | null; host: string | null }>;
  const histRows = (await db.all(
    sql`SELECT scope_key AS scopeKey, CAST(j.key AS INTEGER) AS idx, SUM(j.value) AS n
        FROM traffic_rollups, json_each(traffic_rollups.latency_hist) AS j
        WHERE ${where} GROUP BY scope_key, j.key`,
  )) as Array<{ scopeKey: string; idx: number; n: number }>;

  const hists = new Map<string, number[]>();
  const total = emptyHist();
  for (const h of histRows) {
    const idx = Number(h.idx);
    if (!(idx >= 0 && idx < TRAFFIC_LATENCY_BUCKETS)) continue;
    let hist = hists.get(h.scopeKey);
    if (!hist) {
      hist = emptyHist();
      hists.set(h.scopeKey, hist);
    }
    hist[idx]! += Number(h.n ?? 0);
    total[idx]! += Number(h.n ?? 0);
  }

  const scopes: TrafficScopeTotal[] = scopeRows
    .map((r) => {
      const c = counters(r);
      return {
        scopeKey: r.scopeKey,
        domainId: r.domainId == null ? null : Number(r.domainId),
        serviceId: r.serviceId == null ? null : Number(r.serviceId),
        host: r.host ?? null,
        ...c,
        ...percentiles(hists.get(r.scopeKey) ?? emptyHist(), c.durationMaxMs),
      };
    })
    .sort((a, b) => b.requests - a.requests || a.scopeKey.localeCompare(b.scopeKey));

  const sum = scopes.reduce<TrafficCounters>((acc, s) => {
    for (const k of Object.keys(acc) as Array<keyof TrafficCounters>) {
      acc[k] = k === 'durationMaxMs' ? Math.max(acc[k], s[k]) : acc[k] + s[k];
    }
    return acc;
  }, zeroCounters());

  return {
    granularity,
    totals: { ...sum, ...percentiles(total, sum.durationMaxMs) },
    series: seriesRows.map((r) => ({ t: new Date(Number(r.bucketStart) * 1000).toISOString(), ...counters(r) })),
    scopes,
  };
}
