import { apiUrl } from './apiUrl.js';
import { setSessionTokens } from './api.js';

/**
 * SSO hand-off (r505).
 *
 * The server finishes an OIDC/OAuth sign-in by redirecting the browser with
 * the session tokens in the URL fragment. The SPA used to accept
 * `#access_token=…` on ANY route with no proof that THIS tab asked for it — so
 * a link carrying an attacker's tokens silently signed the victim in to the
 * attacker's account (login CSRF / session swap), and whatever they then
 * typed (a server key, a deploy secret) landed in the attacker's account.
 *
 * Now the tab that clicks an SSO button mints a random nonce, keeps it in
 * sessionStorage and sends it through the start route; the server binds it
 * into the signed state and echoes it in the fragment. Tokens are taken only
 * on the dedicated callback route and only when the echoed nonce matches the
 * stored one — which is then discarded either way.
 */
export const SSO_CALLBACK_PATH = '/auth/callback';
const NONCE_KEY = 'ninedeploy.ssoNonce';

export const SSO_REFUSED_MESSAGE =
  'Single sign-on could not be completed in this browser tab — please sign in again.';
/** The fragment had no nonce: a flow started by a page from before the update. */
export const SSO_STALE_MESSAGE =
  'That sign-in link was missing its security check (this can happen right after an update) — please sign in again.';

export type SsoFragmentResult =
  | { kind: 'none' }
  | { kind: 'accepted'; returnTo: string }
  | { kind: 'refused'; message: string };

const NONE: SsoFragmentResult = { kind: 'none' };

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * A post-login target is a same-origin PATH (`/services/4?tab=logs`), never a
 * URL: `//evil.example`, `/\evil.example`, `https://…` or anything with
 * control characters falls back. The auth pages themselves are not targets
 * (they would loop).
 */
export function safeReturnTo(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || ch === '\\') return fallback;
  }
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    if (url.pathname === '/login' || url.pathname === SSO_CALLBACK_PATH) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Start an SSO sign-in from this tab: mint + store the nonce and return the
 * URL to navigate to — resolved against the API origin (`VITE_API_URL`), with
 * the validated return path and the nonce attached.
 */
export function beginSso(authUrl: string, returnTo: string): string {
  const nonce = randomNonce();
  try {
    storage()?.setItem(NONCE_KEY, nonce);
  } catch {
    /* privacy mode — the callback will refuse and ask to sign in again */
  }
  const sep = authUrl.includes('?') ? '&' : '?';
  const query = new URLSearchParams({ returnTo: safeReturnTo(returnTo), nonce });
  return apiUrl(`${authUrl}${sep}${query.toString()}`);
}

/** The browser hop to the provider — an object so tests can observe it (jsdom cannot follow it). */
export const ssoNavigation = {
  go(url: string): void {
    window.location.assign(url);
  },
};

function takeStoredNonce(): string | null {
  try {
    const s = storage();
    const value = s?.getItem(NONCE_KEY) ?? null;
    s?.removeItem(NONCE_KEY);
    return value;
  } catch {
    return null;
  }
}

/** Length-independent comparison so the check leaks nothing about the stored value. */
function sameNonce(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let pending: SsoFragmentResult | null = null;

/**
 * Process a token fragment in the current URL, at most once per fragment:
 * the first call strips it from the address bar (and history), stores the
 * tokens when — and only when — they arrived on the callback route with this
 * tab's nonce, and remembers the outcome so a second call in the same page
 * load (React StrictMode runs state initialisers twice) sees the same answer.
 */
export function takeSsoFragment(): SsoFragmentResult {
  if (typeof window === 'undefined') return NONE;
  const { hash, pathname, search } = window.location;
  if (!hash.includes('access_token=')) return pending ?? NONE;

  const params = new URLSearchParams(hash.replace(/^#/, ''));
  // Never leave tokens in the URL — accepted or not.
  window.history.replaceState(null, '', pathname + search);
  const expected = takeStoredNonce();
  const nonce = params.get('nonce');
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');

  if (!nonce) {
    pending = { kind: 'refused', message: SSO_STALE_MESSAGE };
  } else if (pathname !== SSO_CALLBACK_PATH || !accessToken || !expected || !sameNonce(nonce, expected)) {
    pending = { kind: 'refused', message: SSO_REFUSED_MESSAGE };
  } else {
    setSessionTokens(accessToken, refreshToken ?? undefined);
    pending = { kind: 'accepted', returnTo: safeReturnTo(params.get('return_to')) };
  }
  return pending;
}

/** The provider applied the outcome — forget it so a later mount starts clean. */
export function clearSsoFragmentResult(): void {
  pending = null;
}
