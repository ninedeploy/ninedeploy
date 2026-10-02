import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

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
 * DNS rebinding (r605): the name used to be resolved here and resolved AGAIN
 * by `fetch`, so a hostile resolver could answer public for the check and
 * private for the connect. `guardedFetch` now pins the connection to the
 * addresses it vetted — a per-request undici Agent whose connect-time `lookup`
 * returns them (TLS SNI and the Host header keep the hostname); git egress is
 * pinned the same way through curl (r355). A caller that only runs
 * `assertPublicHttpUrl` and then dials by itself is NOT pinned.
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
 * cannot silently drift), and the image auto-update registry probe
 * (`lib/imageWatch.ts`, r514 — its host comes from a member-editable image).
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
 *     design. (`webhook-out` does not follow redirects, r658.)
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

/**
 * r310: the part of a target URL that is safe to repeat in an error message —
 * scheme + host + port, never the path, query or userinfo. The guarded URLs
 * carry their credential IN the URL: a Slack/Discord webhook's secret is its
 * path, a Gotify target has `?token=`, the Namecheap call has `ApiKey=` in the
 * query and a git remote may be `https://user:token@host/…`. This message is
 * stored verbatim in `notification_log.error` (plaintext, shown in the panel)
 * and returned by API errors, so echoing the whole URL published the secret
 * the moment DNS hiccupped.
 */
export function redactEgressTarget(target: string): string {
  try {
    const url = new URL(target);
    // `host` is hostname[:port] with IPv6 brackets kept, and excludes userinfo.
    if (url.host) return `${url.protocol}//${url.host}`;
    return `a ${url.protocol} URL`;
  } catch {
    // scp-style git remote (`git@host:path`) — the host alone.
    const scp = /^[^@\s/]+@([^:\s/]+):/.exec(target);
    if (scp) return scp[1]!;
    return 'an unparseable URL';
  }
}

export class EgressBlockedError extends Error {
  constructor(target: string, reason: string) {
    super(
      `Refusing to send an outbound request to ${redactEgressTarget(target)}: ${reason}. Set NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1 if this instance really must reach internal addresses.`,
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
  return (await vetPublicHttpUrl(raw)).url;
}

/** One vetted answer for a hostname, in `dns.lookup({ all: true })` shape. */
export interface VettedAddress {
  address: string;
  family: number;
}

/**
 * The check behind `assertPublicHttpUrl`, also handing back the hostname's
 * vetted addresses — null when nothing was resolved (an IP literal, or
 * private egress allowed), i.e. when there is nothing to pin.
 */
async function vetPublicHttpUrl(raw: string): Promise<{ url: URL; host: string; addresses: VettedAddress[] | null }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressBlockedError(raw, 'it is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressBlockedError(raw, `the ${url.protocol} scheme is not allowed`);
  }
  // `new URL` keeps IPv6 literals in brackets.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (privateEgressAllowed()) return { url, host, addresses: null };

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new EgressBlockedError(raw, `${host} is a private or link-local address`);
    return { url, host, addresses: null };
  }

  let addresses: VettedAddress[];
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
  return { url, host, addresses };
}

/**
 * r605: a `net` lookup that never asks DNS — it answers `host` with the
 * addresses vetted a moment earlier and refuses any other name. Handles both
 * callback shapes (`all: true`, which undici's autoSelectFamily uses, and the
 * single-address one). Exported for its unit test.
 */
export function pinnedLookup(host: string, addresses: readonly VettedAddress[]): LookupFunction {
  const want = host.toLowerCase();
  const fn = (hostname: string, options: unknown, callback?: unknown): void => {
    const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
    const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean; family?: unknown };
    const family = opts.family === 4 || opts.family === 'IPv4' ? 4 : opts.family === 6 || opts.family === 'IPv6' ? 6 : 0;
    const list = addresses.filter((a) => family === 0 || a.family === family);
    if (hostname.toLowerCase() !== want || list.length === 0) {
      const err = Object.assign(new Error(`${hostname} has no vetted address for this request`), { code: 'ENOTFOUND' });
      process.nextTick(() => cb(err));
      return;
    }
    const first = list[0]!;
    process.nextTick(() => (opts.all ? cb(null, list.map((a) => ({ ...a }))) : cb(null, first.address, first.family)));
  };
  return fn as unknown as LookupFunction;
}

interface PinnedDispatcher {
  close(): Promise<void>;
}
type AgentCtor = new (opts: { connect: { lookup: LookupFunction } }) => PinnedDispatcher;

/**
 * The Agent class of the undici bundled with THIS Node — the one global
 * `fetch` runs on, so a dispatcher built from it is always compatible (a
 * separately installed undici major is not guaranteed to be, and would need
 * a newer Node than the engines floor). Reached through undici's
 * cross-copy global-dispatcher slot. Null when that slot holds something
 * else — an operator's proxy agent (NODE_USE_ENV_PROXY), a test's mock
 * agent: those keep the unpinned behaviour rather than being bypassed.
 */
// Newest first: undici 8 (Node 26) keeps its Agent in slot .2 and parks a
// compatibility wrapper in .1; undici 6/7 (Node 22/24) only have .1. When a
// newer slot exists it is authoritative — never fall back past it, or an
// operator's proxy dispatcher there would be bypassed through the old slot.
const GLOBAL_DISPATCHERS = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];
export function bundledAgentClass(): AgentCtor | null {
  const slot = globalThis as unknown as Record<symbol, { constructor?: unknown } | undefined>;
  if (GLOBAL_DISPATCHERS.every((s) => slot[s] === undefined)) {
    try {
      // Node loads its bundled undici (which installs the default Agent) lazily.
      void new Response(null);
    } catch {
      /* no WHATWG fetch at all */
    }
  }
  const current = GLOBAL_DISPATCHERS.map((s) => slot[s]).find((d) => d !== undefined);
  const ctor = current?.constructor;
  return typeof ctor === 'function' && ctor.name === 'Agent' ? (ctor as AgentCtor) : null;
}

/** `fetch`, refusing anything that points inside the host's own network. */
export async function guardedFetch(raw: string, init?: RequestInit): Promise<Response> {
  const { host, addresses } = await vetPublicHttpUrl(raw);
  // Do not let fetch turn one validated public URL into an unchecked private
  // redirect target. Callers receive the redirect response and can make an
  // explicit, separately guarded follow-up request if their protocol needs it.
  const Agent = addresses ? bundledAgentClass() : null;
  if (!addresses || !Agent) return fetch(raw, { ...init, redirect: 'manual' });
  // r605: connect to exactly what was vetted — fetch must not resolve again.
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(host, addresses) } });
  try {
    return await fetch(raw, { ...init, redirect: 'manual', dispatcher } as RequestInit);
  } finally {
    // Graceful: waits until the response body is consumed, then frees the socket.
    void dispatcher.close().catch(() => undefined);
  }
}
