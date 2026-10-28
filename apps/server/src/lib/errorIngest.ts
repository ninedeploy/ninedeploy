import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { and, desc, eq, inArray, like, lt, ne, or, sql } from 'drizzle-orm';
import { deployments, errorEvents, errorIssues, settings, type DB, type ErrorIssue } from '@ninedeploy/db';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G5.4 Sentry-compatible error ingest. A service gets a DSN
 * (`https://<key>@<panel>/<serviceId>`); Sentry SDKs post envelopes to
 * `/api/<serviceId>/envelope/` (or events to the legacy `/store/`). Events
 * are grouped into issues by fingerprint, and an issue remembers the deploy
 * it first appeared under: the deployment whose commit is the event's
 * `release`, else the deployment that was live.
 *
 * The key is stored hashed in the settings row `error_ingest:<serviceId>`.
 */

const keyName = (serviceId: number) => `error_ingest:${serviceId}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface StoredKey {
  keyHash: string;
  createdAt: string;
}

export async function ingestKeyInfo(db: DB, serviceId: number): Promise<{ createdAt: string } | null> {
  const k = await getSettingJson<StoredKey>(db, keyName(serviceId), null);
  return k ? { createdAt: k.createdAt } : null;
}

/** A new key (replacing any earlier one). The key itself is answered once, never stored. */
export async function rotateIngestKey(db: DB, serviceId: number): Promise<string> {
  const key = randomBytes(16).toString('hex');
  await setSettingJson<StoredKey>(db, keyName(serviceId), { keyHash: sha256(key), createdAt: new Date().toISOString() });
  return key;
}

export async function removeIngestKey(db: DB, serviceId: number): Promise<void> {
  await db.delete(settings).where(eq(settings.key, keyName(serviceId)));
}

export async function ingestKeyMatches(db: DB, serviceId: number, key: string | null): Promise<boolean> {
  if (!key || !/^[0-9a-f]{32}$/.test(key)) return false;
  const k = await getSettingJson<StoredKey>(db, keyName(serviceId), null);
  if (!k) return false;
  return timingSafeEqual(Buffer.from(sha256(key), 'hex'), Buffer.from(k.keyHash, 'hex'));
}

/** The `sentry_key` of an `X-Sentry-Auth` header, a `?sentry_key=` or an envelope's `dsn`. */
export function sentryKeyFrom(authHeader: string | undefined, queryKey: string | undefined, envelopeDsn?: string): string | null {
  const m = authHeader ? /sentry_key=([0-9a-f]+)/i.exec(authHeader) : null;
  if (m?.[1]) return m[1].toLowerCase();
  if (queryKey) return queryKey.toLowerCase();
  if (envelopeDsn) {
    try {
      return new URL(envelopeDsn).username.toLowerCase() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Most an uncompressed body may hold. */
export const MAX_INGEST_BYTES = 1024 * 1024;

export function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  const opts = { maxOutputLength: MAX_INGEST_BYTES };
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return body;
    case 'gzip':
      return gunzipSync(body, opts);
    case 'deflate':
      return inflateSync(body, opts);
    case 'br':
      return brotliDecompressSync(body, opts);
    default:
      throw new Error(`Unsupported content encoding ${encoding}`);
  }
}

export interface Envelope {
  dsn?: string;
  events: Array<Record<string, unknown>>;
}

/** The `event` items of an envelope (other item types — sessions, transactions, attachments — are skipped). */
export function parseEnvelope(raw: Buffer): Envelope {
  let pos = 0;
  const line = (): Buffer | null => {
    if (pos >= raw.length) return null;
    const nl = raw.indexOf(0x0a, pos);
    const end = nl === -1 ? raw.length : nl;
    const out = raw.subarray(pos, end);
    pos = end + 1;
    return out;
  };
  const head = line();
  if (!head) throw new Error('Empty envelope');
  const header = JSON.parse(head.toString('utf8')) as { dsn?: unknown };
  const events: Array<Record<string, unknown>> = [];
  for (let items = 0; items < 100; items++) {
    const itemHead = line();
    if (!itemHead) break;
    if (itemHead.length === 0) continue;
    const item = JSON.parse(itemHead.toString('utf8')) as { type?: unknown; length?: unknown };
    let payload: Buffer;
    if (typeof item.length === 'number' && Number.isInteger(item.length) && item.length >= 0) {
      payload = raw.subarray(pos, pos + item.length);
      pos += item.length;
      if (raw[pos] === 0x0a) pos++;
    } else {
      payload = line() ?? Buffer.alloc(0);
    }
    if (item.type === 'event') {
      const event = JSON.parse(payload.toString('utf8')) as unknown;
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event as Record<string, unknown>);
    }
  }
  return { ...(typeof header.dsn === 'string' ? { dsn: header.dsn } : {}), events };
}

interface Frame {
  filename?: unknown;
  module?: unknown;
  function?: unknown;
  in_app?: unknown;
}
interface ExceptionValue {
  type?: unknown;
  value?: unknown;
  stacktrace?: { frames?: unknown };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function exceptionValues(event: Record<string, unknown>): ExceptionValue[] {
  const ex = event['exception'];
  const values = Array.isArray(ex) ? ex : ex && typeof ex === 'object' ? (ex as { values?: unknown }).values : null;
  return Array.isArray(values) ? (values.filter((v) => v && typeof v === 'object') as ExceptionValue[]) : [];
}

/** Digits, hex ids and quoted values vary between occurrences of one error. */
const normalize = (s: string) =>
  s
    .replace(/0x[0-9a-f]+/gi, '?')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '?')
    .replace(/\d+/g, '?')
    .replace(/(["'])(?:(?!\1).){0,200}\1/g, '?')
    .slice(0, 500);

export interface Grouping {
  fingerprint: string;
  title: string;
  culprit: string | null;
  level: string;
}

/** Group an event the way Sentry's defaults do, closely enough: the exception type and its in-app frames. */
export function groupEvent(event: Record<string, unknown>): Grouping {
  const values = exceptionValues(event);
  const top = values[values.length - 1];
  const message =
    str((event['logentry'] as { formatted?: unknown; message?: unknown } | undefined)?.formatted) ??
    str((event['logentry'] as { message?: unknown } | undefined)?.message) ??
    str(event['message']) ??
    (event['message'] && typeof event['message'] === 'object' ? str((event['message'] as { formatted?: unknown }).formatted) : null);
  const frames = (Array.isArray(top?.stacktrace?.frames) ? (top!.stacktrace!.frames as unknown[]) : []).filter((f): f is Frame => !!f && typeof f === 'object');
  const inApp = frames.some((f) => f.in_app === true) ? frames.filter((f) => f.in_app === true) : frames;
  const last = inApp[inApp.length - 1];
  const where = (f: Frame) => `${str(f.module) ?? str(f.filename) ?? '?'}:${str(f.function) ?? '?'}`;
  const type = str(top?.type);
  const value = str(top?.value);
  const title = (type ? `${type}${value ? `: ${value}` : ''}` : (message ?? value ?? '(no message)')).slice(0, 200);
  const culprit = last ? `${str(last.function) ?? '?'} (${str(last.module) ?? str(last.filename) ?? '?'})`.slice(0, 200) : str(event['culprit'])?.slice(0, 200) ?? null;
  const basis = type
    ? inApp.length
      ? `${type}\n${inApp.slice(-5).map(where).join('\n')}`
      : `${type}\n${normalize(value ?? '')}`
    : `message\n${normalize(message ?? title)}`;
  const defaultHash = sha256(basis);
  const custom = Array.isArray(event['fingerprint']) ? (event['fingerprint'] as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 20) : [];
  const fingerprint = custom.length ? sha256(custom.map((p) => (p === '{{ default }}' ? defaultHash : p)).join('\n')) : defaultHash;
  const level = str(event['level']);
  return { fingerprint, title, culprit, level: level && ['fatal', 'error', 'warning', 'info', 'debug'].includes(level) ? level : 'error' };
}

/** The deploy an event belongs to: its release's commit, else the live deployment. */
export async function deploymentFor(db: DB, serviceId: number, release: string | null): Promise<number | null> {
  if (release && /^[0-9a-f]{7,40}$/i.test(release)) {
    const byCommit = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.serviceId, serviceId), or(eq(deployments.commitSha, release), like(deployments.commitSha, `${release.toLowerCase()}%`))))
      .orderBy(desc(deployments.id))
      .limit(1);
    if (byCommit[0]) return byCommit[0].id;
  }
  const live = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ['running'])))
    .orderBy(desc(deployments.id))
    .limit(1);
  return live[0]?.id ?? null;
}

/**
 * Storage bounds. A browser DSN is public, so anyone can send events: an
 * issue keeps its latest events only, payloads are capped, and past the
 * issue cap new fingerprints are counted under one overflow issue.
 * Only unresolved issues count toward the cap, so resolving or ignoring
 * squatted issues makes room. An issue keeps its first events and its
 * latest ones, so a flood cannot evict the original evidence.
 * A hard cap on all issues, whatever their status, keeps the storage bound.
 * Worst case per service: 1,500 issues × 20 events × 32 KiB.
 */
export const ERROR_LIMITS = { payloadChars: 32 * 1024, eventsPerIssue: 20, firstEventsKept: 5, issuesPerService: 500, totalIssuesPerService: 1500 };
export const OVERFLOW_FINGERPRINT = 'overflow';

export interface Recorded {
  issue: ErrorIssue;
  isNew: boolean;
  regressed: boolean;
}

/** Store one event under its issue (created on first sight; a resolved issue seen again reopens). */
export async function recordEvent(db: DB, serviceId: number, event: Record<string, unknown>, now = new Date()): Promise<Recorded> {
  const g = groupEvent(event);
  const release = str(event['release'])?.slice(0, 200) ?? null;
  const environment = str(event['environment'])?.slice(0, 100) ?? null;
  const deploymentId = await deploymentFor(db, serviceId, release);
  let existing = await db.query.errorIssues.findFirst({ where: and(eq(errorIssues.serviceId, serviceId), eq(errorIssues.fingerprint, g.fingerprint)) });
  if (!existing) {
    const [{ open = 0, total = 0 } = {}] = await db
      .select({
        open: sql<number>`sum(case when ${errorIssues.status} = 'unresolved' then 1 else 0 end)`,
        total: sql<number>`count(*)`,
      })
      .from(errorIssues)
      .where(and(eq(errorIssues.serviceId, serviceId), ne(errorIssues.fingerprint, OVERFLOW_FINGERPRINT)));
    if (Number(open) >= ERROR_LIMITS.issuesPerService || Number(total) >= ERROR_LIMITS.totalIssuesPerService) {
      g.fingerprint = OVERFLOW_FINGERPRINT;
      g.title = `More than ${ERROR_LIMITS.issuesPerService} distinct issues; resolve or wait for old ones to expire`;
      g.culprit = null;
      existing = await db.query.errorIssues.findFirst({ where: and(eq(errorIssues.serviceId, serviceId), eq(errorIssues.fingerprint, OVERFLOW_FINGERPRINT)) });
    }
  }
  let issue: ErrorIssue;
  let isNew = false;
  let regressed = false;
  if (!existing) {
    const inserted = await db
      .insert(errorIssues)
      .values({ serviceId, fingerprint: g.fingerprint, title: g.title, culprit: g.culprit, level: g.level, firstSeen: now, lastSeen: now, firstRelease: release, firstDeploymentId: deploymentId, lastDeploymentId: deploymentId })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      issue = inserted[0];
      isNew = true;
    } else {
      // Another request created it first.
      return recordEvent(db, serviceId, event, now);
    }
  } else {
    regressed = existing.status === 'resolved';
    const [updated] = await db
      .update(errorIssues)
      .set({ count: existing.count + 1, lastSeen: now, lastDeploymentId: deploymentId, level: g.level, ...(regressed ? { status: 'unresolved' as const } : {}) })
      .where(eq(errorIssues.id, existing.id))
      .returning();
    issue = updated!;
  }
  const eventId = str(event['event_id'])?.slice(0, 64) ?? null;
  // An SDK retry sends the same event again: counted, not stored twice.
  const seen = eventId ? await db.query.errorEvents.findFirst({ where: and(eq(errorEvents.issueId, issue.id), eq(errorEvents.eventId, eventId)) }) : null;
  if (!seen) {
    const payload = JSON.stringify(event);
    const cap = ERROR_LIMITS.payloadChars;
    await db.insert(errorEvents).values({
      issueId: issue.id,
      eventId,
      release,
      environment,
      deploymentId,
      payload: payload.length > cap ? JSON.stringify({ truncated: true, head: payload.slice(0, cap - 100) }) : payload,
      receivedAt: now,
    });
    // The first events of an issue and its latest ones are kept.
    const first = ERROR_LIMITS.firstEventsKept;
    const latest = Math.max(ERROR_LIMITS.eventsPerIssue - first, 1);
    await db.run(
      sql`DELETE FROM error_events WHERE issue_id = ${issue.id}
        AND id NOT IN (SELECT id FROM error_events WHERE issue_id = ${issue.id} ORDER BY id ASC LIMIT ${first})
        AND id NOT IN (SELECT id FROM error_events WHERE issue_id = ${issue.id} ORDER BY id DESC LIMIT ${latest})`,
    );
  }
  return { issue, isNew, regressed };
}

/**
 * Alerts per service per hour. Past the budget one `alert.error_burst` says
 * so and the rest stay quiet until the hour is over; the issues are still
 * recorded. Mutable so a test can shrink it.
 */
export const ALERT_BUDGET = { perHour: 10 };
const alertWindows = new Map<number, { start: number; count: number }>();
export function alertDecision(serviceId: number, now = Date.now()): 'alert' | 'burst' | 'quiet' {
  const w = alertWindows.get(serviceId);
  if (!w || now - w.start >= 3_600_000) {
    alertWindows.set(serviceId, { start: now, count: 1 });
    return 'alert';
  }
  w.count++;
  if (w.count <= ALERT_BUDGET.perHour) return 'alert';
  return w.count === ALERT_BUDGET.perHour + 1 ? 'burst' : 'quiet';
}

/** Per-service events per minute; past it SDKs get 429 and back off. */
export const INGEST_RATE = { perMinute: 300 };
const windows = new Map<number, { start: number; count: number }>();
export function ingestAllowed(serviceId: number, now = Date.now()): boolean {
  const w = windows.get(serviceId);
  if (!w || now - w.start >= 60_000) {
    windows.set(serviceId, { start: now, count: 1 });
    return true;
  }
  w.count++;
  return w.count <= INGEST_RATE.perMinute;
}
export const resetIngestWindows = () => {
  windows.clear();
  alertWindows.clear();
};

/** Events are kept 30 days; an issue not seen for 90 days goes, with its events. */
export const ERROR_EVENT_RETENTION_DAYS = 30;
export const ERROR_ISSUE_RETENTION_DAYS = 90;

export async function pruneErrorEvents(db: DB, now: number = Date.now(), batch = 5000): Promise<{ events: number; issues: number }> {
  const cutoff = Math.floor(now / 1000) - ERROR_EVENT_RETENTION_DAYS * 86_400;
  let events = 0;
  for (;;) {
    const res = (await db.run(sql`DELETE FROM error_events WHERE id IN (SELECT id FROM error_events WHERE received_at < ${cutoff} LIMIT ${batch})`)) as unknown as {
      rowsAffected?: number;
    };
    const n = Number(res?.rowsAffected ?? 0);
    events += n;
    if (n < batch) break;
  }
  const gone = await db
    .delete(errorIssues)
    .where(lt(errorIssues.lastSeen, new Date(now - ERROR_ISSUE_RETENTION_DAYS * 86_400_000)))
    .returning({ id: errorIssues.id });
  return { events, issues: gone.length };
}
