/**
 * SSO state / nonce cookie helpers (Sprint 6 PR #31).
 *
 * The OIDC `GET /:name/login` route mints a fresh `state` and
 * `nonce` for every redirect to the IdP. The IdP bounces the
 * browser back to `GET /:name/callback?code=…&state=…` and the
 * callback must prove the state cookie it set is the same one
 * the IdP echoed — without that check, an attacker can trick an
 * operator into completing a sign-in the attacker started.
 *
 * We could pull in `@fastify/cookie` but the surface we need is
 * two `Set-Cookie` headers and one `Cookie` request header. A
 * 30-line helper keeps the dependency tree flat, mirrors the
 * SAML/SAML `<AuthnRequest>` shape (state is the CSRF defense,
 * nonce is the OIDC replay defense), and lets the helpers live
 * next to the SSO module that owns the auth flow.
 */

const COOKIE_PATH = '/v1/sso';
/** Ten minutes is enough for a user to complete the IdP redirect
 *  and come back; anything longer widens the CSRF window. */
const COOKIE_MAX_AGE_S = 600;

function cookieName(provider: string, kind: 'state' | 'nonce'): string {
  // Hyphens are not legal in cookie names per RFC 6265, so the
  // provider slug uses underscores. The leading `ninedeploy_sso_`
  // prefix avoids collisions with any third-party cookies the
  // panel may set on the same path.
  return `ninedeploy_sso_${provider.replace(/[^a-zA-Z0-9_-]/g, '_')}_${kind}`;
}

function setCookie(name: string, value: string, maxAgeS: number): string {
  // HttpOnly so the panel's JS cannot read it; SameSite=Lax is the
  // OIDC norm (the IdP redirect IS a top-level navigation so
  // `Strict` would drop the cookie). `Secure` is added when the
  // request came in over HTTPS so a plain-HTTP dev server still
  // works.
  const flags = [
    `${name}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeS}`,
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
  return flags;
}

export function setSsoCookies(opts: {
  reply: { header: (name: string, value: string) => void; raw?: { req: { headers: Record<string, unknown> } } };
  provider: string;
  state: string;
  nonce: string;
  /** Forwarded protocol so we can set `Secure` only on https. */
  isHttps?: boolean;
}): void {
  const stateCookie = setCookie(cookieName(opts.provider, 'state'), opts.state, COOKIE_MAX_AGE_S);
  const nonceCookie = setCookie(cookieName(opts.provider, 'nonce'), opts.nonce, COOKIE_MAX_AGE_S);
  // The `Secure` flag has to ride on the same Set-Cookie line as
  // the cookie name+value (the other attributes are flags).
  const withSecure = (c: string) => (opts.isHttps ? `${c}; Secure` : c);
  // Fastify accepts a comma-separated list of cookies in one
  // `Set-Cookie` value, but only one `Set-Cookie` line per
  // attribute — so we emit two separate header writes, the
  // standard shape.
  opts.reply.header('Set-Cookie', withSecure(stateCookie));
  opts.reply.header('Set-Cookie', withSecure(nonceCookie));
}

export function clearSsoCookies(opts: {
  reply: { header: (name: string, value: string) => void };
  provider: string;
}): void {
  const expired = (kind: 'state' | 'nonce') =>
    setCookie(cookieName(opts.provider, kind), '', 0);
  opts.reply.header('Set-Cookie', expired('state'));
  opts.reply.header('Set-Cookie', expired('nonce'));
}

/** Pull `ninedeploy_sso_<provider>_{state,nonce}` out of the
 *  `Cookie` request header. Returns `null` when either is missing
 *  — the caller treats that as a CSRF failure. */
export function readSsoCookies(opts: {
  cookieHeader: string | undefined;
  provider: string;
}): { state: string; nonce: string } | null {
  if (!opts.cookieHeader) return null;
  const want = new Set([cookieName(opts.provider, 'state'), cookieName(opts.provider, 'nonce')]);
  const result: Record<string, string> = {};
  for (const part of opts.cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (want.has(k) && v) result[k] = v;
  }
  const state = result[cookieName(opts.provider, 'state')];
  const nonce = result[cookieName(opts.provider, 'nonce')];
  if (!state || !nonce) return null;
  return { state, nonce };
}

/** Constant-time string comparison for the state cookie check. */
export function safeStateEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
