import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { DB } from '@ninedeploy/db';
import { getSettingJson, setSettingJson } from './settings.js';
import { websocketBearerToken } from './websocketAuth.js';

/**
 * O4 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): an IP allow-list for the
 * panel itself. Off by default.
 *
 * What it covers:
 *   - signing in: the `/v1/auth/*` routes (password, passkey, 2FA, refresh,
 *     OIDC and SAML start and callback), SSO start and callback under
 *     `/v1/sso/*`, and the OAuth consent page `/v1/oauth/authorize`;
 *   - every request carrying a signed-in session (a JWT), over HTTP or WebSocket;
 *   - with `includeTokens`, requests carrying an API token or a remote-MCP token too.
 *
 * What it never covers, so integrations keep working: requests without a
 * credential (git and registry webhooks, deploy hooks, badges, status pages, CI
 * runner and node agent protocols, SCIM, error ingest, the OAuth token
 * endpoint), the web app's static files, and loopback (the panel's own
 * in-process calls from instance GitOps, move-with-data and remote-MCP tools).
 *
 * The client address is Fastify's `req.ip`, so it follows
 * NINEDEPLOY_TRUST_PROXY. With the default, a private peer's
 * X-Forwarded-For is trusted, so a container on the panel host's networks can
 * claim any address: this is a barrier against the internet, not against
 * workloads on the same host.
 */

export const PANEL_ACCESS_KEY = 'panel_access';
export const MAX_PANEL_ACCESS_ENTRIES = 64;

const cidrEntry = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((v) => parseEntry(v) !== null, { message: 'must be an IPv4 or IPv6 address, or a CIDR range such as 203.0.113.0/24' });

export const panelAccessConfig = z.object({
  enabled: z.boolean(),
  cidrs: z.array(cidrEntry).max(MAX_PANEL_ACCESS_ENTRIES),
  includeTokens: z.boolean().default(false),
});
export type PanelAccessConfig = z.infer<typeof panelAccessConfig>;

const DISABLED: PanelAccessConfig = { enabled: false, cidrs: [], includeTokens: false };

