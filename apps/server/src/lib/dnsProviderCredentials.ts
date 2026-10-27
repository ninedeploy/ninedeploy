import type { DB } from '@ninedeploy/db';
import { z } from 'zod';
import type { DomainZone } from '../kernel/types.js';
import { decrypt, encrypt } from './crypto.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * G3.5: credentials for the DNS record providers added after Cloudflare,
 * DNSimple and Namecheap — Route53, OVH, Porkbun and Hetzner DNS.
 *
 * One provider is active at a time (`dns_records_provider`, the setting the
 * domain-presets plugin already reads), so its credentials live in one
 * encrypted JSON setting. Saving another provider replaces them. The plugin
 * then creates a record when a domain goes live and deletes it with the
 * domain, exactly as it does for DNSimple and Namecheap.
 */

export const CREDENTIALS_KEY = 'dns_records_credentials_encrypted';

export const DNS_CREDENTIAL_SCHEMAS = {
  route53: z.object({
    accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/, 'accessKeyId must look like AKIA…'),
    secretAccessKey: z.string().min(16).max(256),
  }),
  ovh: z.object({
    endpoint: z.enum(['ovh-eu', 'ovh-ca', 'ovh-us']),
    applicationKey: z.string().min(8).max(128),
    applicationSecret: z.string().min(8).max(256),
    consumerKey: z.string().min(8).max(256),
  }),
  porkbun: z.object({
    apiKey: z.string().regex(/^pk1_[A-Za-z0-9]+$/, 'apiKey starts with pk1_'),
    secretApiKey: z.string().regex(/^sk1_[A-Za-z0-9]+$/, 'secretApiKey starts with sk1_'),
  }),
  hetzner: z.object({
    token: z.string().min(16).max(256),
  }),
} as const;

export type DnsCredentialProvider = keyof typeof DNS_CREDENTIAL_SCHEMAS;
export type DnsCredentials<P extends DnsCredentialProvider> = z.infer<(typeof DNS_CREDENTIAL_SCHEMAS)[P]>;

export const DNS_CREDENTIAL_PROVIDERS = Object.keys(DNS_CREDENTIAL_SCHEMAS) as DnsCredentialProvider[];

/** Fields that name an account or region rather than unlock it: safe to show back. */
const PUBLIC_FIELDS: Record<DnsCredentialProvider, readonly string[]> = {
  route53: ['accessKeyId'],
  ovh: ['endpoint', 'applicationKey'],
  porkbun: [],
  hetzner: [],
};

interface Stored {
  provider: DnsCredentialProvider;
  credentials: Record<string, string>;
}

async function readStored(db: DB): Promise<Stored | null> {
  const raw = await getSettingString(db, CREDENTIALS_KEY, null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decrypt(raw)) as Stored;
    return DNS_CREDENTIAL_PROVIDERS.includes(parsed.provider) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The credentials of `provider`, or null when that provider is not the
 * active one or nothing (valid) is stored. A driver whose provider was
 * switched away from fails "not configured" instead of using stale keys.
 */
export async function getDnsCredentials<P extends DnsCredentialProvider>(db: DB, provider: P): Promise<DnsCredentials<P> | null> {
  const active = await getSettingString(db, 'dns_records_provider', null);
  if (active !== provider) return null;
  const stored = await readStored(db);
  if (!stored || stored.provider !== provider) return null;
  const parsed = DNS_CREDENTIAL_SCHEMAS[provider].safeParse(stored.credentials);
  return parsed.success ? (parsed.data as DnsCredentials<P>) : null;
}

/** Store `provider`'s credentials and make it the active DNS record provider. */
export async function setDnsCredentials(db: DB, provider: DnsCredentialProvider, credentials: Record<string, string>): Promise<void> {
  const parsed = DNS_CREDENTIAL_SCHEMAS[provider].parse(credentials) as Record<string, string>;
  await setSettingString(db, CREDENTIALS_KEY, encrypt(JSON.stringify({ provider, credentials: parsed } satisfies Stored)));
  await setSettingString(db, 'dns_records_provider', provider);
}

/** Forget the stored credentials; deactivates the provider when it is one of these. */
export async function clearDnsCredentials(db: DB): Promise<void> {
  const active = await getSettingString(db, 'dns_records_provider', null);
  if (active && (DNS_CREDENTIAL_PROVIDERS as string[]).includes(active)) await setSettingString(db, 'dns_records_provider', '');
  await setSettingString(db, CREDENTIALS_KEY, '');
}

/** What the settings page shows: the active provider and its non-secret fields. */
export async function describeDnsCredentials(db: DB): Promise<{
  provider: string | null;
  configured: DnsCredentialProvider | null;
  fields: Record<string, string>;
}> {
  const active = (await getSettingString(db, 'dns_records_provider', null)) || null;
  const stored = await readStored(db);
  const fields: Record<string, string> = {};
  if (stored) for (const f of PUBLIC_FIELDS[stored.provider]) if (stored.credentials[f]) fields[f] = stored.credentials[f]!;
  return { provider: active, configured: stored?.provider ?? null, fields };
}

// ── helpers shared by the four drivers ─────────────────────────────────────

/** Longest-suffix zone for a hostname (`dev.example.com` beats `example.com`). */
export function zoneForHost(zones: DomainZone[], hostname: string): DomainZone | null {
  const host = hostname.toLowerCase();
  const exact = zones.find((z) => z.name.toLowerCase() === host);
  if (exact) return exact;
  return (
    zones
      .filter((z) => host.endsWith(`.${z.name.toLowerCase()}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

/** The record name relative to its zone: `''` for the apex. */
export function relativeName(hostname: string, zone: string): string {
  const host = hostname.toLowerCase();
  const z = zone.toLowerCase();
  if (host === z) return '';
  return host.endsWith(`.${z}`) ? host.slice(0, -(z.length + 1)) : host;
}

/** A CNAME target as an absolute name (trailing dot), the form zone-file APIs expect. */
export const absoluteTarget = (content: string): string => (content.endsWith('.') ? content : `${content}.`);

/** TXT values travel quoted in zone-file APIs. */
export const quotedTxt = (content: string): string => (content.startsWith('"') ? content : `"${content.replace(/"/g, '\\"')}"`);

/**
 * The record's TTL in seconds. Callers pass `1` for "automatic" (Cloudflare's
 * convention); providers with a floor get their default instead.
 */
export const ttlOrDefault = (ttl: number | undefined, floor: number, fallback: number): number =>
  ttl && ttl >= floor ? ttl : fallback;

/** A provider's explanation of a refusal, read from its JSON or text body. */
export async function errorText(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    try {
      const body = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } };
      const msg = body.message ?? body.error?.message;
      if (typeof msg === 'string') return msg.slice(0, 300);
    } catch {
      /* not JSON */
    }
    return text.slice(0, 300) || res.statusText;
  } catch {
    return res.statusText;
  }
}
