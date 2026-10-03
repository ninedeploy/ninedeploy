import { cfRequest, listCloudflareZones } from '../../lib/cloudflare.js';
import type {
  DomainRecordResult,
  DomainRecordSpec,
  DomainZone,
  IDomainProvider,
} from '../types.js';

/**
 * Async token supplier. Returning `null` means "credentials are not
 * configured right now" — every method on the driver will fail with a
 * descriptive `Error` instead of crashing the kernel. This matches the
 * plugin convention: misconfiguration is data, not an exception.
 */
export type CloudflareTokenProvider = () => Promise<string | null>;

/**
 * `IDomainProvider` driver for Cloudflare's API.
 *
 * Sprint 2, Gap G-07 (PR-A). Cloudflare is the only DNS provider wired
 * today, so this driver is the de-facto reference implementation of the
 * interface — `DnsimpleProvider` and `NamecheapProvider` (PRs G-07-B and
 * G-07-C) will live in sibling files and share no code beyond the
 * `IDomainProvider` shape.
 *
 * Construction takes a `CloudflareTokenProvider` instead of a raw token
 * so the kernel boot path can defer credential lookup until the first
 * real call. That keeps the driver stateless: re-reading the token on
 * every call is fine, and a config-center change takes effect without
 * re-registering the driver.
 */
export class CloudflareZoneProvider implements IDomainProvider {
  readonly name = 'cloudflare-zone';

  constructor(private readonly tokenProvider: CloudflareTokenProvider) {}

  /**
   * Resolve the current token or throw. Centralised so every public method
   * surfaces the same error wording — important because the audit bus and
   * CLI both rely on the message to render a useful next-step hint.
   */
  private async requireToken(): Promise<string> {
    const token = await this.tokenProvider();
    if (!token) {
      throw new Error(
        'Cloudflare token is not configured. Set dns_records_provider=cloudflare and dns_records_token_encrypted in settings.',
      );
    }
    return token;
  }

  async listZones(): Promise<DomainZone[]> {
    const token = await this.requireToken();
    return listCloudflareZones(token);
  }

  async findZoneForHost(hostname: string): Promise<DomainZone | null> {
    const token = await this.requireToken();
    const zones = await listCloudflareZones(token);
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
    const token = await this.requireToken();
    const record = await cfRequest<{ id: string }>(`/zones/${zoneId}/dns_records`, token, {
      method: 'POST',
      body: JSON.stringify({
        type: spec.type,
        name: spec.hostname,
        content: spec.content,
        ttl: spec.ttl ?? 1,
        proxied: spec.proxied ?? false,
      }),
    });
    return { recordId: record.id, hostname: spec.hostname, type: spec.type };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    const token = await this.requireToken();
    // Best-effort: a missing record is the desired end state.
    await cfRequest(`/zones/${zoneId}/dns_records/${recordId}`, token, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
}
