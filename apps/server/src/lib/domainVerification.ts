import { resolveTxt } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * H-2, second layer: prove control of the DNS zone before a hostname routes.
 *
 * The create-time check (`assertHostnameClaimable`) stops one tenant taking a
 * hostname another tenant has already registered here. It cannot stop the
 * first claim: whoever asks first gets `app.victim.com`, and because Traefik
 * picks routers by rule specificity, that row starts serving the moment the
 * victim's DNS points at this host — or immediately, for anyone able to send
 * the Host header themselves. Requests, cookies and Authorization headers for
 * a domain the claimant does not own end up in their container.
 *
 * So a hostname from outside this instance's own zone now lands `pending` and
 * is NOT written into the Traefik config until a TXT record proves the
 * claimant can edit that zone:
 *
 *     _ninedeploy-challenge.app.example.com.  IN  TXT  "nd-verify-…"
 *
 * Two deliberate exemptions:
 *
 *   • Hostnames inside the instance's own wildcard/panel zone. The operator
 *     already controls that zone by definition, and auto-generated service
 *     URLs and PR-preview domains live there — asking them to prove ownership
 *     of the operator's own domain would be theatre.
 *   • Admins. "Admin" here is the operator of the whole instance; they can
 *     change the panel domain, the DNS provider credentials and the Traefik
 *     config directly. Making them dance through a challenge protects nobody.
 */

export const CHALLENGE_PREFIX = '_ninedeploy-challenge';

/** The TXT record name a claimant must publish for `hostname`. */
export function challengeRecordName(hostname: string): string {
  // A wildcard claim is proved on its base zone: *.example.com → example.com.
  const base = hostname.startsWith('*.') ? hostname.slice(2) : hostname;
  return `${CHALLENGE_PREFIX}.${base}`;
}

/** A fresh challenge value. Opaque and unguessable so it cannot be pre-published. */
export function newChallengeToken(): string {
  return `nd-verify-${randomBytes(16).toString('hex')}`;
}

/** The instance's own zone(s) — hostnames here need no proof. */
function ownZones(): string[] {
  return [config.wildcardDomain, (config.publicUrl ? safeHost(config.publicUrl) : '')]
    .map((z) => (z ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, ''))
    .filter(Boolean);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** True when `hostname` sits inside a zone this instance already controls. */
export function isOwnZone(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return ownZones().some((zone) => host === zone || host.endsWith(`.${zone}`));
}

/** Whether this claim has to be proved before it may route. */
export function requiresOwnershipProof(hostname: string, isAdminUser: boolean): boolean {
  if (isAdminUser) return false;
  return !isOwnZone(hostname);
}

export interface OwnershipResult {
  ok: boolean;
  /** What was found at the challenge record, for a useful error message. */
  found: string[];
  error?: string;
}

/**
 * Look up the challenge record and compare it with the expected token.
 * A DNS failure is reported as "not yet", never as success.
 */
export async function checkOwnershipRecord(hostname: string, expected: string): Promise<OwnershipResult> {
  const name = challengeRecordName(hostname);
  let records: string[][];
  try {
    records = await resolveTxt(name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    return {
      ok: false,
      found: [],
      error: code === 'ENOTFOUND' || code === 'ENODATA'
        ? `No TXT record found at ${name} yet. DNS changes can take a few minutes to propagate.`
        : `Could not look up ${name}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Each answer arrives as an array of strings (TXT records are chunked at
  // 255 bytes), so join the chunks before comparing.
  const found = records.map((chunks) => chunks.join(''));
  const ok = found.includes(expected);
  return ok
    ? { ok: true, found }
    : { ok: false, found, error: `The TXT record at ${name} does not contain this domain's verification token.` };
}

/** Normalise pasted input to a bare hostname. Users routinely paste a full
 *  URL (`https://app.example.com/`) instead of the host, so scheme,
 *  credentials, port and anything after the host are discarded first; what
 *  remains is then lowercased — DNS is case-insensitive — and stripped of
 *  the insignificant trailing root dot. Empty output means unusable input. */
export function normalizeHost(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      // `URL.hostname` drops credentials, port and path in one step.
      value = new URL(value).hostname;
    } catch {
      return '';
    }
  }
  // Scheme-less pastes can still carry a path (`app.example.com/`, `app.example.com/about`).
  value = value.split(/[/?#]/)[0] ?? '';
  // Traefik's Host matcher never sees a port.
  value = value.replace(/:\d+$/, '');
  return value.replace(/\.$/, '');
}

/**
 * True when two host patterns can match the same HTTP request — either an
 * exact match, or a `*.suffix` wildcard covering a single-label host under it
 * (which is exactly what `writeDynamicConfig` turns into a HostRegexp router).
 */
export function hostsCollide(a: string, b: string): boolean {
  const x = normalizeHost(a);
  const y = normalizeHost(b);
  if (x === y) return true;
  const covers = (pattern: string, host: string): boolean =>
    pattern.startsWith('*.') && !host.startsWith('*.')
      ? new RegExp(`^[a-z0-9-]+\\.${pattern.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&')}$`).test(host)
      : false;
  return covers(x, y) || covers(y, x);
}
