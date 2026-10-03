import type { LogDrainFormat, LogDrainType } from '@ninedeploy/schemas';
import { guardedFetch } from '../lib/egressGuard.js';

/** Drains are always addressed by a URL string; the narrower contract keeps
 * the guarded default assignable while tests may still inject a mock. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LogPayloadEntry {
  timestamp: string;
  service: string;
  container: string;
  line: string;
  stream?: 'stdout' | 'stderr';
}

/**
 * r231: the labels `lib/logSearch.ts` queries by — `{service="<slug>"}` for
 * one service, `{job="ninedeploy"}` cluster-wide. The drain used to push only
 * `app`/`container`/`stream`, so every search came back empty even for lines
 * that had been delivered. `app` stays for dashboards built on it.
 */
function lokiLabels(entry: LogPayloadEntry): Record<string, string> {
  return {
    job: 'ninedeploy',
    service: entry.service,
    app: entry.service,
    container: entry.container,
    stream: entry.stream ?? 'stdout',
  };
}

/** Several entries as ONE request body (the shipper's unit of delivery). */
export function formatLogBatch(
  type: LogDrainType,
  format: LogDrainFormat,
  entries: LogPayloadEntry[],
): { body: string; contentType: string } {
  if (type === 'loki') {
    const streams = new Map<string, { stream: Record<string, string>; values: Array<[string, string]> }>();
    for (const e of entries) {
      const labels = lokiLabels(e);
      const key = JSON.stringify(labels);
      const nano = String(Date.parse(e.timestamp) * 1_000_000 || Date.now() * 1_000_000);
      const s = streams.get(key) ?? { stream: labels, values: [] };
      s.values.push([nano, e.line]);
      streams.set(key, s);
    }
    return { body: JSON.stringify({ streams: [...streams.values()] }), contentType: 'application/json' };
  }
  if (type === 'datadog') {
    return {
      body: JSON.stringify(entries.map((e) => JSON.parse(formatLogPayload(type, format, e).body)[0])),
      contentType: 'application/json',
    };
  }
  if (format === 'raw' || format === 'rfc5424') {
    return { body: entries.map((e) => formatLogPayload(type, format, e).body).join(''), contentType: 'text/plain' };
  }
  return {
    body: JSON.stringify(entries.map((e) => JSON.parse(formatLogPayload(type, format, e).body))),
    contentType: 'application/json',
  };
}

export function formatLogPayload(
  type: LogDrainType,
  format: LogDrainFormat,
  entry: LogPayloadEntry,
): { body: string; contentType: string } {
  if (type === 'loki') {
    const nano = String(Date.parse(entry.timestamp) * 1_000_000 || Date.now() * 1_000_000);
    const body = JSON.stringify({
      streams: [
        {
          stream: lokiLabels(entry),
          values: [[nano, entry.line]],
        },
      ],
    });
    return { body, contentType: 'application/json' };
  }

  if (type === 'datadog') {
    const body = JSON.stringify([
      {
        ddsource: 'ninedeploy',
        service: entry.service,
        hostname: entry.container,
        message: entry.line,
        status: entry.stream === 'stderr' ? 'warn' : 'info',
        date: Date.parse(entry.timestamp) || Date.now(),
      },
    ]);
    return { body, contentType: 'application/json' };
  }

  if (format === 'raw') {
    return { body: `[${entry.timestamp}] [${entry.service}/${entry.container}] ${entry.line}\n`, contentType: 'text/plain' };
  }

  if (format === 'rfc5424') {
    const pri = entry.stream === 'stderr' ? '<11>' : '<14>';
    const rfc = `${pri}1 ${entry.timestamp} ${entry.container} ${entry.service} - - - ${entry.line}\n`;
    return { body: rfc, contentType: 'text/plain' };
  }

  // Default JSON format
  return {
    body: JSON.stringify({
      timestamp: entry.timestamp,
      service: entry.service,
      container: entry.container,
      stream: entry.stream ?? 'stdout',
      message: entry.line,
    }),
    contentType: 'application/json',
  };
}

export async function dispatchLogToDrain(
  drain: {
    url: string;
    type: LogDrainType;
    format: LogDrainFormat;
    apiKey?: string | null;
    headers?: Record<string, string> | null;
  },
  entry: LogPayloadEntry,
  // Defaults to guardedFetch (same policy as notification webhooks) — drain
  // payloads carry raw log lines, which are exactly the exfil channel a
  // compromised admin credential should not get for free.
  fetchImpl: FetchLike = guardedFetch,
): Promise<{ ok: boolean; status: number; error?: string }> {
  return postToDrain(drain, formatLogPayload(drain.type, drain.format, entry), fetchImpl);
}

async function postToDrain(
  drain: { url: string; type: LogDrainType; apiKey?: string | null; headers?: Record<string, string> | null },
  { body, contentType }: { body: string; contentType: string },
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'User-Agent': 'NineDeploy-LogDrain/1.0',
    ...(drain.headers ?? {}),
  };

  if (drain.apiKey) {
    if (drain.type === 'datadog') {
      headers['DD-API-KEY'] = drain.apiKey;
    } else {
      headers['Authorization'] = drain.apiKey.startsWith('Bearer ') ? drain.apiKey : `Bearer ${drain.apiKey}`;
    }
  }

  try {
    const res = await fetchImpl(drain.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(6000),
    });
    // Release the connection: an unread body keeps the socket busy.
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.ok, status: res.status };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message };
  }
}

/** Deliver a batch; same transport, auth and egress policy as a single entry. */
export async function dispatchLogBatch(
  drain: {
    url: string;
    type: LogDrainType;
    format: LogDrainFormat;
    apiKey?: string | null;
    headers?: Record<string, string> | null;
  },
  entries: LogPayloadEntry[],
  fetchImpl: FetchLike = guardedFetch,
): Promise<{ ok: boolean; status: number; error?: string }> {
  return postToDrain(drain, formatLogBatch(drain.type, drain.format, entries), fetchImpl);
}

export async function testLogDrainConnection(
  drain: {
    url: string;
    type: LogDrainType;
    format: LogDrainFormat;
    apiKey?: string | null;
    headers?: Record<string, string> | null;
  },
  fetchImpl: FetchLike = guardedFetch,
): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
  const start = Date.now();
  const testEntry: LogPayloadEntry = {
    timestamp: new Date().toISOString(),
    service: 'ninedeploy-probe',
    container: 'probe-1',
    line: 'NineDeploy log drain connectivity test ping',
    stream: 'stdout',
  };

  const res = await dispatchLogToDrain(drain, testEntry, fetchImpl);
  const latencyMs = Date.now() - start;

  if (res.ok) {
    return { ok: true, latencyMs, message: `Successfully connected (HTTP ${res.status})` };
  }

  return {
    ok: false,
    latencyMs,
    message: res.error ? `Connection failed: ${res.error}` : `Endpoint rejected test payload (HTTP ${res.status})`,
  };
}
