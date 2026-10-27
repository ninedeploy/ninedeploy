import { createHash } from 'node:crypto';
import { absoluteTarget, errorText, relativeName, zoneForHost } from '../../lib/dnsProviderCredentials.js';
import { guardedFetch } from '../../lib/egressGuard.js';
import type { DomainRecordResult, DomainRecordSpec, DomainZone, IDomainProvider } from '../types.js';

export interface OvhCredentials {
  endpoint: 'ovh-eu' | 'ovh-ca' | 'ovh-us';
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
}

export type OvhCredentialsProvider = () => Promise<OvhCredentials | null>;

export const OVH_ENDPOINTS: Record<OvhCredentials['endpoint'], string> = {
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0',
  'ovh-us': 'https://api.us.ovhcloud.com/1.0',
};

/** How long a measured clock offset to the OVH API is reused. */
const TIME_DELTA_TTL_MS = 10 * 60_000;
const timeDeltas = new Map<string, { delta: number; at: number }>();

/** OVH signs with its own clock: measure the offset once, not on every call. */
async function ovhTime(base: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const cached = timeDeltas.get(base);
  if (cached && Date.now() - cached.at < TIME_DELTA_TTL_MS) return now + cached.delta;
  const res = await guardedFetch(`${base}/auth/time`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OVH API error: ${res.status} reading the server time`);
  const server = Number(await res.text());
  if (!Number.isFinite(server)) throw new Error('OVH API error: unreadable server time');
  timeDeltas.set(base, { delta: server - now, at: Date.now() });
  return server;
}

/** `$1$` + SHA-1 of `secret+consumer+METHOD+url+body+timestamp` (OVH API v1). */
export function ovhSignature(c: Pick<OvhCredentials, 'applicationSecret' | 'consumerKey'>, method: string, url: string, body: string, ts: number): string {
  return `$1$${createHash('sha1').update(`${c.applicationSecret}+${c.consumerKey}+${method}+${url}+${body}+${ts}`).digest('hex')}`;
}

/**
 * `IDomainProvider` for OVHcloud DNS zones (G3.5), API v1 with an
 * application key, its secret and a consumer key limited to
 * `/domain/zone/*`. A zone change only goes live after `refresh`, so every
 * create and delete is followed by one.
 */
export class OvhProvider implements IDomainProvider {
  readonly name = 'ovh';

  constructor(private readonly credentials: OvhCredentialsProvider) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const c = await this.credentials();
    if (!c) throw new Error('OVH is not configured. Save an OVH application and consumer key under Settings → Integrations → DNS records.');
    const base = OVH_ENDPOINTS[c.endpoint];
    const url = `${base}${path}`;
    const payload = body === undefined ? '' : JSON.stringify(body);
    const ts = await ovhTime(base);
    const res = await guardedFetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Ovh-Application': c.applicationKey,
        'X-Ovh-Consumer': c.consumerKey,
        'X-Ovh-Timestamp': String(ts),
        'X-Ovh-Signature': ovhSignature(c, method, url, payload, ts),
      },
      ...(payload ? { body: payload } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = new Error(`OVH API error: ${res.status} ${await errorText(res)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const raw = await res.text();
    return (raw ? JSON.parse(raw) : null) as T;
  }

  async listZones(): Promise<DomainZone[]> {
    const names = await this.request<string[]>('GET', '/domain/zone');
    return names.map((n) => ({ id: n, name: n }));
  }

  async findZoneForHost(hostname: string): Promise<DomainZone | null> {
    return zoneForHost(await this.listZones(), hostname);
  }

  private refresh(zone: string): Promise<unknown> {
    return this.request('POST', `/domain/zone/${encodeURIComponent(zone)}/refresh`);
  }

  /**
   * A record at `subDomain` that a new `type` record would sit next to: one
   * of the same type (OVH would add it to the round-robin) or a CNAME on
   * either side. Each candidate is read back and its subDomain compared
   * exactly, since the list filter is not trusted to scope the apex.
   */
  private async clashingRecord(zone: string, subDomain: string, type: string): Promise<string | null> {
    const base = `/domain/zone/${encodeURIComponent(zone)}/record`;
    const sub = `subDomain=${encodeURIComponent(subDomain)}`;
    const ids = new Set<number>();
    for (const q of type === 'CNAME' ? [sub] : [`fieldType=${type}&${sub}`, `fieldType=CNAME&${sub}`]) {
      for (const id of await this.request<number[]>('GET', `${base}?${q}`)) ids.add(id);
    }
    for (const id of [...ids].slice(0, 50)) {
      const r = await this.request<{ subDomain: string; fieldType: string }>('GET', `${base}/${id}`);
      if (r.subDomain.toLowerCase() === subDomain && (type === 'CNAME' || r.fieldType === type || r.fieldType === 'CNAME')) return r.fieldType;
    }
    return null;
  }

  async createRecord(zoneId: string, spec: DomainRecordSpec): Promise<DomainRecordResult> {
    const subDomain = relativeName(spec.hostname, zoneId);
    const clash = await this.clashingRecord(zoneId, subDomain, spec.type);
    if (clash) throw new Error(`OVH already has a ${clash} record for ${spec.hostname}; it was left unchanged`);
    const created = await this.request<{ id: number }>('POST', `/domain/zone/${encodeURIComponent(zoneId)}/record`, {
      fieldType: spec.type,
      subDomain,
      target: spec.type === 'CNAME' ? absoluteTarget(spec.content) : spec.content,
      // 0 = the zone's default TTL.
      ttl: spec.ttl && spec.ttl >= 60 ? spec.ttl : 0,
    });
    await this.refresh(zoneId);
    return { recordId: String(created.id), hostname: spec.hostname, type: spec.type };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    try {
      await this.request('DELETE', `/domain/zone/${encodeURIComponent(zoneId)}/record/${encodeURIComponent(recordId)}`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
    await this.refresh(zoneId);
  }
}
