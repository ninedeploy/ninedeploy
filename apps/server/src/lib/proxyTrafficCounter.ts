import { createHash } from 'node:crypto';
import { errorRatePercent, type CanaryReleaseStats, type ProxyTrafficOpen, type ServingTrafficOpen } from '@ninedeploy/schemas';

export const PROXY_TRAFFIC_RECORD_LIMIT = 100_000;
export const PROXY_TRAFFIC_BYTE_LIMIT = 32 * 1024 * 1024;
export const PROXY_TRAFFIC_LINE_LIMIT = 16 * 1024;
export const proxyTrafficUnavailable = (reason: string) => new Error(`Node proxy traffic unavailable: ${reason}`);
export const proxyTrafficTargetHash = (input: ProxyTrafficOpen | ServingTrafficOpen): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export const proxyTrafficRoutingGeneration = (input: Pick<ProxyTrafficOpen, 'routingConfig'>): string => {
  if (Buffer.byteLength(input.routingConfig) > 1024 * 1024) throw proxyTrafficUnavailable('routing configuration exceeds 1 MiB');
  return createHash('sha256').update(input.routingConfig).digest('hex');
};

const Q = '"(?:[^"\\\\]|\\\\.)*"';
const COMMON = new RegExp('^\\S+ - \\S+ \\[[^\\]\\r\\n]+\\] (' + Q + ') ([0-9]{3}) [0-9]+ ' + Q + ' ' + Q + ' ([0-9]+) (' + Q + ') (' + Q + ') ([0-9]+)ms$');
export interface ProxyAccessRecord { request: string; status: number; sequence: bigint; router: string; upstream: string; ms: number }

/** Parse default Traefik CLF without retaining/exporting client, path or header fields. */
export function parseProxyAccessRecord(line: string): ProxyAccessRecord | null {
  if (Buffer.byteLength(line) > PROXY_TRAFFIC_LINE_LIMIT) throw proxyTrafficUnavailable('oversized log record');
  if (!/^\S+ - \S+ \[/.test(line)) return null; // operational stderr/stdout is not an access record
  const match = COMMON.exec(line);
  if (!match) throw proxyTrafficUnavailable('malformed access log');
  const sequence = BigInt(match[3]!);
  const status = Number(match[2]), ms = Number(match[6]);
  if (sequence <= 0n || sequence > 18_446_744_073_709_551_615n || status < 100 || status > 599 || !Number.isSafeInteger(ms)) {
    throw proxyTrafficUnavailable('invalid response metadata');
  }
  return { request: match[1]!, status, sequence, router: match[4]!.slice(1, -1), upstream: match[5]!.slice(1, -1), ms };
}

type Hit<Group extends string = string> = { group: Group | null; status: number; ms: number };
const summary = (hits: Hit[]): CanaryReleaseStats => {
  const errors = hits.filter(h => h.status >= 500).length, times = hits.map(h => h.ms).sort((a, b) => a - b);
  return { requests: hits.length, errors, errorRate: errorRatePercent(errors, hits.length), p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1]! : null };
};

/** A complete result covers every request started between two observed markers. */
class TrafficCounter<Group extends string> {
  private readonly records = new Map<bigint, Hit<Group>>();
  private readonly upstreams = new Map<string, Group>();
  private start: bigint | null = null;
  private end: bigint | null = null;
  private finishing = false;
  private count = 0;
  readonly startPath: string;
  readonly endPath: string;

  constructor(private readonly slug: string, private readonly groups: Record<Group, ProxyTrafficOpen['stable']>, windowId: string) {
    this.startPath = `/__ninedeploy_traffic_${windowId}_start`;
    this.endPath = `/__ninedeploy_traffic_${windowId}_end`;
    for (const group of Object.keys(groups) as Group[]) for (const target of groups[group]) this.upstreams.set(`http://${target.name}:${target.port}`, group);
  }

  requestFinish(): void { this.finishing = true; }
  started(): boolean { return this.start !== null; }
  ended(): boolean { return this.end !== null; }

  ingest(line: string): void {
    const row = parseProxyAccessRecord(line);
    if (!row) return;
    const marker = (target: string) => row.request === `"GET ${target} HTTP/1.1"` || row.request === `"GET ${target} HTTP/1.0"`;
    const startMarker = marker(this.startPath), endMarker = marker(this.endPath);
    if (this.records.has(row.sequence)) throw proxyTrafficUnavailable('duplicate request counter');
    if (startMarker || endMarker) {
      if (row.status !== 404 || row.router !== '-' || row.upstream !== '-') throw proxyTrafficUnavailable('observation marker was routed');
      if (startMarker) {
        if (this.start !== null) throw proxyTrafficUnavailable('duplicate start marker');
        this.start = row.sequence;
      } else {
        if (!this.finishing || this.start === null || this.end !== null || row.sequence <= this.start) throw proxyTrafficUnavailable('invalid end marker');
        this.end = row.sequence;
        if (this.end - this.start - 1n > BigInt(PROXY_TRAFFIC_RECORD_LIMIT)) throw proxyTrafficUnavailable('request count limit exceeded');
      }
      this.records.set(row.sequence, { group: null, status: row.status, ms: row.ms });
      return;
    }
    if (++this.count > PROXY_TRAFFIC_RECORD_LIMIT) throw proxyTrafficUnavailable('record limit exceeded');
    const prefix = `${this.slug}_`;
    let group: Group | null = null;
    if (row.router.startsWith(prefix) && /^\d+@file$/.test(row.router.slice(prefix.length))) {
      group = this.upstreams.get(row.upstream) ?? null;
      if (!group && row.status >= 500) throw proxyTrafficUnavailable('server error cannot be attributed');
      if (!group && row.upstream !== '-') throw proxyTrafficUnavailable('runtime route changed');
    }
    this.records.set(row.sequence, { group, status: row.status, ms: row.ms });
  }

  snapshot() {
    if (this.start === null) throw proxyTrafficUnavailable('start marker not observed');
    const hits = [...this.records].filter(([seq]) => seq > this.start! && (this.end === null || seq < this.end)).map(([, hit]) => hit);
    const expected = this.end === null ? null : Number(this.end - this.start - 1n);
    return { startCounter: this.start.toString(), endCounter: this.end?.toString() ?? null,
      observed: hits.length, expected, complete: expected !== null && hits.length === expected,
      ...Object.fromEntries((Object.keys(this.groups) as Group[]).map(group => [group, summary(hits.filter(h => h.group === group))])) as Record<Group, CanaryReleaseStats> };
  }
}

export class ProxyTrafficCounter extends TrafficCounter<'stable' | 'canary'> {
  constructor(input: Pick<ProxyTrafficOpen, 'slug' | 'stable' | 'canary'>, windowId: string) {
    super(input.slug, { stable: input.stable, canary: input.canary }, windowId);
  }
}

export class ServingTrafficCounter extends TrafficCounter<'serving'> {
  constructor(input: Pick<ServingTrafficOpen, 'slug' | 'serving'>, windowId: string) {
    super(input.slug, { serving: input.serving }, windowId);
  }
}
