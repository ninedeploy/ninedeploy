import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { TLSSocket } from 'node:tls';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { type DB, uptimeChecks, uptimeDaily, uptimeMonitors } from '@ninedeploy/db';
import { type MonitorStatus, parseTcpTarget, statusMatches } from '@ninedeploy/schemas';
import { VERSION } from '../version.js';
import { audit } from './audit.js';

/**
 * 0.16.8 uptime monitors (docs/UPTIME.md): the probe, the up/down state
 * machine, the daily rollups a status page reads, and their retention.
 *
 * Checks run from the panel host. Monitors are operator configuration, so a
 * target may be a private address — watching internal services is the
 * point — and the egress guard that protects member-supplied URLs does not
 * apply. Nothing is probed until an operator creates a monitor.
 */

/** Raw checks are kept this long (the 24-hour figure and the check list read them). */
export const UPTIME_CHECK_RETENTION_DAYS = 7;
/** Daily rollups are kept this long (status pages show 90 days, the API 30). */
export const UPTIME_DAILY_RETENTION_DAYS = 400;
/** An HTTP check reads at most this much of the body when it looks for a keyword. */
export const KEYWORD_BODY_LIMIT = 1024 * 1024;
/** Redirects followed before a check fails. */
export const MAX_REDIRECTS = 5;
/** `last_error` and `uptime_checks.error` are cut to this length. */
const ERROR_MAX = 300;

export type UptimeMonitorRow = typeof uptimeMonitors.$inferSelect;

export interface ProbeResult {
  ok: boolean;
  /** Time to the response (http) or to the connection (tcp), when there was one. */
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
  /** https: when the first hop's certificate expires. */
  certExpiresAt: Date | null;
}

type ProbeTarget = Pick<
  UptimeMonitorRow,
  'kind' | 'target' | 'method' | 'expectedStatus' | 'keyword' | 'timeoutSeconds' | 'followRedirects' | 'verifyTls'
>;

