import type { DB } from '@ninedeploy/db';
import type { DomainRecordSpec, DomainRecordType, DomainZone } from '../kernel/types.js';
import { decrypt } from './crypto.js';
import { getSettingString } from './settings.js';

/**
 * DNSimple v2 DNS-record management (zero-dependency: plain fetch + Bearer).
 *
 * Mirrors `lib/cloudflare.ts` line-for-line: every response is unwrapped from
 * the `{ data, pagination }` envelope, every non-2xx is converted into a
 * descriptive `Error`, and 204 No Content short-circuits before JSON parsing.
 * The driver (`DnsimpleProvider`) is the only caller of the record helpers;
 * `listDnsimpleZones` is exported so the registry can also reach it directly
 * for future UI selectors — the same shape `listCloudflareZones` already
 * plays on the Cloudflare side.
 */

const API = 'https://api.dnsimple.com/v2';

interface DnsimpleEnvelope<T> {
  data: T;
  pagination?: {
    current_page?: number;
    per_page?: number;
    total_entries?: number;
    total_pages?: number;
  };
}

/**
 * DNSimple zone object — the upstream returns a richer shape (`account_id`,
 * `reverse`, `secondary`, `active`, …) but the `IDomainProvider` contract
 * only needs `id` and `name`. DNSimple uses the zone name as the URL slug
 * everywhere on the v2 API, so the driver treats the returned `name` as the
 * opaque `zoneId` it threads through every subsequent call.
 */
export interface DnsimpleZonePayload {
  id: number;
  account_id: number;
  name: string;
  reverse: boolean;
  secondary: boolean;
  active: boolean;
}

/**
 * Body of a DNSimple record as it appears in list / create / get responses.
 * Only the fields the `IDomainProvider` driver cares about are typed; the
 * upstream returns more (regions, system_record, created_at, …) which the
 * driver ignores.
 */
export interface DnsimpleRecordPayload {
  id: number;
  zone_id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  priority?: number | null;
}

async function dnsimpleRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // DNSimple returns `{ message: "...", errors: { ... } }` on failure.
    // Surface the message verbatim when present, otherwise fall back to the
    // HTTP status — same convention as the Cloudflare helper.
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; errors?: Record<string, string[]> };
      if (body.message) {
        detail = body.message;
      } else if (body.errors) {
        const first = Object.values(body.errors)[0]?.[0];
        if (first) detail = first;
      }
    } catch {
      // Body wasn't JSON; keep the statusText.
    }
    throw new Error(`DNSimple API error: ${res.status} ${detail}`);
  }
  // DELETE returns 204 No Content — there is nothing to unwrap.
  if (res.status === 204) return undefined as T;
  const body = (await res.json()) as DnsimpleEnvelope<T>;
  return body.data;
}

/**
 * List every zone the configured account has registered on DNSimple. Exposed
 * for the `IDomainProvider` driver and for any future UI selector.
 */
export async function listDnsimpleZones(token: string, accountId: string): Promise<DomainZone[]> {
  const rows = await dnsimpleRequest<DnsimpleZonePayload[]>(`/${accountId}/zones`, token);
  return rows.map((z) => ({ id: z.name, name: z.name }));
}

/**
 * Create a record under `zoneId` (treated as a DNSimple zone name). The
 * `name` field sent to DNSimple is the FQDN minus the zone suffix, per the
 * upstream's documented shape.
 *
 * Exported for the driver; the wider codebase has no other caller today.
 */
export async function createDnsimpleRecord(
  token: string,
  accountId: string,
  zoneId: string,
  spec: DomainRecordSpec,
): Promise<{ id: number; name: string; type: DomainRecordType }> {
  // DNSimple expects the record name "without the domain" (the zone suffix).
  // Strip the trailing `.{zoneId}` to match what the API documentation calls
  // for — apex records come through with an empty name.
  const suffix = `.${zoneId}`;
  const relativeName = spec.hostname === zoneId ? '' : spec.hostname.endsWith(suffix) ? spec.hostname.slice(0, -suffix.length) : spec.hostname;
  const body: Record<string, unknown> = {
    name: relativeName,
    type: spec.type,
    content: spec.content,
    ttl: spec.ttl ?? 3600,
  };
  // DNSimple silently drops the field when the content looks like an IP, so
  // a CNAME pointing at another hostname never needs `priority` — the helper
  // simply omits the key for non-priority-bearing types.
  const created = await dnsimpleRequest<DnsimpleRecordPayload>(
    `/${accountId}/zones/${zoneId}/records`,
    token,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return { id: created.id, name: spec.hostname, type: spec.type };
}

/**
 * Delete a record by numeric `recordId`. Best-effort: a missing record is
 * the desired end state, so a 404 must NOT propagate to the caller.
 */
export async function deleteDnsimpleRecord(
  token: string,
  accountId: string,
  zoneId: string,
  recordId: string | number,
): Promise<void> {
  await dnsimpleRequest<void>(`/${accountId}/zones/${zoneId}/records/${recordId}`, token, {
    method: 'DELETE',
  }).catch(() => undefined);
}

export interface DnsimpleConfig {
  enabled: boolean;
  token: string | null;
  accountId: string | null;
}

/**
 * Read the global DNS-provider settings the way `getDnsRecordsConfig`
 * does for Cloudflare. Returns the decrypted token and the account id
 * (DNSimple requires BOTH — its path slugs are
 * `/v2/{accountId}/zones/…`), or `enabled: false` when the operator
 * has not opted in.
 */
export async function getDnsimpleConfig(db: DB): Promise<DnsimpleConfig> {
  const [provider, tokenEnc, accountId] = await Promise.all([
    getSettingString(db, 'dns_records_provider', null),
    getSettingString(db, 'dns_records_token_encrypted', null),
    getSettingString(db, 'dns_records_account_id', null),
  ]);
  return {
    enabled: provider === 'dnsimple' && !!tokenEnc && !!accountId,
    token: tokenEnc ? decrypt(tokenEnc) : null,
    accountId,
  };
}
