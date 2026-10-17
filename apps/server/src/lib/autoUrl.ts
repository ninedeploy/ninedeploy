import { eq } from 'drizzle-orm';
import { servers, type DB } from '@ninedeploy/db';
import { config } from '../config.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * Automatic service URLs (0.16.1).
 *
 * Before this, a service only got a URL of its own when the operator had set
 * NINEDEPLOY_WILDCARD_DOMAIN in the environment — the wildcard field in
 * Settings only fed the certificate resolver, and a fresh install deployed its
 * first app with no URL at all. Three sources now, in order:
 *
 *  1. `NINEDEPLOY_WILDCARD_DOMAIN` (env) — unchanged legacy behaviour, and it
 *     wins: an env-configured install keeps exactly the hosts it had.
 *  2. Settings → Automatic URLs, mode `domain`: `<slug>.<domain>`.
 *  3. Settings → Automatic URLs, mode `sslip`: `<slug>.<ip>.sslip.io`, a
 *     free test URL with no DNS to set up (sslip.io answers any
 *     `*.<a.b.c.d>.sslip.io` with a.b.c.d). Plain HTTP: a test URL is not
 *     worth spending the shared sslip.io Let's Encrypt rate limit on.
 *
 * Upgrade safety: with no `auto_url_mode` row the mode is `off`, so an
 * upgraded panel behaves exactly as before. Only a FRESH install (the first
 * account being created) seeds `sslip`, and only when the installer recorded
 * a public IPv4 for the panel.
 */

export type AutoUrlMode = 'off' | 'domain' | 'sslip';

export interface AutoUrlConfig {
  mode: AutoUrlMode;
  /** mode=domain: the base domain (`apps.example.com`). */
  domain: string | null;
  /** mode=sslip: the panel host's address the sslip.io names resolve to. */
  ip: string | null;
  /** `env` when NINEDEPLOY_WILDCARD_DOMAIN decides and the setting is ignored. */
  source: 'env' | 'setting';
}

export const AUTO_URL_MODE_KEY = 'auto_url_mode';
export const AUTO_URL_DOMAIN_KEY = 'auto_url_domain';
export const AUTO_URL_IP_KEY = 'auto_url_ip';

export const SSLIP_ZONE = 'sslip.io';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(value: string): boolean {
  return IPV4_RE.test(value);
}

