import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { guardedFetch } from './egressGuard.js';
import { forbidden } from './errors.js';

export interface OidcTokenResponse {
  access_token: string;
  id_token?: string;
  token_type?: string;
}

export interface OidcUserInfo {
  sub: string;
  email: string;
  /** True when the IdP attests the email (or it is GitHub's verified primary). */
  emailVerified: boolean;
  name?: string | null;
}

/** Generate a signed state parameter for OAuth2/OIDC CSRF protection */
export interface OAuthLinkContext {
  userId: number;
  sessionJti: string;
  tokenVersion: number;
  providerFingerprint: string;
}

export function generateOAuthState(providerSlug: string, returnTo?: string, link?: OAuthLinkContext): string {
  const nonce = randomBytes(16).toString('hex');
  const payload = JSON.stringify({ slug: providerSlug, returnTo: returnTo ?? '/', nonce, ts: Date.now(), ...(link && { link }) });
  const signature = createHmac('sha256', config.jwt.secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

/** Verify a signed state parameter (constant-time signature compare) */
export function verifyOAuthState(state: string): { slug: string; returnTo: string; link?: OAuthLinkContext } | null {
  try {
    const [payloadB64, signature] = state.split('.');
    if (!payloadB64 || !signature) return null;
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const expectedSig = createHmac('sha256', config.jwt.secret).update(payloadJson).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(payloadJson);
    // 15 minute TTL on OAuth login initiation
    if (!Number.isFinite(data.ts) || data.ts > Date.now() || Date.now() - data.ts > 15 * 60 * 1000) return null;
    if (data.link !== undefined && (
      !Number.isSafeInteger(data.link?.userId) || data.link.userId <= 0 ||
      typeof data.link.sessionJti !== 'string' || !data.link.sessionJti ||
      !Number.isSafeInteger(data.link.tokenVersion) ||
      typeof data.link.providerFingerprint !== 'string' || !data.link.providerFingerprint
    )) return null;
    return { slug: data.slug, returnTo: data.returnTo, ...(data.link && { link: data.link }) };
  } catch {
    return null;
  }
}

/** Fetch OIDC discovery document */
export async function fetchOidcConfiguration(issuerUrl: string): Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string }> {
  const cleanIssuer = issuerUrl.replace(/\/+$/, '');
  const res = await guardedFetch(`${cleanIssuer}/.well-known/openid-configuration`);
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery configuration from ${cleanIssuer}: ${res.statusText}`);
  }
  return res.json() as Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string }>;
}

/** Exchange authorization code at OIDC token endpoint */
export async function exchangeOidcCode(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const res = await guardedFetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OIDC token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<OidcTokenResponse>;
}

/** Fetch user profile info from OIDC userinfo endpoint */
export async function fetchOidcUserInfo(userinfoEndpoint: string, accessToken: string): Promise<OidcUserInfo> {
  const res = await guardedFetch(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch userinfo (${res.status}): ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  // Only a real `email` claim may identify the user. `preferred_username` is
  // typically a self-chosen handle — accepting it as an email lets an attacker
  // set it to a victim's address and log in as them.
  const email = json['email'] as string | undefined;
  if (!email) {
    throw new Error('OIDC userinfo did not contain an email address');
  }
  // An IdP-attested unverified address must never link to (or auto-enroll)
  // a local account — 403, not an opaque 500, so operators see the reason.
  if (json['email_verified'] === false) {
    throw forbidden('SSO email address is not verified; refusing to link or auto-enroll an account');
  }

  if (typeof json['sub'] !== 'string' || !json['sub'].trim()) {
    throw forbidden('OIDC userinfo did not contain a stable subject');
  }
  return {
    sub: json['sub'],
    email: email.toLowerCase().trim(),
    emailVerified: json['email_verified'] === true,
    name: (json['name'] as string) ?? null,
  };
}

/** GitHub OAuth2 code exchange & user fetch */
export async function exchangeGitHubCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<OidcUserInfo> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`GitHub token exchange failed: ${tokenRes.statusText}`);
  }

  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenData.access_token) {
    throw new Error(tokenData.error_description ?? tokenData.error ?? 'Missing GitHub access token');
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'NineDeploy',
      Accept: 'application/vnd.github+json',
    },
  });

  if (!userRes.ok) {
    throw new Error(`Failed to fetch GitHub profile: ${userRes.statusText}`);
  }

  const userProfile = (await userRes.json()) as { id: number; login: string; name?: string | null; email?: string | null };
  let email = userProfile.email;
  let emailVerified = Boolean(email);

  if (!email) {
    // Fetch user verified primary email
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'NineDeploy',
        Accept: 'application/vnd.github+json',
      },
    });
    if (emailsRes.ok) {
      const emailList = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const primary = emailList.find((e) => e.primary && e.verified) ?? emailList.find((e) => e.verified) ?? emailList[0];
      if (primary) {
        email = primary.email;
        emailVerified = primary.verified === true;
      }
    }
  }

  if (!email) {
    // Synthetic namespace (no public email): NOT a verified address. The SSO
    // callback must never link this to a pre-existing local account — an
    // attacker who pre-registers `victim@github.user` would otherwise share
    // the real GitHub user's account.
    email = `${userProfile.login}@github.user`;
    emailVerified = false;
  }

  return {
    sub: String(userProfile.id),
    email: email.toLowerCase().trim(),
    emailVerified,
    name: userProfile.name ?? userProfile.login,
  };
}