const cut = (s: string) => (s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX - 1)}…` : s);

/** A short reason for a failed request: the error code where Node gives one. */
export function describeError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const message = e?.message ?? String(err);
  if (e?.code && !message.includes(e.code)) return cut(`${e.code}: ${message}`);
  return cut(message);
}

/** Probe one target. Never throws: every failure is a result. */
export async function probeMonitor(m: ProbeTarget, now: () => number = Date.now): Promise<ProbeResult> {
  return m.kind === 'tcp' ? probeTcp(m, now) : probeHttp(m, now);
}

function probeTcp(m: ProbeTarget, now: () => number): Promise<ProbeResult> {
  const target = parseTcpTarget(m.target);
  if (!target) return Promise.resolve({ ok: false, responseMs: null, statusCode: null, error: 'invalid host:port', certExpiresAt: null });
  const started = now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const done = (result: ProbeResult) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => done({ ok: false, responseMs: null, statusCode: null, error: `timed out after ${m.timeoutSeconds} s`, certExpiresAt: null }),
      m.timeoutSeconds * 1000,
    );
    socket.once('connect', () => done({ ok: true, responseMs: now() - started, statusCode: null, error: null, certExpiresAt: null }));
    socket.once('error', (err) => done({ ok: false, responseMs: null, statusCode: null, error: describeError(err), certExpiresAt: null }));
  });
}

interface HopResponse {
  statusCode: number;
  location: string | undefined;
  body: string | null;
  certExpiresAt: Date | null;
}

function requestOnce(url: URL, m: ProbeTarget, signal: AbortSignal, readBody: boolean): Promise<HopResponse> {
  const lib = url.protocol === 'https:' ? https : http;
  // SNI names a host, never an address: Node 26 refuses an IP `servername`
  // outright (ERR_INVALID_ARG_VALUE), so an https monitor on an IP sends none.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const tls = url.protocol === 'https:' ? { rejectUnauthorized: m.verifyTls, ...(net.isIP(host) === 0 ? { servername: host } : {}) } : {};
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: m.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: { 'user-agent': `NineDeploy-Uptime/${VERSION}`, accept: '*/*' },
        // A monitor connection is never reused, so each check measures a real connect.
        agent: false,
        signal,
        ...tls,
      },
      (res) => {
        let certExpiresAt: Date | null = null;
        const socket = res.socket as TLSSocket | null;
        if (url.protocol === 'https:' && socket && typeof socket.getPeerCertificate === 'function') {
          const validTo = socket.getPeerCertificate()?.valid_to;
          const at = validTo ? new Date(validTo) : null;
          certExpiresAt = at && !Number.isNaN(at.getTime()) ? at : null;
        }
        const statusCode = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
        if (!readBody) {
          res.resume();
          res.once('end', () => resolve({ statusCode, location, body: null, certExpiresAt }));
          res.once('error', reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size >= KEYWORD_BODY_LIMIT) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= KEYWORD_BODY_LIMIT) {
            resolve({ statusCode, location, body: Buffer.concat(chunks).subarray(0, KEYWORD_BODY_LIMIT).toString('utf8'), certExpiresAt });
            res.destroy();
          }
        });
        res.once('end', () => resolve({ statusCode, location, body: Buffer.concat(chunks).toString('utf8'), certExpiresAt }));
        res.once('error', reject);
      },
    );
    req.once('error', reject);
    req.end();
  });
}

async function probeHttp(m: ProbeTarget, now: () => number): Promise<ProbeResult> {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), m.timeoutSeconds * 1000);
  let certExpiresAt: Date | null = null;
  try {
    let url = new URL(m.target);
    for (let hop = 0; ; hop++) {
      const isRedirect = (code: number) => code >= 300 && code < 400;
      const res = await requestOnce(url, m, controller.signal, m.keyword != null && m.keyword !== '');
      if (hop === 0) certExpiresAt = res.certExpiresAt;
      if (m.followRedirects && isRedirect(res.statusCode) && res.location) {
        if (hop >= MAX_REDIRECTS) {
          return { ok: false, responseMs: now() - started, statusCode: res.statusCode, error: `more than ${MAX_REDIRECTS} redirects`, certExpiresAt };
        }
        const next = new URL(res.location, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return { ok: false, responseMs: now() - started, statusCode: res.statusCode, error: `redirect to ${next.protocol} refused`, certExpiresAt };
        }
        url = next;
        continue;
      }
      const responseMs = now() - started;
      if (!statusMatches(res.statusCode, m.expectedStatus)) {
        return { ok: false, responseMs, statusCode: res.statusCode, error: `status ${res.statusCode} (expected ${m.expectedStatus})`, certExpiresAt };
      }
      if (m.keyword && !(res.body ?? '').includes(m.keyword)) {
        return { ok: false, responseMs, statusCode: res.statusCode, error: cut(`keyword "${m.keyword}" not found`), certExpiresAt };
      }
      return { ok: true, responseMs, statusCode: res.statusCode, error: null, certExpiresAt };
    }
  } catch (err) {
    const error = controller.signal.aborted ? `timed out after ${m.timeoutSeconds} s` : describeError(err);
    return { ok: false, responseMs: null, statusCode: null, error, certExpiresAt };
  } finally {
    clearTimeout(timer);
  }
}

/** `YYYY-MM-DD` of `at` in UTC. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The state after one check (pure): `failuresBeforeDown` failures in a row turn it down, one success up. */
export function nextMonitorState(
  current: { status: MonitorStatus; consecutiveFailures: number; failuresBeforeDown: number },
  ok: boolean,
): { status: MonitorStatus; consecutiveFailures: number; transition: 'down' | 'up' | null } {
  if (ok) {
    return { status: 'up', consecutiveFailures: 0, transition: current.status === 'down' ? 'up' : null };
  }
  const failures = current.consecutiveFailures + 1;
  if (failures >= Math.max(1, current.failuresBeforeDown) && current.status !== 'down') {
    return { status: 'down', consecutiveFailures: failures, transition: 'down' };
  }
  return { status: current.status === 'paused' ? 'pending' : current.status, consecutiveFailures: failures, transition: null };
}

/** A duration for a recovery message: `4 min`, `2 h 5 min`, `40 s`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}

/**
 * Record one check: the raw row, the day's rollup, the monitor's state, and
 * — on a transition — the `alert.monitor_down` / `alert.monitor_up` audit
 * event, which the notifier delivers to channels whose filter matches
 * (`alert.` or the action) and to a service's `alert` subscriptions.
 */
export async function recordCheck(db: DB, monitor: UptimeMonitorRow, result: ProbeResult, at: Date = new Date()): Promise<UptimeMonitorRow> {
  await db.insert(uptimeChecks).values({
    monitorId: monitor.id,
    ok: result.ok,
    responseMs: result.responseMs,
    statusCode: result.statusCode,
    error: result.error,
    ts: at,
  });
  await db
    .insert(uptimeDaily)
    .values({ monitorId: monitor.id, day: utcDay(at), checks: 1, failures: result.ok ? 0 : 1, responseMsSum: result.ok ? (result.responseMs ?? 0) : 0 })
    .onConflictDoUpdate({
      target: [uptimeDaily.monitorId, uptimeDaily.day],
      set: {
        checks: sql`${uptimeDaily.checks} + 1`,
        failures: sql`${uptimeDaily.failures} + ${result.ok ? 0 : 1}`,
        responseMsSum: sql`${uptimeDaily.responseMsSum} + ${result.ok ? (result.responseMs ?? 0) : 0}`,
      },
    });
  const next = nextMonitorState(monitor, result.ok);
  const changed = next.status !== monitor.status;
  const [row] = await db
    .update(uptimeMonitors)
    .set({
      status: next.status,
      consecutiveFailures: next.consecutiveFailures,
      lastCheckedAt: at,
      lastResponseMs: result.responseMs,
      lastStatusCode: result.statusCode,
      lastError: result.error,
      ...(result.certExpiresAt ? { certExpiresAt: result.certExpiresAt } : {}),
      ...(changed ? { statusSince: at } : {}),
    })
    .where(eq(uptimeMonitors.id, monitor.id))
    .returning();
  const meta = { monitorId: monitor.id, ...(monitor.serviceId != null ? { serviceId: monitor.serviceId } : {}) };
  if (next.transition === 'down') {
    void audit(db, null, 'alert.monitor_down', `${monitor.name} #${monitor.id}: ${result.error ?? 'check failed'}`, meta);
  } else if (next.transition === 'up') {
    const since = monitor.statusSince ? at.getTime() - monitor.statusSince.getTime() : null;
    void audit(db, null, 'alert.monitor_up', `${monitor.name} #${monitor.id}${since != null ? ` is up again after ${formatDuration(since)}` : ' is up again'}`, meta);
  }
  return row ?? monitor;
}

