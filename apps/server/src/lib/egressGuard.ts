import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * L-11: refuse outbound requests aimed at the host's own network.
 *
 * Several settings are operator-supplied URLs the server then fetches. They are
 * operator-only (`requireAdmin` is an alias of `requireOperator`), so this is
 * not a privilege escalation — an operator can already run host commands
 * through a PM2 service. The guard is defence in depth against an accident or
 * a copy-pasted URL, because "operator" is not the same trust level as "the
 * process's network position". The panel sits inside the Docker network with
 * every managed container, and on a cloud VM it can reach the instance
 * metadata service. A webhook URL is therefore a way to turn a settings field
 * into a request from a trusted source: `http://169.254.169.254/…` returns IAM
 * credentials on AWS/GCP/Azure, and `http://ninedeploy-db:5432` or
 * `http://127.0.0.1:<panel port>` reaches services that are unreachable from
 * the internet by design.
 *
 * What this does NOT solve: DNS rebinding. The name is resolved here and
 * resolved again by `fetch`, so a hostile resolver can answer differently the
 * second time. Closing that needs a connect-time hook on the HTTP agent, which
 * global `fetch` does not expose. Given these URLs are admin-entered, the
 * remaining exposure is an admin attacking their own instance.
 *
 * Escape hatch: many self-hosters legitimately point a webhook at a receiver
 * on the same LAN. `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1` turns the check off.
 *
 * WHAT IS ACTUALLY GUARDED — keep this list true, it was wrong once (r038).
 * Guarded (`guardedFetch` / `assertPublicHttpUrl`): notification channels and
 * system email webhooks (`lib/notifier.ts`), log drains
 * (`engine/logDrainManager.ts`), push delivery (`lib/fcm.ts`), git remotes
 * (`lib/gitEgress.ts`), the marketplace catalog, the Namecheap API, OAuth
 * token exchange (`lib/oauth.ts`), `templates_source`
 * (`templates/registry.ts`), repo insights and the git-host API calls in
 * `modules/sources.ts` (hardcoded provider hosts, guarded so that invariant
 * cannot silently drift).
 *
 * DELIBERATELY NOT guarded, because private addresses are the NORMAL
 * deployment for them and blocking would break working installs:
 *   - the OIDC issuer (`lib/oidc.ts`) — self-hosted Keycloak/Authentik
 *     usually sits on the same Docker network;
 *   - the S3 endpoint (`lib/s3.ts`) — MinIO at `minio:9000` is the common
 *     self-hosted backup target;
 *   - the Vault address (`lib/vault.ts`), the log-search backend
 *     (`lib/logSearch.ts`), the telemetry `export_endpoint` and the
 *     `webhook-out` endpoint — Loki, Prometheus and Vault are internal by
 *     design.
 * An earlier version of this comment claimed the OIDC issuer and the S3
 * endpoint were covered. They never were, and a security note that overstates
 * its coverage is worse than no note: it stops the next reader from checking.
 */

/** Private, loopback, link-local and other non-routable IPv4 space. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments / 192.0.0.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC6598
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Return the eight 16-bit words of an IPv6 literal, or null when malformed. */
function ipv6Words(ip: string): number[] | null {
  const addr = ip.toLowerCase().split('%')[0] ?? '';
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (!half) return [];
    const segments = half.split(':');
    if (segments.some((segment) => !/^[0-9a-f]{1,4}$/.test(segment))) return null;
    return segments.map((segment) => Number.parseInt(segment, 16));
  };
  const left = parse(halves[0] ?? '');
  const right = parse(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeroes = 8 - left.length - right.length;
  return zeroes >= 1 ? [...left, ...Array<number>(zeroes).fill(0), ...right] : null;
}

function ipv4FromWords(words: number[]): string {
  return `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`;
}

/** Loopback, unique-local, link-local and IPv4-embedded IPv6 ranges. */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] ?? '';
  if (addr === '::' || addr === '::1') return true;
  const words = ipv6Words(addr);
  if (!words) return true;

  // URL normalisation turns ::ffff:127.0.0.1 into ::ffff:7f00:1, so
  // compare numeric words rather than a dotted-quad spelling. RFC 6052
  // NAT64 and 6to4 can encode the same private targets too.
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  if (mapped || nat64) return isPrivateIPv4(ipv4FromWords(words));
  if (words[0] === 0x2002) return isPrivateIPv4(`${words[1]! >> 8}.${words[1]! & 0xff}.${words[2]! >> 8}.${words[2]! & 0xff}`);
  if ((words[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((words[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((words[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when the literal address is one this server must not dial. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // not an IP at all — caller should have resolved it first
}

export function privateEgressAllowed(): boolean {
  return process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] === '1';
}

export class EgressBlockedError extends Error {
  constructor(target: string, reason: string) {
    super(
      `Refusing to send an outbound request to ${target}: ${reason}. Set NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1 if this instance really must reach internal addresses.`,
    );
    this.name = 'EgressBlockedError';
  }
}

/**
 * Throw unless `raw` is an http(s) URL that resolves to a public address.
 * Every resolved address must be public — a name with both a public and a
 * private answer is rejected, since which one `fetch` picks is not ours.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressBlockedError(raw, 'it is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressBlockedError(raw, `the ${url.protocol} scheme is not allowed`);
  }
  if (privateEgressAllowed()) return url;

  // `new URL` keeps IPv6 literals in brackets.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new EgressBlockedError(raw, `${host} is a private or link-local address`);
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new EgressBlockedError(raw, `the hostname ${host} could not be resolved`);
  }
  if (addresses.length === 0) throw new EgressBlockedError(raw, `the hostname ${host} resolved to no addresses`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new EgressBlockedError(raw, `${host} resolves to the private address ${address}`);
    }
  }
  return url;
}

/** `fetch`, refusing anything that points inside the host's own network. */
export async function guardedFetch(raw: string, init?: RequestInit): Promise<Response> {
  await assertPublicHttpUrl(raw);
  // Do not let fetch turn one validated public URL into an unchecked private
  // redirect target. Callers receive the redirect response and can make an
  // explicit, separately guarded follow-up request if their protocol needs it.
  return fetch(raw, { ...init, redirect: 'manual' });
}
