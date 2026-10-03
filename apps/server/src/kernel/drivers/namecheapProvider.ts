import {
  getNamecheapConfig,
  readNamecheapHostList,
  listNamecheapDomains,
  setNamecheapHosts,
  type NamecheapCredentials,
} from '../../lib/namecheap.js';
import type {
  DomainRecordResult,
  DomainRecordSpec,
  DomainZone,
  IDomainProvider,
} from '../types.js';

/**
 * Async supplier for the credentials the Namecheap driver needs.
 * Returning `null` means "credentials are not configured right now" —
 * every method on the driver then fails with a descriptive `Error`
 * instead of crashing the kernel. This matches the convention the
 * Cloudflare and DNSimple drivers use.
 */
export type NamecheapCredentialsProvider = () => Promise<NamecheapCredentials | null>;

/**
 * `IDomainProvider` driver for Namecheap's DNS API.
 *
 * Sprint 5, Gap G-07 (PR-A). The hard part is that Namecheap has no
 * per-record endpoint — `setHosts` is a wholesale PUT. The driver
 * composes a `getHosts` → merge → `setHosts` → re-`getHosts` dance so
 * the `IDomainProvider` contract stays clean (one `createRecord`
 * call, one returned `recordId`, one `deleteRecord` call by id).
 *
 * The two extra round-trips per mutation are accepted because:
 *   1. Namecheap is a low-frequency control-plane API, not the
 *      data-plane hot path. The first domain add is what operators
 *      feel, not a per-request loop.
 *   2. The same flow is the documented way to mutate the API. Even
 *      Namecheap's own UI does it server-side.
 *   3. Keeping the contract clean means future drivers (Route53,
 *      Google Cloud DNS) do not have to invent a Namecheap-specific
 *      "merge" mode.
 */
export class NamecheapProvider implements IDomainProvider {
  readonly name = 'namecheap';

  constructor(private readonly credentials: NamecheapCredentialsProvider) {}

  /**
   * Resolve the current credentials or throw. Centralised so every
   * public method surfaces the same error wording — important because
   * the audit bus and CLI both rely on the message to render a useful
   * next-step hint.
   */
  private async requireCredentials(): Promise<NamecheapCredentials> {
    const creds = await this.credentials();
    if (!creds) {
      throw new Error(
        'Namecheap credentials are not configured. Set namecheap_api_user, namecheap_api_key_encrypted, and namecheap_client_ip in settings.',
      );
    }
    return creds;
  }

  async listZones(): Promise<DomainZone[]> {
    const creds = await this.requireCredentials();
    return listNamecheapDomains(creds);
  }

  async findZoneForHost(hostname: string): Promise<DomainZone | null> {
    const zones = await this.listZones();
    // Exact match wins outright; otherwise pick the longest suffix so
    // `dev.example.com` always outranks `example.com` for
    // `app.dev.example.com`. This is the same longest-match the
    // sibling drivers (Cloudflare, DNSimple) use.
    const exact = zones.find((z) => hostname === z.name);
    if (exact) return exact;
    const candidates = zones
      .filter((z) => hostname.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length);
    return candidates[0] ?? null;
  }

  async createRecord(zoneId: string, spec: DomainRecordSpec): Promise<DomainRecordResult> {
    const creds = await this.requireCredentials();
    // r244: Namecheap host names are RELATIVE to the domain (`www`, `@`).
    // Callers such as the domain-presets plugin pass the full hostname, which
    // was written verbatim and produced `app.example.com.example.com`.
    const name = relativeHostName(spec.hostname, zoneId);
    // 1. Read the current host list (and email type) so we can append to it.
    const { hosts: existing, emailType } = await readNamecheapHostList(creds, zoneId);
    // 2. Drop any existing row that matches the new one on (name, type).
    //    A re-add of the same record is the desired terminal state —
    //    Namecheap will reject the request if the same logical record
    //    appears twice, so we de-dup by content first.
    const filtered = existing.filter((h) => !(h.name === name && h.type === spec.type));
    filtered.push({
      name,
      type: spec.type,
      address: spec.content,
      ttl: spec.ttl ? String(spec.ttl) : '1800',
    });
    // 3. Push the merged list. Namecheap's `setHosts` is the only
    //    mutation endpoint; the new entry's `HostId` is assigned by
    //    their backend. The email type rides along so MX rows survive.
    await setNamecheapHosts(creds, zoneId, filtered, { emailType });
    // 4. Re-read so we can hand back the new id. The contract needs
    //    a `recordId`; without a second `getHosts` the caller has no
    //    way to address the record later for `deleteRecord`.
    const { hosts: reread } = await readNamecheapHostList(creds, zoneId);
    const created = reread.find((h) => h.name === name && h.type === spec.type);
    if (!created || !created.hostId) {
      throw new Error(`Namecheap setHosts did not return a HostId for ${spec.hostname}`);
    }
    return { recordId: created.hostId, hostname: spec.hostname, type: spec.type };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    const creds = await this.requireCredentials();
    const { hosts: existing, emailType } = await readNamecheapHostList(creds, zoneId);
    const filtered = existing.filter((h) => h.hostId !== recordId);
    // If nothing matched, the desired terminal state is already
    // reached; do not push a redundant `setHosts` round-trip.
    if (filtered.length === existing.length) return;
    await setNamecheapHosts(creds, zoneId, filtered, { emailType });
  }
}

/** `app.example.com` in zone `example.com` → `app`; the apex → `@`. A name
 *  that is already relative is returned unchanged. */
export function relativeHostName(hostname: string, zone: string): string {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  const z = zone.toLowerCase();
  if (host === z) return '@';
  if (host.endsWith(`.${z}`)) return host.slice(0, -(z.length + 1));
  return hostname;
}

/** Helper used by the kernel plugin wiring: a credentials provider
 *  that reads the operator-saved settings out of the DB. Mirrors the
 *  shape the Cloudflare and DNSimple drivers expose so the kernel
 *  plugin stays symmetric. */
export function dbNamecheapCredentials(db: import('@ninedeploy/db').DB): NamecheapCredentialsProvider {
  return async () => getNamecheapConfig(db);
}