interface ParsedEntry {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** `203.0.113.9`, `203.0.113.0/24`, `2001:db8::/32` → address, prefix and family; null when invalid. */
export function parseEntry(raw: string): ParsedEntry | null {
  const [addrRaw, prefixRaw, extra] = raw.trim().split('/');
  if (extra !== undefined || !addrRaw) return null;
  const address = normalizeIp(addrRaw);
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  if (prefixRaw === undefined) return { address, prefix: max, family: version === 4 ? 'ipv4' : 'ipv6' };
  if (!/^\d{1,3}$/.test(prefixRaw)) return null;
  const prefix = Number(prefixRaw);
  if (prefix < 0 || prefix > max) return null;
  return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/** `::ffff:203.0.113.9` (an IPv4 client on a dual-stack socket) → `203.0.113.9`. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1]! : trimmed;
}

export function isLoopback(ip: string): boolean {
  const n = normalizeIp(ip);
  return n === '::1' || /^127\./.test(n);
}

/** A matcher over the configured entries. */
export function buildMatcher(cidrs: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const raw of cidrs) {
    const e = parseEntry(raw);
    if (!e) continue;
    list.addSubnet(e.address, e.prefix, e.family);
  }
  return (ip: string) => {
    const n = normalizeIp(ip);
    const version = isIP(n);
    if (version === 0) return false;
    return list.check(n, version === 4 ? 'ipv4' : 'ipv6');
  };
}

interface Compiled {
  config: PanelAccessConfig;
  allows: (ip: string) => boolean;
  loadedAt: number;
}

let cached: Compiled | null = null;
const CACHE_MS = 30_000;

function compile(config: PanelAccessConfig): Compiled {
  return { config, allows: buildMatcher(config.cidrs), loadedAt: Date.now() };
}

/** The stored configuration, validated; anything invalid reads as disabled. */
export async function readPanelAccess(db: DB): Promise<PanelAccessConfig> {
  const parsed = panelAccessConfig.safeParse(await getSettingJson<unknown>(db, PANEL_ACCESS_KEY, null));
  return parsed.success ? parsed.data : DISABLED;
}

export async function writePanelAccess(db: DB, config: PanelAccessConfig): Promise<void> {
  const clean = panelAccessConfig.parse(config);
  await setSettingJson(db, PANEL_ACCESS_KEY, clean);
  cached = compile(clean);
}

async function current(db: DB, now: number): Promise<Compiled> {
  if (!cached || now - cached.loadedAt > CACHE_MS) cached = compile(await readPanelAccess(db));
  return cached;
}

/** Tests only. */
export function resetPanelAccessCache(): void {
  cached = null;
}

/** Routes that sign a person in, by method and path (without the query string). */
export function isSignInRoute(method: string, path: string): boolean {
  if (path.startsWith('/v1/auth/')) {
    // An identity provider fetches SP metadata from its own servers.
    return !/^\/v1\/auth\/saml\/[^/]+\/metadata$/.test(path);
  }
  if (path.startsWith('/v1/sso/')) return /^\/v1\/sso\/[^/]+\/(login|saml-callback)$/.test(path);
  return path === '/v1/oauth/authorize' && (method === 'GET' || method === 'POST');
}

export type CredentialKind = 'session' | 'token' | 'none';

/** What the request carries: a session JWT, an API or MCP token, or nothing. */
export function credentialKind(headers: Record<string, string | string[] | undefined>): CredentialKind {
  const auth = headers['authorization'];
  const header = Array.isArray(auth) ? auth[0] : auth;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : websocketBearerToken(headers);
  if (!token) {
    // The database Studio proxy authenticates with its own 8-hour cookie
    // (`nd-studio-<id>`, minted by a session), so it counts as a session.
    const cookie = headers['cookie'];
    const cookies = Array.isArray(cookie) ? cookie.join('; ') : (cookie ?? '');
    return /(?:^|;\s*)nd-studio-\d+=/.test(cookies) ? 'session' : 'none';
  }
  return token.split('.').length === 3 ? 'session' : 'token';
}

export type PanelAccessVerdict = 'allow' | 'deny';

/** Panel API routes called by machines with their own (or no) credential. */
const MACHINE_PREFIXES = ['/v1/ci/runner/', '/v1/hooks/', '/v1/registry-hooks/', '/v1/deploy-hooks/', '/v1/badges/', '/v1/status/'];

/**
 * Whether a request may proceed. `disabled` is the env kill switch
 * (NINEDEPLOY_PANEL_ACCESS=off), for an operator who locked themselves out.
 *
 * `routeUrl` is the route pattern the router matched (`req.routeOptions.url`,
 * e.g. `/v1/sso/:name/login`), never the raw URL: a percent-encoded or
 * otherwise disguised path must not reach a route while dodging the check.
 * With no matched route, a request that carries a restricted credential is
 * refused (fail closed); it would only get a 404 anyway.
 */
export async function panelAccessVerdict(
  db: DB,
  req: { ip: string; method: string; routeUrl: string | undefined; headers: Record<string, string | string[] | undefined> },
  opts: { disabled: boolean; now?: number },
): Promise<PanelAccessVerdict> {
  if (opts.disabled) return 'allow';
  const { config, allows } = await current(db, opts.now ?? Date.now());
  if (!config.enabled) return 'allow';
  if (isLoopback(req.ip) || allows(req.ip)) return 'allow';
  const kind = credentialKind(req.headers);
  const restricted = kind === 'session' || (kind === 'token' && config.includeTokens);
  const route = req.routeUrl;
  if (!route) return restricted ? 'deny' : 'allow';
  if (isSignInRoute(req.method, route)) return 'deny';
  // Credentials are judged on the panel API only. Traffic Traefik hands the
  // panel for an app (wake, forward-auth verify, maintenance pages, error
  // ingest) carries that app's own Authorization header, and SCIM and the CI
  // runner protocol carry their own machine tokens.
  if (!route.startsWith('/v1/') || MACHINE_PREFIXES.some((p) => route.startsWith(p))) return 'allow';
  return restricted ? 'deny' : 'allow';
}

/** For the settings route: would `ip` still reach the panel under `config`? */
export function wouldAllow(config: PanelAccessConfig, ip: string): boolean {
  return !config.enabled || isLoopback(ip) || buildMatcher(config.cidrs)(ip);
}
