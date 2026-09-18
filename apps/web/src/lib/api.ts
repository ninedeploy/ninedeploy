import { createClient, type NineDeployClient } from '@ninedeploy/sdk';

const TOKEN_KEY = 'ninedeploy.token';
const REFRESH_KEY = 'ninedeploy.refreshToken';

/**
 * Token storage. sessionStorage (NOT localStorage) so a bearer credential
 * never survives the tab — closing the browser clears the session, shrinking
 * the XSS-exfiltration window and avoiding a long-lived refresh token sitting
 * in storage.
 */
function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // SSR / privacy mode
  }
}

export function getToken(): string | null {
  try {
    return storage()?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (token) s.setItem(TOKEN_KEY, token);
    else s.removeItem(TOKEN_KEY);
  } catch {
    /* ignore (SSR / privacy mode) */
  }
}

function getRefreshToken(): string | null {
  try {
    return storage()?.getItem(REFRESH_KEY) ?? null;
  } catch {
    return null;
  }
}

function setRefreshToken(token: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (token) s.setItem(REFRESH_KEY, token);
    else s.removeItem(REFRESH_KEY);
  } catch {
    /* ignore */
  }
}

/** Persist both tokens of a session (access + refresh). */
export function setSessionTokens(accessToken: string, refreshToken?: string): void {
  setToken(accessToken);
  setRefreshToken(refreshToken ?? null);
}

/** Clear every stored credential (logout / failed refresh). */
export function clearTokens(): void {
  setToken(null);
  setRefreshToken(null);
}

/** The raw underlying fetch (the interceptor below wraps it). */
const baseFetch: typeof fetch = (...args) => fetch(...args);

/**
 * Single-flight access-token refresh. A 15-minute access token otherwise logs
 * the user out mid-session; when it expires, this exchanges the stored refresh
 * token for a new pair. Concurrent 401s share one refresh call (no races, no
 * token-version bumps burning each other).
 */
let refreshInflight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const session = await api.auth.refresh({ refreshToken });
    setSessionTokens(session.tokens.accessToken, session.tokens.refreshToken);
    return true;
  } catch {
    clearTokens(); // refresh rejected — the session is gone server-side
    // Announce the death of the session: the auth provider gates the
    // authenticated layout on its `user` state, so without this event the
    // SPA keeps rendering as logged-in behind a wall of 401 error cards.
    window.dispatchEvent(new Event('ninedeploy:session-expired'));
    return false;
  }
}

export function refreshAccessToken(): Promise<boolean> {
  refreshInflight ??= doRefresh().finally(() => {
    refreshInflight = null;
  });
  return refreshInflight;
}

/**
 * Endpoints that exchange credentials for tokens (or run before a session
 * exists). A 401 there is a real answer — never refresh-and-retry it.
 * r193: every `/auth/` path used to be skipped, so the authenticated ones
 * (`/auth/me`, `/auth/tokens`, `/auth/sessions`, 2FA, passkey registration)
 * failed permanently once the 15-minute access token expired.
 */
export const NO_REFRESH_PATH =
  /\/(?:v1\/setup|v1\/auth\/(?:login|refresh|register|logout|forgot-password|reset-password|status|oidc\/(?!providers(?:\/|$|\?))|passkey\/login\/))/;

/**
 * Fetch wrapper: on a 401 from a non-auth endpoint, refresh the access token
 * once and retry. Auth endpoints manage tokens themselves and must not loop.
 */
const fetchWithRefresh: typeof fetch = async (input, init) => {
  const res = await baseFetch(input, init);
  if (res.status !== 401) return res;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (NO_REFRESH_PATH.test(url)) return res;
  if (!(await refreshAccessToken())) return res;
  const headers = new Headers(init?.headers);
  // The refresh just stored a fresh access token, so it is present.
  headers.set('Authorization', `Bearer ${getToken() as string}`);
  return baseFetch(input, { ...init, headers });
};

/**
 * Authenticated fetch WITH automatic token refresh — for raw downloads/uploads
 * that bypass the SDK client (export/import endpoints, blob fetches). These
 * otherwise 401 mid-session once the 15-minute access token expires.
 */
export async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // fetchWithRefresh transparently refreshes + retries on a 401.
  return fetchWithRefresh(url, { ...init, headers });
}

/**
 * Pre-configured SDK client. In development the Vite dev server proxies
 * /health and /v1 to the backend, so same-origin requests "just work".
 */
export const api: NineDeployClient = createClient({
  baseUrl: import.meta.env['VITE_API_URL'] ?? '',
  getToken: () => getToken() ?? undefined,
  fetch: fetchWithRefresh,
  // The SDK's default request timeout protects CLI/CI callers; the dashboard
  // deliberately opts out — heavy stats/graph queries are better left to the
  // user's patience (and React Query's error UI) than to an abort.
  timeoutMs: 0,
});

function getWsBase(): { proto: string; host: string } {
  const apiUrl = import.meta.env['VITE_API_URL'];
  if (apiUrl) {
    try {
      const parsed = new URL(apiUrl, window.location.href);
      return {
        proto: parsed.protocol === 'https:' ? 'wss' : 'ws',
        host: parsed.host,
      };
    } catch {
      /* fallback */
    }
  }
  return {
    proto: window.location.protocol === 'https:' ? 'wss' : 'ws',
    host: window.location.host,
  };
}

/** Browser-safe WebSocket auth: bearer token travels in a header, not the URL. */
export function websocketAuthProtocols(): string[] {
  const token = getToken();
  return token ? [`ninedeploy.bearer.${token}`] : ['ninedeploy'];
}

/** Build a WebSocket URL for streaming a deployment's logs. */
export function deployLogsWsUrl(serviceId: number, deploymentId: number): string {
  const { proto, host } = getWsBase();
  return `${proto}://${host}/v1/services/${serviceId}/deploys/${deploymentId}/logs`;
}

/** Build a WebSocket URL for container interactive exec terminal. */
export function execWsUrl(serviceId: number): string {
  const { proto, host } = getWsBase();
  return `${proto}://${host}/v1/services/${serviceId}/exec`;
}
