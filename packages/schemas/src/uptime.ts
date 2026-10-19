import { z } from 'zod';
import { id } from './common.js';

/**
 * 0.16.8 uptime monitors and public status pages.
 *
 * A monitor probes a target from the panel host on an interval: an HTTP(S)
 * URL (status code, optional keyword in the body) or a TCP `host:port`. Its
 * state goes up / down after `failuresBeforeDown` failed checks in a row, and
 * every transition is an `alert.monitor_down` / `alert.monitor_up` event on
 * the existing notification channels. A status page shows a chosen set of
 * monitors publicly, by name only (never the target).
 */

export const MONITOR_KINDS = ['http', 'tcp'] as const;
export const monitorKind = z.enum(MONITOR_KINDS);
export type MonitorKind = z.infer<typeof monitorKind>;

export const MONITOR_METHODS = ['GET', 'HEAD'] as const;
export const monitorMethod = z.enum(MONITOR_METHODS);

export const MONITOR_STATUSES = ['pending', 'up', 'down', 'paused'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const MONITOR_INTERVAL_MIN = 30;
export const MONITOR_INTERVAL_MAX = 3600;
export const MONITOR_TIMEOUT_MAX = 60;
export const MONITOR_FAILURES_MAX = 10;
export const MONITOR_KEYWORD_MAX = 200;
/** Status pages show at most this many monitors. */
export const STATUS_PAGE_MONITORS_MAX = 50;
/** Days of history a status page shows. */
export const STATUS_PAGE_DAYS = 90;
export const DEFAULT_EXPECTED_STATUS = '200-399';

/**
 * The status codes an HTTP check accepts: comma-separated codes and ranges,
 * each between 100 and 599 (`200-299`, `200,204,301-302`). Null when the
 * text is not such a list.
 */
export function parseExpectedStatus(spec: string): Array<[number, number]> | null {
  const parts = spec.split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.length > 20) return null;
  const ranges: Array<[number, number]> = [];
  for (const part of parts) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(part);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo < 100 || hi > 599 || lo > hi) return null;
    ranges.push([lo, hi]);
  }
  return ranges;
}

/** Whether `code` is one of the codes `spec` accepts (an invalid spec accepts none). */
export function statusMatches(code: number, spec: string): boolean {
  const ranges = parseExpectedStatus(spec);
  return ranges !== null && ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

/** `host:port` for a TCP check: a hostname, an IPv4 address or a bracketed IPv6 address, and a port 1–65535. */
export function parseTcpTarget(target: string): { host: string; port: number } | null {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\d{1,5})$/.exec(target);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  const host = m[1]!.startsWith('[') ? m[1]!.slice(1, -1) : m[1]!;
  return { host, port };
}

