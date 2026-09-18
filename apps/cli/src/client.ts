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
 */
export const NO_REFRESH_PATH =
  /\/(?:v1\/setup|v1\/auth\/(?:login|refresh|register|logout|forgot-password|reset-password|status|oidc\/(?!providers(?:\/|$|\?))|passkey\/login\/))/;

async function refreshSession(baseUrl: string, refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/v1/auth/refresh`, {
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
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (res.status !== 401) return res;
      if (NO_REFRESH_PATH.test(input)) return res;
      const refreshToken = loadConfig().refreshToken;
      if (!refreshToken) return res;
      refreshInflight ??= refreshSession(cfg.baseUrl, refreshToken).finally(() => {
        refreshInflight = null;
      });
      if (!(await refreshInflight)) return res;
      const headers = new Headers(init?.headers);
      const fresh = loadConfig().token;
      if (fresh) headers.set('Authorization', `Bearer ${fresh}`);
      return fetch(input, { ...init, headers });
    },
  });
}
