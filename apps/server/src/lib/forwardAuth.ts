import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';
import { forwardAuthConfig, type ForwardAuthConfig } from '@ninedeploy/schemas';
import { config } from '../config.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G2.3 forward auth: put any app behind panel sign-in, per domain. No
 * migration: `forward_auth:<domainId>` holds the least role a visitor needs.
 *
 * The flow, all on the domain's own origin except the sign-in itself:
 *  1. Traefik's `forwardAuth` asks `/_nd/fa/verify/<domainId>` about every
 *     request. Without a valid cookie, a browser is sent to the panel's
 *     `/forward-auth` page, and a one-off `state` cookie is set on the domain.
 *  2. The panel page (signed in, with the panel's own checks) asks
 *     `POST /v1/forward-auth/grant` for a one-time code bound to the domain,
 *     the user, the return URL and that state.
 *  3. The browser opens `<domain>/_nd/fa/callback?code=…`; Traefik sends that
 *     to the verify endpoint too, which spends the code (only with the matching
 *     state cookie, so nobody can sign a visitor in as someone else), sets the
 *     domain's session cookie and redirects to the return URL.
 * Every request re-checks the user, their token version (sign-out everywhere
 * ends it) and their role on the service (cached for 30 s).
 */

const PREFIX = 'forward_auth:';
const key = (domainId: number) => `${PREFIX}${domainId}`;

export const FA_PREFIX = '/_nd/fa';
export const CALLBACK_SEGMENT = '/_nd/fa/callback';
export const SESSION_TTL_S = 12 * 60 * 60;
const CODE_TTL_MS = 60_000;
const STATE_TTL_S = 10 * 60;

export async function getForwardAuth(db: DB, domainId: number): Promise<ForwardAuthConfig | null> {
  const raw = await getSettingJson<unknown>(db, key(domainId), null);
  const parsed = forwardAuthConfig.safeParse(raw);
  return raw && parsed.success ? parsed.data : null;
}

export async function setForwardAuth(db: DB, domainId: number, value: ForwardAuthConfig | null): Promise<void> {
  if (value === null) await db.delete(settings).where(eq(settings.key, key(domainId)));
  else await setSettingJson(db, key(domainId), forwardAuthConfig.parse(value));
}

/** For the proxy render: the protected domain ids. */
export async function forwardAuthDomains(db: DB): Promise<Set<number>> {
  try {
    const rows = await db.select({ key: settings.key }).from(settings).where(like(settings.key, `${PREFIX}%`));
    return new Set(rows.filter((r) => r.key.startsWith(PREFIX)).map((r) => Number(r.key.slice(PREFIX.length))).filter((n) => Number.isInteger(n) && n > 0));
  } catch {
    return new Set();
  }
}

/** The callback path of a domain: under its own path, so a path-routed domain's router still matches it. */
export function callbackPath(domainPath: string | null | undefined): string {
  const base = String(domainPath ?? '').replace(/\/+$/, '');
  return `${base}${CALLBACK_SEGMENT}`;
}

/** Whether `host` is the domain's hostname (exact, or one label under a `*.` wildcard). */
export function hostMatches(domainHost: string, host: string): boolean {
  const h = domainHost.trim().toLowerCase();
  const x = host.trim().toLowerCase();
  return h === x || (h.startsWith('*.') && x.endsWith(h.slice(1)) && x.split('.').length === h.split('.').length);
}

// ── Signed session cookie ───────────────────────────────────────────────────

const signingKey = () => createHmac('sha256', config.jwt.secret).update('nd-forward-auth-v1').digest();
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface FaSession {
  /** user id */
  u: number;
  /** domain id */
  d: number;
  /** the user's token version when signed */
  v: number;
  /** expiry, epoch seconds */
  e: number;
}

export function signSession(s: FaSession): string {
  const payload = b64(JSON.stringify(s));
  return `${payload}.${b64(createHmac('sha256', signingKey()).update(payload).digest())}`;
}

export function readSession(value: string | undefined, now = Date.now()): FaSession | null {
  if (!value || value.length > 512) return null;
  const [payload, mac] = value.split('.');
  if (!payload || !mac) return null;
  const want = createHmac('sha256', signingKey()).update(payload).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FaSession;
    if (![s.u, s.d, s.v, s.e].every((n) => Number.isSafeInteger(n))) return null;
    return s.e * 1000 > now ? s : null;
  } catch {
    return null;
  }
}

export const sessionCookieName = (domainId: number) => `nd_fa_${domainId}`;
export const stateCookieName = (domainId: number) => `nd_fa_state_${domainId}`;

export function cookie(name: string, value: string, opts: { path: string; maxAge: number; secure: boolean }): string {
  return `${name}=${value}; Path=${opts.path || '/'}; Max-Age=${opts.maxAge}; HttpOnly; SameSite=Lax${opts.secure ? '; Secure' : ''}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const newState = () => randomBytes(18).toString('base64url');
export const STATE_COOKIE_TTL_S = STATE_TTL_S;

// ── One-time codes ───────────────────────────────────────────────────────────

interface PendingCode {
  userId: number;
  domainId: number;
  returnTo: string;
  state: string;
  exp: number;
}
const codes = new Map<string, PendingCode>();

export function issueCode(c: Omit<PendingCode, 'exp'>, now = Date.now()): string {
  for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
  const code = randomBytes(24).toString('base64url');
  codes.set(code, { ...c, exp: now + CODE_TTL_MS });
  return code;
}

/** Spend a code: once, before it expires. */
export function takeCode(code: string, now = Date.now()): PendingCode | null {
  const c = codes.get(code);
  codes.delete(code);
  return c && c.exp > now ? c : null;
}

// ── Role cache ───────────────────────────────────────────────────────────────

const allowed = new Map<string, { ok: boolean; email: string; at: number }>();
const ALLOW_TTL_MS = 30_000;

export function cachedDecision(cookieValue: string, now = Date.now()): { ok: boolean; email: string } | null {
  const hit = allowed.get(cookieValue);
  return hit && now - hit.at < ALLOW_TTL_MS ? hit : null;
}

export function rememberDecision(cookieValue: string, ok: boolean, email: string, now = Date.now()): void {
  if (allowed.size > 5000) allowed.clear();
  allowed.set(cookieValue, { ok, email, at: now });
}

export function resetForwardAuthState(): void {
  codes.clear();
  allowed.clear();
}