/** Why `target` is not valid for `kind`, or null. */
export function monitorTargetProblem(kind: MonitorKind, target: string): string | null {
  if (kind === 'tcp') return parseTcpTarget(target) ? null : 'a TCP target is host:port (an IPv6 address in brackets)';
  if (!httpUrl.safeParse(target).success) return 'an HTTP target is an http:// or https:// URL';
  // userinfo is everything between `//` and an `@` before the first `/`, `?` or `#`.
  if (/^https?:\/\/[^/?#]*@/i.test(target)) return 'credentials in the URL are not allowed';
  return null;
}

const httpUrl = z.url({ protocol: /^https?$/ });

const monitorFields = {
  name: z.string().trim().min(1).max(100),
  /** The service the monitor belongs to (members who can see it see the monitor), or null for an operator-only monitor. */
  serviceId: id.nullable(),
  kind: monitorKind,
  /** http: the URL; tcp: `host:port`. */
  target: z.string().trim().min(1).max(2048),
  method: monitorMethod,
  /** http: accepted status codes, see {@link parseExpectedStatus}. */
  expectedStatus: z
    .string()
    .trim()
    .max(200)
    .refine((v) => parseExpectedStatus(v) !== null, 'codes and ranges between 100 and 599, such as 200-299,301'),
  /** http: text the body must contain (the first 1 MiB is read). */
  keyword: z.string().max(MONITOR_KEYWORD_MAX).nullable(),
  intervalSeconds: z.number().int().min(MONITOR_INTERVAL_MIN).max(MONITOR_INTERVAL_MAX),
  timeoutSeconds: z.number().int().min(1).max(MONITOR_TIMEOUT_MAX),
  failuresBeforeDown: z.number().int().min(1).max(MONITOR_FAILURES_MAX),
  followRedirects: z.boolean(),
  /** http: false accepts a self-signed or expired certificate. */
  verifyTls: z.boolean(),
  enabled: z.boolean(),
};

type TargetFields = { kind?: MonitorKind; target?: string; keyword?: string | null; method?: string };

function checkTarget(v: TargetFields, ctx: z.RefinementCtx): void {
  if (v.kind !== undefined && v.target !== undefined) {
    const problem = monitorTargetProblem(v.kind, v.target);
    if (problem) ctx.addIssue({ code: 'custom', path: ['target'], message: problem });
  }
  if (v.kind === 'tcp' && v.keyword) ctx.addIssue({ code: 'custom', path: ['keyword'], message: 'a keyword applies to HTTP checks' });
  if (v.method === 'HEAD' && v.keyword) ctx.addIssue({ code: 'custom', path: ['keyword'], message: 'a HEAD request has no body to search; use GET' });
}

/** `POST /v1/monitors` (operator). */
export const monitorCreate = z
  .object({
    ...monitorFields,
    serviceId: monitorFields.serviceId.default(null),
    method: monitorFields.method.default('GET'),
    expectedStatus: monitorFields.expectedStatus.default(DEFAULT_EXPECTED_STATUS),
    keyword: monitorFields.keyword.default(null),
    intervalSeconds: monitorFields.intervalSeconds.default(60),
    timeoutSeconds: monitorFields.timeoutSeconds.default(10),
    failuresBeforeDown: monitorFields.failuresBeforeDown.default(2),
    followRedirects: monitorFields.followRedirects.default(true),
    verifyTls: monitorFields.verifyTls.default(true),
    enabled: monitorFields.enabled.default(true),
  })
  .strict()
  .superRefine(checkTarget);
export type MonitorCreateInput = z.input<typeof monitorCreate>;
export type MonitorCreate = z.infer<typeof monitorCreate>;

/**
 * `PATCH /v1/monitors/:id` (operator). Partial; the route checks the merged
 * kind, target, method and keyword with {@link monitorTargetProblem} again.
 */
export const monitorPatch = z.object(monitorFields).partial().strict().superRefine(checkTarget);
export type MonitorPatch = z.infer<typeof monitorPatch>;

/** A monitor as the API returns it. */
export interface MonitorView {
  id: number;
  name: string;
  serviceId: number | null;
  kind: MonitorKind;
  target: string;
  method: 'GET' | 'HEAD';
  expectedStatus: string;
  keyword: string | null;
  intervalSeconds: number;
  timeoutSeconds: number;
  failuresBeforeDown: number;
  followRedirects: boolean;
  verifyTls: boolean;
  enabled: boolean;
  status: MonitorStatus;
  /** When the status last changed. */
  statusSince: string | null;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastResponseMs: number | null;
  lastStatusCode: number | null;
  lastError: string | null;
  /** https: when the certificate the last check saw expires. */
  certExpiresAt: string | null;
  /** Share of successful checks, 0–100 with two decimals; null without checks. */
  uptime: { h24: number | null; d7: number | null; d30: number | null };
  createdAt: string;
}

/** One check result. */
export interface MonitorCheckView {
  ts: string;
  ok: boolean;
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
}

/** A status page slug: lowercase letters, digits and dashes. */
export const statusPageSlug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and dashes, not starting or ending with a dash');

const statusPageFields = {
  slug: statusPageSlug,
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable(),
  /** A notice shown at the top (maintenance, an incident), or null. */
  notice: z.string().trim().max(1000).nullable(),
  /** Off: the page answers 404 to everyone. */
  published: z.boolean(),
  showResponseTimes: z.boolean(),
  /** In display order, each once. */
  monitorIds: z
    .array(id)
    .max(STATUS_PAGE_MONITORS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'each monitor once'),
};

/** `POST /v1/status-pages` (operator). */
export const statusPageCreate = z
  .object({
    ...statusPageFields,
    description: statusPageFields.description.default(null),
    notice: statusPageFields.notice.default(null),
    published: statusPageFields.published.default(false),
    showResponseTimes: statusPageFields.showResponseTimes.default(true),
    monitorIds: statusPageFields.monitorIds.default([]),
  })
  .strict();
export type StatusPageCreateInput = z.input<typeof statusPageCreate>;

/** `PATCH /v1/status-pages/:id` (operator). */
export const statusPagePatch = z.object(statusPageFields).partial().strict();
export type StatusPagePatch = z.infer<typeof statusPagePatch>;

export interface StatusPageView {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  notice: string | null;
  published: boolean;
  showResponseTimes: boolean;
  monitorIds: number[];
  /** Path of the public page on the panel. */
  path: string;
  createdAt: string;
}

/** One day of a monitor's history on a public status page. */
export interface PublicStatusDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Null: no checks that day. */
  uptime: number | null;
}

/** `GET /v1/status/:slug`: what a public status page shows. Never a target. */
export interface PublicStatusPage {
  title: string;
  description: string | null;
  notice: string | null;
  /** `operational` when every monitor is up, `degraded` when some are down, `down` when all are. */
  overall: 'operational' | 'degraded' | 'down' | 'unknown';
  monitors: Array<{
    name: string;
    status: 'up' | 'down' | 'unknown';
    uptime90d: number | null;
    avgResponseMs: number | null;
    days: PublicStatusDay[];
  }>;
  generatedAt: string;
}

/** The overall state of a status page from its monitors' states. */
export function overallStatus(states: Array<'up' | 'down' | 'unknown'>): PublicStatusPage['overall'] {
  const known = states.filter((s) => s !== 'unknown');
  if (known.length === 0) return 'unknown';
  const down = known.filter((s) => s === 'down').length;
  if (down === 0) return 'operational';
  return down === known.length ? 'down' : 'degraded';
}
