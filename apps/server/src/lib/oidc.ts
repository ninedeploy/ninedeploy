import { createHash, createHmac, createPublicKey, createVerify, randomBytes } from 'node:crypto';

/**
 * Minimal OIDC client — Sprint 5, Gap G-22.
 *
 * Discovery + JWKS fetch + ID-token verification using only
 * `node:crypto` + `fetch`. No new npm dependency.
 *
 * The shape is intentionally narrow: an operator's typical config
 * supplies an issuer URL, a client id, a client secret and a
 * redirect URI. The helper returns the verified `id_token` claims;
 * the HTTP module is responsible for redirecting the user to the
 * authorize endpoint, holding the `state` + `nonce` cookies, and
 * exchanging the authorization code at the token endpoint.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
}

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

export interface OidcClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  email?: string;
  /** Standard OIDC claim; only `true` lets `email` be used as the join key. */
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [extra: string]: unknown;
}

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

const textEncoder = new TextEncoder();

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i]! ^ b[i]!;
  return mismatch === 0;
}

export async function discover(config: OidcConfig): Promise<OidcDiscovery> {
  const url = `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${url}`);
  return (await res.json()) as OidcDiscovery;
}

export function buildAuthorizeUrl(discovery: OidcDiscovery, config: OidcConfig, state: string, nonce: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: (config.scopes ?? DEFAULT_SCOPES).join(' '),
    state,
    nonce,
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

export interface TokenResponse {
  id_token: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export async function exchangeCode(
  discovery: OidcDiscovery,
  config: OidcConfig,
  code: string,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OIDC token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

interface Jwks {
  keys: Jwk[];
}

const jwksCache = new Map<string, { fetchedAt: number; keys: Jwk[] }>();
const JWKS_TTL_MS = 5 * 60 * 1000;

async function fetchJwks(jwksUri: string, force = false): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status}) for ${jwksUri}`);
  const jwks = (await res.json()) as Jwks;
  jwksCache.set(jwksUri, { fetchedAt: Date.now(), keys: jwks.keys });
  return jwks.keys;
}

function findKey(keys: Jwk[], kid: string | undefined): Jwk {
  if (kid) {
    const found = keys.find((k) => k.kid === kid);
    if (found) return found;
    // Never fall back to an arbitrary key when the token NAMES its key:
    // with a multi-key JWKS (rotation overlap) that could verify the token
    // against whichever key is listed first.
    throw new Error(`No JWK with kid "${kid}" in JWKS response`);
  }
  // Token without a `kid`: fall back to the first RSA key — most OIDC
  // providers ship only one signing key and never include the claim.
  const rsa = keys.find((k) => k.kty === 'RSA');
  if (rsa) return rsa;
  throw new Error('No usable JWK in JWKS response');
}

function verifyRs256(input: string, signature: string, jwk: Jwk): boolean {
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new Error('JWK is not an RSA public key');
  }
  const data = textEncoder.encode(input);
  const sig = base64UrlDecode(signature);
  // Build the public key directly from the JWK. `createPublicKey`
  // accepts `{ key: jwk, format: 'jwk' }` and produces a KeyObject
  // we can hand straight to `createVerify`. This skips the manual
  // ASN.1 SubjectPublicKeyInfo encoding — that path is fragile in
  // Node 24+ (the long-form-length fix helped some keys, but the
  // PEM/DER round-trip the verifier really wants is awkward to
  // get right across the JOSE / OIDC key universe). JWK → KeyObject
  // is the supported path.
  const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  return createVerify('RSA-SHA256').update(data).verify(key, sig);
}

export async function verifyIdToken(
  discovery: OidcDiscovery,
  config: OidcConfig,
  idToken: string,
  /**
   * The nonce the auth request emitted. Required by OIDC spec, but
   * the PR #23-b follow-up adds the HttpOnly state/nonce cookie
   * pair. Until then, callers pass an empty string to opt out of
   * the nonce check — the rest of the claims (iss, aud, exp) are
   * still enforced. The empty-string case is documented and limited
   * to the in-flight OIDC callback; the SAML flow does not use this
   * function at all.
   */
  expectedNonce: string,
): Promise<OidcClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ID token is not a JWS compact serialization');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as { alg?: string; kid?: string; typ?: string };
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported ID token alg "${header.alg ?? 'missing'}"`);
  }
  let keys = await fetchJwks(discovery.jwks_uri);
  // After an IdP key rotation the cached JWKS no longer lists the new kid —
  // force one refresh before failing, so logins don't break for up to the
  // cache TTL after an operator rotates signing keys.
  if (header.kid && !keys.some((k) => k.kid === header.kid)) {
    keys = await fetchJwks(discovery.jwks_uri, true);
  }
  const key = findKey(keys, header.kid);
  const input = `${headerB64}.${payloadB64}`;
  if (!verifyRs256(input, signatureB64, key)) {
    throw new Error('ID token signature does not verify');
  }
  const claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as OidcClaims;

  // Mandatory claim checks. Slash-normalize both sides: providers commonly
  // emit `iss` with a trailing slash even when discovery was fetched without
  // one (the discovery URL itself strips it, so slash equivalence is the
  // expected contract).
  const normalizeIssuer = (u: string) => u.replace(/\/+$/, '');
  if (typeof claims.iss !== 'string' || normalizeIssuer(claims.iss) !== normalizeIssuer(config.issuer)) {
    throw new Error(`ID token issuer "${claims.iss}" does not match configured issuer`);
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.clientId)) {
    throw new Error(`ID token audience does not include client id "${config.clientId}"`);
  }
  // OIDC Core §3.1.3.7: when the audience is multi-valued the token MUST
  // carry azp and it must equal this client — otherwise a token minted for
  // another client that merely lists us as a secondary audience verifies.
  if (Array.isArray(claims.aud)) {
    const azp = (claims as unknown as { azp?: unknown }).azp;
    if (typeof azp !== 'string' || azp !== config.clientId) {
      throw new Error('ID token azp claim must equal the client id when aud is multi-valued');
    }
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) {
    throw new Error('ID token is expired');
  }
  // The nonce check is only enforced when the caller passes a
  // non-empty `expectedNonce`. The OIDC callback wires that
  // argument from the HttpOnly cookie the panel sets in
  // `/v1/sso/:name/login`; until the cookie layer lands in
  // PR #23-b the empty-string fallback is the documented
  // placeholder.
  if (expectedNonce) {
    if (typeof claims.nonce !== 'string' || claims.nonce !== expectedNonce) {
      throw new Error('ID token nonce does not match the one stored on the login flow');
    }
  }
  return claims;
}

export function generateOpaqueToken(byteLength = 32): string {
  return base64UrlEncode(randomBytes(byteLength));
}

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function hmacSha256(secret: string, payload: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(payload).digest());
}
