import {
  createDnsimpleRecord,
  deleteDnsimpleRecord,
  listDnsimpleZones,
} from '../../lib/dnsimple.js';
import type {
  DomainRecordResult,
  DomainRecordSpec,
  DomainZone,
  IDomainProvider,
} from '../types.js';

/**
 * Async supplier for the credentials the DNSimple driver needs. Returning
 * `null` means "credentials are not configured right now" — every method on
 * the driver then fails with a descriptive `Error` instead of crashing the
 * kernel. This matches the convention the Cloudflare driver uses.
 */
export type DnsimpleCredentialsProvider = () => Promise<{ token: string; accountId: string } | null>;

/**
 * `IDomainProvider` driver for DNSimple's v2 API.
 *
 * Sprint 2, Gap G-07 (PR-B). DNSimple is a REST + Bearer + JSON service, so
 * the driver is structurally a thin re-shaping of the upstream endpoints
 * over the kernel's vendor-neutral `IDomainProvider` contract:
 *
 *   - `listZones` calls `GET /v2/{accountId}/zones`.
 *   - `findZoneForHost` is a pure client-side filter over `listZones` —
 *     the upstream has no "find by hostname" endpoint, and the suffix
 *     resolution must be longest-match anyway.
 *   - `createRecord` maps our FQDN-based `DomainRecordSpec` to the
 *     upstream's "name without the zone" form.
 *   - `deleteRecord` is best-effort (a missing record is the desired
 *     terminal state) and accepts both string and numeric record ids so
 *     the caller does not have to coerce.
 *
 * DNSimple uses the zone *name* (e.g. `example.com`) as the path slug for
 * every record endpoint, not a numeric id. The driver threads the zone
 * name through `DomainZone.id` so the rest of the kernel can stay
 * vendor-agnostic — callers never see a `zoneName` vs `zoneId` distinction.
 */
export class DnsimpleProvider implements IDomainProvider {
  readonly name = 'dnsimple';

  constructor(private readonly credentials: DnsimpleCredentialsProvider) {}

  /**
   * Resolve the current credentials or throw. Centralised so every public
   * method surfaces the same error wording — important because the audit
   * bus and CLI both rely on the message to render a useful next-step hint.
   */
  private async requireCredentials(): Promise<{ token: string; accountId: string }> {
    const creds = await this.credentials();
    if (!creds) {
      throw new Error(
        'DNSimple credentials are not configured. Set dns_records_provider=dnsimple, dns_records_token_encrypted, and dns_records_account_id in settings.',
      );
    }
    return creds;
  }

  async listZones(): Promise<DomainZone[]> {
    const { token, accountId } = await this.requireCredentials();
    return listDnsimpleZones(token, accountId);
  }

  async findZoneForHost(hostname: string): Promise<DomainZone | null> {
    const zones = await this.listZones();
    // Exact match wins outright; otherwise pick the longest suffix so
    // `dev.example.com` always outranks `example.com` for `app.dev.example.com`.
    const exact = zones.find((z) => hostname === z.name);
    if (exact) return exact;
    const candidates = zones
      .filter((z) => hostname.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length);
    return candidates[0] ?? null;
  }

  async createRecord(zoneId: string, spec: DomainRecordSpec): Promise<DomainRecordResult> {
    const { token, accountId } = await this.requireCredentials();
    const created = await createDnsimpleRecord(token, accountId, zoneId, spec);
    return { recordId: String(created.id), hostname: spec.hostname, type: spec.type };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    const { token, accountId } = await this.requireCredentials();
    await deleteDnsimpleRecord(token, accountId, zoneId, recordId);
  }
}
