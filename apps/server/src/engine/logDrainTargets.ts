import { signRequest } from '../lib/awsSigV4.js';

/**
 * G3.4: more log-drain targets, on the same native HTTP shipper as the others
 * (batches, retries, egress guard): Elasticsearch / OpenSearch (`_bulk`),
 * Splunk HEC, Better Stack, New Relic, Axiom and CloudWatch Logs
 * (PutLogEvents, SigV4). Each target here is a body format plus how the
 * drain's API key is presented. The drain types are a TypeScript enum over a
 * text column without a CHECK, so adding one needs no migration.
 */

export const EXTRA_DRAIN_TYPES = ['elasticsearch', 'splunk', 'betterstack', 'newrelic', 'axiom', 'cloudwatch'] as const;
export type ExtraDrainType = (typeof EXTRA_DRAIN_TYPES)[number];
export const isExtraDrainType = (t: string): t is ExtraDrainType => (EXTRA_DRAIN_TYPES as readonly string[]).includes(t);

export interface DrainEntry {
  timestamp: string;
  service: string;
  container: string;
  line: string;
  stream?: 'stdout' | 'stderr';
}

const ms = (ts: string) => {
  const p = Date.parse(ts);
  return Number.isFinite(p) ? p : Date.now();
};

/** The CloudWatch target in a drain URL: `https://logs.<region>.amazonaws.com/?group=<log group>&stream=<log stream>`. */
export function cloudWatchTarget(url: string): { region: string; group: string; stream: string; endpoint: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /^logs\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/.exec(u.hostname);
  const group = u.searchParams.get('group') ?? '';
  const stream = u.searchParams.get('stream') ?? '';
  if (u.protocol !== 'https:' || !m || !/^[\w./#-]{1,512}$/.test(group) || !/^[^:*]{1,512}$/.test(stream)) return null;
  return { region: m[1]!, group, stream, endpoint: `https://${u.host}/` };
}

/** Why a drain URL does not fit its type (null when it does). */
export function extraDrainUrlProblem(type: ExtraDrainType, url: string): string | null {
  if (type === 'cloudwatch') {
    return cloudWatchTarget(url) ? null : 'A CloudWatch drain URL is https://logs.<region>.amazonaws.com/?group=<log group>&stream=<log stream>';
  }
  if (type === 'elasticsearch') {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return /^\/[^/_][^/]*$/.test(path) ? null : 'An Elasticsearch / OpenSearch drain URL ends in the index or data stream, e.g. https://es.example.com:9200/logs-ninedeploy';
  }
  return null;
}

/** One request body for a batch. */
export function formatExtraBatch(type: ExtraDrainType, url: string, entries: DrainEntry[]): { body: string; contentType: string } {
  switch (type) {
    case 'elasticsearch': {
      // `create` works for both a plain index and a data stream.
      const index = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
      const lines = entries.flatMap((e) => [
        JSON.stringify({ create: { _index: index } }),
        JSON.stringify({ '@timestamp': new Date(ms(e.timestamp)).toISOString(), message: e.line, service: e.service, container: e.container, stream: e.stream ?? 'stdout' }),
      ]);
      return { body: `${lines.join('\n')}\n`, contentType: 'application/x-ndjson' };
    }
    case 'splunk':
      // HEC takes concatenated event objects, not an array.
      return {
        body: entries
          .map((e) => JSON.stringify({ time: ms(e.timestamp) / 1000, host: e.container, source: e.service, sourcetype: 'ninedeploy', event: e.line, fields: { stream: e.stream ?? 'stdout' } }))
          .join('\n'),
        contentType: 'application/json',
      };
    case 'betterstack':
      return {
        body: JSON.stringify(entries.map((e) => ({ dt: new Date(ms(e.timestamp)).toISOString(), message: e.line, service: e.service, container: e.container, stream: e.stream ?? 'stdout' }))),
        contentType: 'application/json',
      };
    case 'newrelic':
      return {
        body: JSON.stringify([
          {
            common: { attributes: { 'instrumentation.provider': 'ninedeploy' } },
            logs: entries.map((e) => ({ timestamp: ms(e.timestamp), message: e.line, attributes: { service: e.service, container: e.container, stream: e.stream ?? 'stdout' } })),
          },
        ]),
        contentType: 'application/json',
      };
    case 'axiom':
      return {
        body: JSON.stringify(entries.map((e) => ({ _time: new Date(ms(e.timestamp)).toISOString(), message: e.line, service: e.service, container: e.container, stream: e.stream ?? 'stdout' }))),
        contentType: 'application/json',
      };
    case 'cloudwatch': {
      const target = cloudWatchTarget(url)!;
      // PutLogEvents wants the events in time order.
      const logEvents = entries
        .map((e) => ({ timestamp: ms(e.timestamp), message: `[${e.service}/${e.container}] ${e.line}` }))
        .sort((a, b) => a.timestamp - b.timestamp);
      return { body: JSON.stringify({ logGroupName: target.group, logStreamName: target.stream, logEvents }), contentType: 'application/x-amz-json-1.1' };
    }
  }
}

/** How the drain's API key is sent. */
export function extraAuthHeaders(type: ExtraDrainType, apiKey: string | null | undefined): Record<string, string> {
  if (!apiKey) return {};
  switch (type) {
    case 'elasticsearch':
      // `user:password` is basic auth; anything else an Elasticsearch API key (already base64).
      return { Authorization: apiKey.includes(':') ? `Basic ${Buffer.from(apiKey).toString('base64')}` : `ApiKey ${apiKey}` };
    case 'splunk':
      return { Authorization: apiKey.startsWith('Splunk ') ? apiKey : `Splunk ${apiKey}` };
    case 'newrelic':
      return { 'Api-Key': apiKey };
    case 'cloudwatch':
      return {};
    default:
      return { Authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}` };
  }
}

/** CloudWatch's API key is `ACCESS_KEY_ID:SECRET_ACCESS_KEY` (optionally `:SESSION_TOKEN`). */
export function cloudWatchCredentials(apiKey: string | null | undefined): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null {
  if (!apiKey) return null;
  const [accessKeyId, secretAccessKey, ...rest] = apiKey.split(':');
  if (!accessKeyId || !secretAccessKey) return null;
  return rest.length ? { accessKeyId, secretAccessKey, sessionToken: rest.join(':') } : { accessKeyId, secretAccessKey };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One signed CloudWatch Logs call. */
async function cloudWatchCall(fetchImpl: FetchLike, url: string, apiKey: string | null | undefined, action: string, body: string, signal: AbortSignal): Promise<Response> {
  const target = cloudWatchTarget(url)!;
  const creds = cloudWatchCredentials(apiKey);
  if (!creds) throw new Error('CloudWatch drains need the API key ACCESS_KEY_ID:SECRET_ACCESS_KEY');
  const signed = signRequest(
    { method: 'POST', url: target.endpoint, service: 'logs', region: target.region, body, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Logs_20140328.${action}` } },
    creds,
  );
  return fetchImpl(target.endpoint, { method: 'POST', headers: signed.headers, body, signal });
}