/** Whether a monitor is due at `nowMs`. */
export function monitorDue(m: Pick<UptimeMonitorRow, 'enabled' | 'intervalSeconds' | 'lastCheckedAt'>, nowMs: number): boolean {
  if (!m.enabled) return false;
  if (!m.lastCheckedAt) return true;
  // Half a second of slack, so a 5 s scheduler tick never pushes a check a whole tick late.
  return nowMs - m.lastCheckedAt.getTime() >= m.intervalSeconds * 1000 - 500;
}

/** Share of successful checks, 0–100 with two decimals; null without checks. */
export const uptimePercent = (checks: number, failures: number): number | null =>
  checks > 0 ? Math.round(((checks - failures) / checks) * 10_000) / 100 : null;

/** The 24-hour, 7-day and 30-day uptime of each monitor. */
export async function monitorUptimes(
  db: DB,
  ids: number[],
  now: Date = new Date(),
): Promise<Map<number, { h24: number | null; d7: number | null; d30: number | null }>> {
  const out = new Map<number, { h24: number | null; d7: number | null; d30: number | null }>();
  if (ids.length === 0) return out;
  const since24h = new Date(now.getTime() - 24 * 3600_000);
  const raw = await db
    .select({
      monitorId: uptimeChecks.monitorId,
      checks: sql<number>`count(*)`,
      failures: sql<number>`sum(case when ${uptimeChecks.ok} then 0 else 1 end)`,
    })
    .from(uptimeChecks)
    .where(and(inArray(uptimeChecks.monitorId, ids), gte(uptimeChecks.ts, since24h)))
    .groupBy(uptimeChecks.monitorId);
  const daysAgo = (n: number) => utcDay(new Date(now.getTime() - n * 86_400_000));
  const daily = await db
    .select()
    .from(uptimeDaily)
    .where(and(inArray(uptimeDaily.monitorId, ids), gte(uptimeDaily.day, daysAgo(29))));
  for (const id of ids) {
    const r = raw.find((x) => x.monitorId === id);
    const sum = (fromDay: string) => {
      const rows = daily.filter((d) => d.monitorId === id && d.day >= fromDay);
      return uptimePercent(
        rows.reduce((a, d) => a + d.checks, 0),
        rows.reduce((a, d) => a + d.failures, 0),
      );
    };
    out.set(id, { h24: r ? uptimePercent(Number(r.checks), Number(r.failures ?? 0)) : null, d7: sum(daysAgo(6)), d30: sum(daysAgo(29)) });
  }
  return out;
}

/** Delete raw checks and rollups past their retention, in batches. Returns the rows deleted. */
export async function pruneUptime(db: DB, now: number = Date.now(), batch = 5000): Promise<{ checks: number; daily: number }> {
  const cutoff = Math.floor(now / 1000) - UPTIME_CHECK_RETENTION_DAYS * 86_400;
  let checks = 0;
  for (;;) {
    const res = (await db.run(
      sql`DELETE FROM uptime_checks WHERE id IN (SELECT id FROM uptime_checks WHERE ts < ${cutoff} LIMIT ${batch})`,
    )) as unknown as { rowsAffected?: number };
    const n = Number(res?.rowsAffected ?? 0);
    checks += n;
    if (n < batch) break;
  }
  const dayCutoff = utcDay(new Date(now - UPTIME_DAILY_RETENTION_DAYS * 86_400_000));
  const res = (await db.run(sql`DELETE FROM uptime_daily WHERE day < ${dayCutoff}`)) as unknown as { rowsAffected?: number };
  return { checks, daily: Number(res?.rowsAffected ?? 0) };
}
