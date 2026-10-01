import { createClient, type NineDeployClient } from '@ninedeploy/sdk';
import { loadConfig, saveConfig } from './config.js';

export type { NineDeployClient };

/**
 * In-flight dedup: when several commands race 401s (batch scripts), the
 * refresh must happen ONCE — replaying the same refresh token twice would
 * revoke it server-side and log the session out.
 */
let refreshInflight: Promise<boolean> | null = null;

/**
 * Endpoints that exchange credentials for tokens (or run before a session
 * exists). A 401 there is a real answer — never refresh-and-retry it.
 * r193: every `/auth/` path used to be skipped, so the authenticated ones
 * (`/auth/me`, `/auth/tokens`, `/auth/sessions`, 2FA, passkey registration)
 * failed permanently once the 15-minute access token expired.
 * Keep byte-identical to apps/web/src/lib/api.ts — the web copy also exempts
 * `oidc/<slug>/link` (an authenticated route); this copy had drifted and
 * would have re-inherited the r193 failure the moment a CLI command wired
 * auth.oidc.link().
 */
export const NO_REFRESH_PATH =
  /\/(?:v1\/setup|v1\/auth\/(?:login|refresh|register|logout|forgot-password|reset-password|status|oidc\/(?!providers(?:\/|$|\?)|[^/]+\/link(?:$|\?))|passkey\/login\/))/;

/**
 * r550: join the configured base URL and an API path by string concatenation.
 * `new URL('/v1/…', base)` resolves the path against the ORIGIN, silently
 * dropping a sub-path prefix (`https://host/ninedeploy` → `https://host/v1/…`)
 * — a panel published behind a path prefix answered every raw call with the
 * front proxy's 404. The SDK has always concatenated; this keeps the raw
 * paths (exports, imports, the log WebSocket) in line with it.
 */
export function apiUrl(path: string, baseUrl: string = loadConfig().baseUrl): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function refreshSession(baseUrl: string, refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(apiUrl('/v1/auth/refresh', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { tokens?: { accessToken?: string; refreshToken?: string } };
    const tokens = data.tokens;
    if (!tokens?.accessToken || !tokens.refreshToken) return false;
    saveConfig({ ...loadConfig(), token: tokens.accessToken, refreshToken: tokens.refreshToken });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mint a fresh access token from the saved refresh token (single-flight,
 * persisted). Resolves false when there is no refresh token or the server
 * refused it — the caller then surfaces its original 401.
 */
export async function refreshAccessToken(baseUrl: string = loadConfig().baseUrl): Promise<boolean> {
  const refreshToken = loadConfig().refreshToken;
  if (!refreshToken) return false;
  refreshInflight ??= refreshSession(baseUrl, refreshToken).finally(() => {
    refreshInflight = null;
  });
  return refreshInflight;
}

/** fetch() with the dashboard's 401 → refresh → retry-once semantics. */
async function fetchWithRefresh(baseUrl: string, input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;
  if (NO_REFRESH_PATH.test(input)) return res;
  if (!(await refreshAccessToken(baseUrl))) return res;
  const headers = new Headers(init?.headers);
  const fresh = loadConfig().token;
  if (fresh) headers.set('Authorization', `Bearer ${fresh}`);
  return fetch(input, { ...init, headers });
}

/**
 * r550: authenticated raw fetch for the endpoints the SDK cannot model
 * (binary exports, the octet-stream import). These used to call fetch()
 * directly with the saved bearer and no refresh: once the 15-minute access
 * token expired, `system export` / `system import` / `services export` failed
 * with a bare 401 while every SDK-backed command kept working. Same base-URL
 * join and refresh-and-retry as getClient().
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = loadConfig();
  const headers = new Headers(init.headers);
  if (cfg.token) headers.set('Authorization', `Bearer ${cfg.token}`);
  return fetchWithRefresh(cfg.baseUrl, apiUrl(path, cfg.baseUrl), { ...init, headers });
}

/**
 * True when `token` is a JWT whose `exp` falls within `skewMs` from now.
 * Opaque API tokens (and anything undecodable) report false — they carry no
 * client-visible expiry, so the server's answer is the only authority.
 */
export function tokenExpiresSoon(token: string | undefined, skewMs = 60_000, now = Date.now()): boolean {
  if (!token) return false;
  const part = token.split('.')[1];
  if (!part) return false;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && payload.exp * 1000 - skewMs <= now;
  } catch {
    return false;
  }
}

/**
 * Build an SDK client configured from the saved CLI config.
 *
 * The 401 wrapper mirrors the dashboard's `fetchWithRefresh`: the server's
 * access token lives only ~15 minutes (NINEDEPLOY_JWT_ACCESS_TTL) and the
 * CLI used to persist ONLY that token — every scripted/CI session died a
 * quarter hour after login. On a 401 from any non-auth endpoint the saved
 * refresh token mints a fresh pair (single-flight, persisted) and the request
 * retries once with the new bearer. Auth endpoints manage their own tokens
 * and must not loop.
 */
export function getClient(): NineDeployClient {
  const cfg = loadConfig();
  return createClient({
    baseUrl: cfg.baseUrl,
    getToken: () => loadConfig().token,
    // Volume-file uploads and log tailing can be slow; still bounded so a
    // stalled backend cannot hang a CI runner forever.
    timeoutMs: 120_000,
    fetch: (input, init) => fetchWithRefresh(cfg.baseUrl, input, init),
  });
}