/** True for an IPv4 that is reachable from the internet (not RFC1918, CGNAT, loopback, link-local…). */
export function isPublicIpv4(ip: string): boolean {
  if (!isIpv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function normalizeDomain(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
}

function envWildcard(): string {
  return normalizeDomain(config.wildcardDomain);
}

/**
 * Last config read from the database. `isOwnZone` (lib/domainVerification.ts)
 * is synchronous and runs inside every domain claim, so it reads this copy;
 * every write through `setAutoUrlConfig` and every `getAutoUrlConfig` keeps it
 * current, and the settings routes load it once at boot.
 */
let cached: AutoUrlConfig = { mode: 'off', domain: null, ip: null, source: 'setting' };

export function cachedAutoUrlConfig(): AutoUrlConfig {
  const env = envWildcard();
  if (env) return { mode: 'domain', domain: env, ip: null, source: 'env' };
  return cached;
}

export async function getAutoUrlConfig(db: DB): Promise<AutoUrlConfig> {
  const env = envWildcard();
  const rawMode = await getSettingString(db, AUTO_URL_MODE_KEY, null);
  const mode: AutoUrlMode = rawMode === 'domain' || rawMode === 'sslip' ? rawMode : 'off';
  const domain = normalizeDomain(await getSettingString(db, AUTO_URL_DOMAIN_KEY, null)) || null;
  const ipRaw = ((await getSettingString(db, AUTO_URL_IP_KEY, null)) ?? '').trim();
  const ip = isIpv4(ipRaw) ? ipRaw : null;
  // A half-configured mode (domain mode without a domain) is off.
  const effective: AutoUrlMode = mode === 'domain' && !domain ? 'off' : mode === 'sslip' && !ip ? 'off' : mode;
  cached = { mode: effective, domain, ip, source: 'setting' };
  if (env) return { mode: 'domain', domain: env, ip: null, source: 'env' };
  return cached;
}

export async function setAutoUrlConfig(
  db: DB,
  input: { mode: AutoUrlMode; domain?: string | null; ip?: string | null },
): Promise<AutoUrlConfig> {
  await setSettingString(db, AUTO_URL_MODE_KEY, input.mode);
  if (input.domain !== undefined) await setSettingString(db, AUTO_URL_DOMAIN_KEY, normalizeDomain(input.domain));
  if (input.ip !== undefined) await setSettingString(db, AUTO_URL_IP_KEY, (input.ip ?? '').trim());
  return getAutoUrlConfig(db);
}

/** The sslip.io zone for an address: `1.2.3.4` → `1.2.3.4.sslip.io`. */
export function sslipZone(ip: string): string {
  return `${ip}.${SSLIP_ZONE}`;
}

/**
 * The automatic hostname for a service, or null when none applies.
 * A node-pinned service in sslip mode resolves to the NODE (its own proxy
 * serves it); a node registered by hostname has no sslip.io name.
 */
export async function autoHostFor(
  db: DB,
  service: { slug: string; serverId?: number | null },
): Promise<{ hostname: string; ssl: 'acme' | false } | null> {
  const cfg = await getAutoUrlConfig(db);
  // The env wildcard builds the host byte-for-byte as before 0.16.1 (no case
  // or `*.` normalisation): an existing service's row must match exactly, or
  // its next deploy would add a second, differently-spelt domain.
  if (cfg.source === 'env') return { hostname: `${service.slug}.${config.wildcardDomain}`, ssl: 'acme' };
  if (cfg.mode === 'domain' && cfg.domain) return { hostname: `${service.slug}.${cfg.domain}`, ssl: 'acme' };
  if (cfg.mode !== 'sslip' || !cfg.ip) return null;
  let ip = cfg.ip;
  if (service.serverId != null) {
    const node = await db.query.servers.findFirst({ where: eq(servers.id, service.serverId) });
    const host = (node?.host ?? '').trim();
    if (!isIpv4(host)) return null;
    ip = host;
  }
  return { hostname: `${service.slug}.${sslipZone(ip)}`, ssl: false };
}

/** Synchronous best guess for API payloads (`autoUrl` on a service); no node lookup. */
export function autoUrlPreview(slug: string, serverId: number | null = null): string | null {
  const cfg = cachedAutoUrlConfig();
  if (cfg.source === 'env') return `${slug}.${config.wildcardDomain}`;
  if (cfg.mode === 'domain' && cfg.domain) return `${slug}.${cfg.domain}`;
  if (cfg.mode === 'sslip' && cfg.ip && serverId == null) return `${slug}.${sslipZone(cfg.ip)}`;
  return null;
}

/**
 * The zones automatic URLs are minted in, for the own-zone claim rules. In
 * sslip mode that is all of `sslip.io`: a node's names live under its own
 * address, and no tenant can prove a TXT record there anyway.
 */
export function autoUrlZones(): string[] {
  const cfg = cachedAutoUrlConfig();
  const zones: string[] = [];
  if (cfg.mode === 'domain' && cfg.domain) zones.push(cfg.domain);
  if (cfg.mode === 'sslip') zones.push(SSLIP_ZONE);
  return zones;
}

/**
 * The part of `hostname` in front of its automatic-URL zone — `api` for
 * `api.apps.example.com` or `api.1.2.3.4.sslip.io` (it may itself contain
 * dots) — or null when the host is in no automatic-URL zone. A dot-free label
 * is some service's automatic name, reserved for that service alone.
 */
export function autoUrlRelativeLabel(hostname: string): string | null {
  const host = normalizeDomain(hostname);
  const cfg = cachedAutoUrlConfig();
  if (cfg.mode === 'domain' && cfg.domain && host.endsWith(`.${cfg.domain}`)) {
    return host.slice(0, -(cfg.domain.length + 1));
  }
  if (cfg.mode === 'sslip') {
    const m = /^(.+)\.(\d{1,3}(?:\.\d{1,3}){3})\.sslip\.io$/.exec(host);
    return m?.[1] ?? null;
  }
  return null;
}

/**
 * Fresh installs only: the first account is being created and nothing has
 * been configured yet. When the installer recorded a public IPv4 for the panel
 * (NINEDEPLOY_PUBLIC_URL = http://<ip>:3000), turn on sslip.io URLs so the
 * very first deploy is reachable without any DNS work. Best effort.
 */
export async function seedFreshInstallAutoUrl(db: DB): Promise<void> {
  try {
    if (envWildcard()) return;
    if ((await getSettingString(db, AUTO_URL_MODE_KEY, null)) !== null) return;
    if (await db.query.services.findFirst({ columns: { id: true } })) return;
    let host = '';
    try {
      host = new URL(config.publicUrl).hostname;
    } catch {
      return;
    }
    if (!isPublicIpv4(host)) return;
    await setAutoUrlConfig(db, { mode: 'sslip', ip: host });
  } catch {
    // Never let a convenience default break account creation.
  }
}
