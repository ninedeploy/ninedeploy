import { errorText, relativeName, ttlOrDefault, zoneForHost } from '../../lib/dnsProviderCredentials.js';
import { guardedFetch } from '../../lib/egressGuard.js';
import type { DomainRecordResult, DomainRecordSpec, DomainZone, IDomainProvider } from '../types.js';

export type PorkbunCredentialsProvider = () => Promise<{ apiKey: string; secretApiKey: string } | null>;

const API = 'https://api.porkbun.com/api/json/v3';
/** `domain/listAll` returns at most this many domains per call. */
const PAGE = 1000;

/**
 * `IDomainProvider` for Porkbun's JSON API v3 (G3.5). Every call is a POST
 * carrying the key pair in its body. API access has to be switched on per
 * domain in the Porkbun dashboard; a domain without it answers with an error
 * the driver passes on.
 */
export class PorkbunProvider implements IDomainProvider {
  readonly name = 'porkbun';

  constructor(private readonly credentials: PorkbunCredentialsProvider) {}

  private async call<T>(path: string, extra: Record<string, unknown> = {}): Promise<T> {
    const creds = await this.credentials();
    if (!creds) throw new Error('Porkbun is not configured. Save an API key pair under Settings → Integrations → DNS records.');
    const res = await guardedFetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: creds.apiKey, secretapikey: creds.secretApiKey, ...extra }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Porkbun API error: ${res.status} ${await errorText(res)}`);
    const body = (await res.json()) as T & { status?: string; message?: string };
    if (body.status !== 'SUCCESS') throw new Error(`Porkbun API error: ${body.message ?? 'request refused'}`);
    return body;
  }

  async listZones(): Promise<DomainZone[]> {
    const zones: DomainZone[] = [];
    for (let start = 0; ; start += PAGE) {
      const { domains } = await this.call<{ domains?: Array<{ domain: string }> }>('/domain/listAll', { start: String(start) });
      zones.push(...(domains ?? []).map((d) => ({ id: d.domain, name: d.domain })));
      if (!domains || domains.length < PAGE) return zones;
    }
  }

  async findZoneForHost(hostname: string): Promise<DomainZone | null> {
    return zoneForHost(await this.listZones(), hostname);
  }

  async createRecord(zoneId: string, spec: DomainRecordSpec): Promise<DomainRecordResult> {
    // Porkbun adds a record next to existing ones (an A record would join the
    // round-robin), so refuse when the name already has one of this type, or
    // a CNAME is involved on either side — the panel never edits records it
    // did not create.
    const { records } = await this.call<{ records?: Array<{ name: string; type: string }> }>(`/dns/retrieve/${encodeURIComponent(zoneId)}`);
    const host = spec.hostname.toLowerCase();
    const clash = (records ?? []).find(
      (r) => r.name.toLowerCase().replace(/\.$/, '') === host && (r.type === spec.type || r.type === 'CNAME' || spec.type === 'CNAME'),
    );
    if (clash) throw new Error(`Porkbun already has a ${clash.type} record for ${spec.hostname}; it was left unchanged`);
    const { id } = await this.call<{ id: number | string }>(`/dns/create/${encodeURIComponent(zoneId)}`, {
      name: relativeName(spec.hostname, zoneId),
      type: spec.type,
      content: spec.content,
      // Porkbun's floor is 600 seconds.
      ttl: String(ttlOrDefault(spec.ttl, 600, 600)),
    });
    return { recordId: String(id), hostname: spec.hostname, type: spec.type };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    try {
      await this.call(`/dns/delete/${encodeURIComponent(zoneId)}/${encodeURIComponent(recordId)}`);
    } catch (err) {
      // A record that is already gone is the state we want.
      if (!/invalid record id|not found|does not exist/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
}
