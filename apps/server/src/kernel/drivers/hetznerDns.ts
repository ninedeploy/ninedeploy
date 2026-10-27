import { absoluteTarget, errorText, quotedTxt, relativeName, ttlOrDefault, zoneForHost } from '../../lib/dnsProviderCredentials.js';
import { guardedFetch } from '../../lib/egressGuard.js';
import type { DomainRecordResult, DomainRecordSpec, DomainZone, IDomainProvider } from '../types.js';

export type HetznerCredentialsProvider = () => Promise<{ token: string } | null>;

const API = 'https://api.hetzner.cloud/v1';

/**
 * `IDomainProvider` for Hetzner DNS through the Hetzner Cloud API (G3.5). The
 * old dns.hetzner.com API was retired when DNS moved into the Cloud Console;
 * a Cloud project API token with read & write access is all it needs.
 *
 * Records are RRSets addressed by name and type, so the record id is
 * `<name>/<type>` (`@` for the apex). An RRSet that already exists is refused
 * rather than extended: the panel never edits records it did not create.
 */
export class HetznerDnsProvider implements IDomainProvider {
  readonly name = 'hetzner';

  constructor(private readonly credentials: HetznerCredentialsProvider) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const creds = await this.credentials();
    if (!creds) throw new Error('Hetzner DNS is not configured. Save a Hetzner Cloud API token under Settings → Integrations → DNS records.');
    const res = await guardedFetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = new Error(`Hetzner DNS API error: ${res.status} ${await errorText(res)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return { status: res.status, data: res.status === 204 ? (undefined as T) : ((await res.json()) as T) };
  }

  async listZones(): Promise<DomainZone[]> {
    const zones: DomainZone[] = [];
    for (let page = 1; page; ) {
      const { data } = await this.request<{
        zones: Array<{ id: number | string; name: string }>;
        meta?: { pagination?: { next_page?: number | null } };
      }>('GET', `/zones?per_page=100&page=${page}`);
      zones.push(...data.zones.map((z) => ({ id: String(z.id), name: z.name })));
      page = data.meta?.pagination?.next_page ?? 0;
    }
    return zones;
  }

  async findZoneForHost(hostname: string): Promise<DomainZone | null> {
    return zoneForHost(await this.listZones(), hostname);
  }

  private async zoneName(zoneId: string): Promise<string> {
    const { data } = await this.request<{ zone: { name: string } }>('GET', `/zones/${encodeURIComponent(zoneId)}`);
    return data.zone.name;
  }

  async createRecord(zoneId: string, spec: DomainRecordSpec): Promise<DomainRecordResult> {
    const name = relativeName(spec.hostname, await this.zoneName(zoneId)) || '@';
    const value = spec.type === 'CNAME' ? absoluteTarget(spec.content) : spec.type === 'TXT' ? quotedTxt(spec.content) : spec.content;
    try {
      await this.request('POST', `/zones/${encodeURIComponent(zoneId)}/rrsets`, {
        name,
        type: spec.type,
        ttl: ttlOrDefault(spec.ttl, 60, 300),
        records: [{ value }],
      });
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        throw new Error(`Hetzner DNS already has a ${spec.type} record for ${spec.hostname}; it was left unchanged`);
      }
      throw err;
    }
    return { recordId: `${name}/${spec.type}`, hostname: spec.hostname, type: spec.type };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    const [name, type] = recordId.split('/');
    if (!name || !type) return;
    try {
      await this.request('DELETE', `/zones/${encodeURIComponent(zoneId)}/rrsets/${encodeURIComponent(name)}/${encodeURIComponent(type)}`);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
}
