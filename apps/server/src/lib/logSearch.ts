/**
 * `ninedeploy logs search` — G-16 cluster log search.
 *
 * The outbound logDrains pipeline forwards every
 * container's stdout / stderr to a remote sink (Loki,
 * Vector, Datadog, ...). For Loki the upstream exposes
 * a native HTTP query API (`/loki/api/v1/query_range`),
 * and we round-trip to it through the configured
 * drain's URL. For the other types the upstream
 * doesn't expose a query surface and the search route
 * returns 501 with a clear "drain does not support
 * search" message — the operator can wire a Loki sidecar
 * to a Vector pipeline if they want both.
 *
 * Authentication: the drain's stored `apiKeyEncrypted`
 * (if any) is sent as `Authorization: Bearer <key>`;
 * the egress guard is intentionally NOT applied here
 * because the operator's log host is the canonical
 * destination of the log drain itself.
 */
import { eq } from 'drizzle-orm';
import { logDrains, services, type DB, type LogDrain } from '@ninedeploy/db';
import { decrypt } from './crypto.js';

export interface LogSearchOptions {
  /** Free-text search (case-insensitive substring). */
  query: string;
  /** Restrict to one service. When omitted, every service
   *  whose drain is queried is searched. */
  serviceId?: number;
  /** When the search window starts. Default: 15 minutes ago. */
  since?: Date;
  /** Hard cap on returned lines. Default: 200. */
  limit?: number;
  /** Query a specific drain. When omitted, the route
   *  picks the first enabled Loki drain. */
  drainId?: number;
  /** r287: when set (a non-operator caller), only ENABLED drains that are
   *  global (`serviceId` null) or bound to this service may be used — for an
   *  explicit `drainId` and for the automatic pick alike. A drain bound to
   *  another service (or switched off) is treated as absent. */
  restrictToServiceId?: number;
}

export interface LogSearchResult {
  /** The drain that served the search. */
  drain: { id: number; name: string; type: string };
  /** The service filter actually applied (echoed for the CLI). */
  serviceId: number | null;
  /** Window the search ran over. */
  window: { since: string; until: string };
  lines: Array<{ ts: number; line: string; service: string | null }>;
  /** True when the underlying drain doesn't support
   *  search; the caller is expected to surface this as
   *  a 501 / "not supported". */
  unsupported: boolean;
}

/** Public entry: pick a drain, run the search, normalise
 *  the result. The caller (route) translates
 *  `unsupported: true` into a 501. */
export async function searchLogs(
  db: DB,
  opts: LogSearchOptions,
): Promise<LogSearchResult> {
  const drain = await pickDrain(db, opts);
  if (!drain) {
    throw new Error('No enabled Loki drain configured (other drain types do not support search)');
  }
  if (drain.type !== 'loki') {
    return {
      drain: { id: drain.id, name: drain.name, type: drain.type },
      serviceId: opts.serviceId ?? null,
      window: { since: (opts.since ?? new Date(Date.now() - 15 * 60_000)).toISOString(), until: new Date().toISOString() },
      lines: [],
      unsupported: true,
    };
  }
  const since = opts.since ?? new Date(Date.now() - 15 * 60_000);
  const until = new Date();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const serviceLabel = await resolveServiceLabel(db, opts.serviceId);
  const lokiQuery = serviceLabel
    ? `{service="${serviceLabel}"} |= "${escapeLoki(opts.query)}"`
    : `{job="ninedeploy"} |= "${escapeLoki(opts.query)}"`;
  const url = new URL('/loki/api/v1/query_range', drain.url);
  url.searchParams.set('query', lokiQuery);
  url.searchParams.set('start', (since.getTime() / 1000).toString());
  url.searchParams.set('end', (until.getTime() / 1000).toString());
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('direction', 'backward');

  const headers: Record<string, string> = {};
  if (drain.apiKeyEncrypted) {
    headers['Authorization'] = `Bearer ${decrypt(drain.apiKeyEncrypted)}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Loki query failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const payload = (await res.json()) as LokiQueryResponse;
  const lines = flattenLokiStreams(payload);
  return {
    drain: { id: drain.id, name: drain.name, type: drain.type },
    serviceId: opts.serviceId ?? null,
    window: { since: since.toISOString(), until: until.toISOString() },
    lines,
    unsupported: false,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function pickDrain(db: DB, opts: LogSearchOptions): Promise<LogDrain | null> {
  // r287: every drain carries its own (decrypted-on-use) API key. A member
  // could name any drainId — disabled, or bound to another tenant's service —
  // and spend that drain's credentials against its log host.
  const usable = (r: LogDrain): boolean =>
    opts.restrictToServiceId === undefined ||
    (r.enabled && (r.serviceId == null || r.serviceId === opts.restrictToServiceId));
  if (opts.drainId !== undefined) {
    const row = await db.query.logDrains.findFirst({ where: eq(logDrains.id, opts.drainId) });
    return row && usable(row) ? row : null;
  }
  // The first enabled Loki drain wins. Other types are
  // listed so the operator's `logs drains ls` shows the
  // candidate; the search route is the only caller that
  // ever picks one.
  const rows = await db.query.logDrains.findMany();
  return rows.find((r) => r.enabled && r.type === 'loki' && usable(r)) ?? null;
}

async function resolveServiceLabel(db: DB, serviceId: number | undefined): Promise<string | null> {
  if (serviceId === undefined) return null;
  const svc = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!svc) return null;
  return svc.slug;
}

function escapeLoki(s: string): string {
  // Double-quoted LogQL string (Go-style interpreted literal): a raw `"`
  // terminates the literal and a raw `\` starts an escape sequence, so both
  // must be escaped — `\` first, then `"` — and literal newlines are illegal
  // in interpreted literals. Backtick RAW strings (used here before) support
  // NO escapes at all: a query containing a backtick ended the literal early
  // and the remainder parsed as LogQL (400s / injected pipeline stages),
  // while an escaped `\\` was taken literally, silently filtering for two
  // backslashes. (Grafana: "How to escape special characters with Loki's
  // LogQL".) For a substring filter the default `|=` semantics is enough;
  // regex metacharacters only matter for `|~` filters, which we don't emit.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

interface LokiStream {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

interface LokiQueryResponse {
  data?: { result?: LokiStream[] };
  status?: string;
}

function flattenLokiStreams(payload: LokiQueryResponse): Array<{ ts: number; line: string; service: string | null }> {
  if (payload.status && payload.status !== 'success') return [];
  const streams = payload.data?.result ?? [];
  const out: Array<{ ts: number; line: string; service: string | null }> = [];
  for (const stream of streams) {
    const service = stream.stream['service'] ?? stream.stream['job'] ?? null;
    for (const [ts, line] of stream.values) {
      // ts is the nanosecond timestamp as a string.
      const tsMs = Number(BigInt(ts) / 1_000_000n);
      out.push({ ts: tsMs, line, service });
    }
  }
  // Loki returns streams unordered when direction=backward;
  // sort by ts descending for a stable CLI display.
  out.sort((a, b) => b.ts - a.ts);
  return out;
}