/**
 * Deliver a CloudWatch batch: PutLogEvents, creating the log group and stream
 * once when they do not exist yet.
 */
export async function postCloudWatch(
  fetchImpl: FetchLike,
  drain: { url: string; apiKey?: string | null },
  body: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    let res = await cloudWatchCall(fetchImpl, drain.url, drain.apiKey, 'PutLogEvents', body, signal);
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      if (!/ResourceNotFoundException/.test(text)) return { ok: false, status: 400, error: text.slice(0, 300) };
      const t = cloudWatchTarget(drain.url)!;
      if (/log group/i.test(text)) {
        const g = await cloudWatchCall(fetchImpl, drain.url, drain.apiKey, 'CreateLogGroup', JSON.stringify({ logGroupName: t.group }), signal);
        await g.body?.cancel().catch(() => undefined);
      }
      const s = await cloudWatchCall(fetchImpl, drain.url, drain.apiKey, 'CreateLogStream', JSON.stringify({ logGroupName: t.group, logStreamName: t.stream }), signal);
      await s.body?.cancel().catch(() => undefined);
      res = await cloudWatchCall(fetchImpl, drain.url, drain.apiKey, 'PutLogEvents', body, signal);
    }
    const ok = res.ok;
    const error = ok ? undefined : (await res.text().catch(() => '')).slice(0, 300);
    if (ok) await res.body?.cancel().catch(() => undefined);
    return { ok, status: res.status, ...(error && { error }) };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Elasticsearch answers 200 for a bulk request whose items failed: read the `errors` flag. */
export async function elasticsearchBulkFailed(res: Response): Promise<string | null> {
  try {
    const json = (await res.json()) as { errors?: boolean; items?: Array<Record<string, { error?: { reason?: string } }>> };
    if (!json.errors) return null;
    const first = json.items?.map((i) => Object.values(i)[0]?.error?.reason).find(Boolean);
    return `bulk request had failed items${first ? `: ${first}` : ''}`;
  } catch {
    return null;
  }
}
