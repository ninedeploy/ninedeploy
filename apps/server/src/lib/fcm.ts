/**
 * `notifications.create-fcm` — G-22 FCM HTTP v1 dispatch
 * (Firebase Cloud Messaging for Android, iOS, web push).
 *
 * Google's FCM legacy HTTP API (X-Server-Key header) was
 * sunset in mid-2024; the modern endpoint is
 * `https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`
 * and requires an OAuth2 bearer token minted from a
 * service-account JSON. This module implements the
 * minimum-viable version: a `target` of `<device-token>`
 * and a `serviceAccountJson` (full JSON content) stored
 * in the channel's `config_json` blob. The bearer is
 * cached for ~50 minutes (Google's `expires_in`) so the
 * per-event cost is one HTTPS round-trip, not two.
 *
 * Zero npm dependencies — the JWT is a hand-rolled
 * RS256-signed base64url envelope, exactly what Google's
 * token endpoint expects. The service account's
 * `private_key` is RSA-PEM; the node `crypto.createSign`
 * path handles the rest.
 *
 * The egress guard still applies: the FCM endpoint is
 * pinned to `fcm.googleapis.com` via the allowlist, and
 * the token exchange to `oauth2.googleapis.com` is
 * also covered.
 */
import { createSign, randomBytes } from 'node:crypto';
import { guardedFetch } from './egressGuard.js';

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmDispatchInput {
  /** Device token (or topic name for `condition`s). */
  deviceToken: string;
  /** Service account JSON content. */
  serviceAccountJson: string;
  /** Notification title (defaults to the NineDeploy brand). */
  title?: string;
  /** Notification body. */
  body: string;
  /** Free-form data payload (FCM's `data` field). */
  data?: Record<string, string>;
}

interface BearerCacheEntry {
  token: string;
  expiresAt: number;
}
const bearerCache = new Map<string, BearerCacheEntry>();
const BEARER_SKEW_MS = 60_000;

export async function sendFcm(input: FcmDispatchInput): Promise<{ messageId: string }> {
  const sa = parseServiceAccount(input.serviceAccountJson);
  const bearer = await getBearer(sa);
  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  const body = JSON.stringify({
    message: {
      token: input.deviceToken,
      notification: {
        title: input.title ?? 'NineDeploy',
        body: input.body,
      },
      data: input.data ?? {},
    },
  });
  const res = await guardedFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`FCM send failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  // FCM returns { name: "projects/<id>/messages/<id>" } on success.
  const out = (await res.json()) as { name?: string };
  return { messageId: out.name ?? '' };
}

// ── service account parsing ───────────────────────────────────────────────

function parseServiceAccount(json: string): FcmServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid FCM service account JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid FCM service account JSON');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o['project_id'] !== 'string' || !o['project_id']) {
    throw new Error('FCM service account missing project_id');
  }
  if (typeof o['client_email'] !== 'string' || !o['client_email']) {
    throw new Error('FCM service account missing client_email');
  }
  if (typeof o['private_key'] !== 'string' || !o['private_key']) {
    throw new Error('FCM service account missing private_key');
  }
  return {
    project_id: o['project_id'],
    client_email: o['client_email'],
    private_key: o['private_key'],
    token_uri: typeof o['token_uri'] === 'string' ? o['token_uri'] : undefined,
  };
}

// ── OAuth2 bearer (cached per service account) ───────────────────────────

async function getBearer(sa: FcmServiceAccount): Promise<string> {
  const cached = bearerCache.get(sa.client_email);
  if (cached && cached.expiresAt > Date.now() + BEARER_SKEW_MS) {
    return cached.token;
  }
  const assertion = signAssertion(sa);
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const res = await guardedFetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`FCM token exchange failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const out = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!out.access_token) throw new Error('FCM token exchange: no access_token in response');
  const expiresInMs = (out.expires_in ?? 3600) * 1000;
  bearerCache.set(sa.client_email, {
    token: out.access_token,
    expiresAt: Date.now() + expiresInMs,
  });
  return out.access_token;
}

function signAssertion(sa: FcmServiceAccount): string {
  // OAuth2 JWT assertion: header.payload.signature, all
  // base64url-encoded, no padding. RS256 with the service
  // account's private key (PEM). The signature is
  // over `<header>.<payload>`.
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      jti: randomBytes(16).toString('hex'),
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign(sa.private_key);
  return `${header}.${payload}.${base64urlFromBuffer(sig)}`;
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlFromBuffer(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
