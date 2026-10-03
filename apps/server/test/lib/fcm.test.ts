/**
 * G-22 FCM HTTP v1 dispatch — lib coverage.
 *
 * `fcm.ts` is the modern FCM integration: it parses a
 * service-account JSON, mints an OAuth2 bearer (RS256 JWT
 * over the service account's private key), caches the
 * bearer for ~1 hour, and POSTs the FCM HTTP v1 endpoint.
 * The behaviour worth pinning down:
 *  - the service account parser rejects missing
 *    `project_id` / `client_email` / `private_key` with
 *    field-specific error messages.
 *  - the bearer is cached per `client_email`; the cache
 *    respects a 60-second skew so a token that just expired
 *    (or is about to) is re-minted.
 *  - the send payload always sets `notification.title` to
 *    the literal `'NineDeploy'` when the caller omits it.
 *  - the FCM endpoint URL embeds the service account's
 *    `project_id`.
 *  - a non-OK FCM response throws with the status code and
 *    the first 200 chars of the error body.
 *  - the OAuth2 token exchange surfaces a 4xx/5xx with
 *    the same prefix style.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

const fetchState = vi.hoisted(() => ({
  /** url -> response */
  responses: new Map<string, { status?: number; body?: unknown; throw?: Error }>(),
  defaultThrow: null as Error | null,
  captured: [] as CapturedFetch[],
}));

// RSA keypair generation must run before any test that signs with
// the private key, so the keys are produced once in beforeAll.
// The keys are module-level (not inside vi.hoisted) so the test
// body can use them directly.
let privateKeyPem = '';

const realFetch = globalThis.fetch;

vi.mock('../../src/lib/egressGuard.js', () => ({
  guardedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    fetchState.captured.push({ url, init });
    const r = fetchState.responses.get(url);
    if (r?.throw) throw r.throw;
    if (fetchState.defaultThrow) throw fetchState.defaultThrow;
    return new Response(JSON.stringify(r?.body ?? { name: 'projects/p/messages/1' }), {
      status: r?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));

import { generateKeyPairSync } from 'node:crypto';
import { sendFcm } from '../../src/lib/fcm.js';

const SERVICE_ACCOUNT = (privateKey: string = privateKeyPem, email: string = 'fcm-admin@proj-1.iam.gserviceaccount.com') =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'proj-1',
    private_key_id: 'kid',
    private_key: privateKey,
    client_email: email,
    client_id: '123',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  });

beforeAll(() => {
  globalThis.fetch = realFetch;
  // Generate the RSA keypair ONCE for the whole file. The lib signs
  // the OAuth2 JWT with `crypto.createSign('RSA-SHA256').sign(sa.private_key)`,
  // so the PEM must be PKCS#8 RSA-2048 (matches the lib's signAssertion).
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKeyPem = privateKey;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchState.responses.clear();
  fetchState.captured = [];
  fetchState.defaultThrow = null;
});

describe('lib/fcm', () => {
  describe('sendFcm — service account validation', () => {
    it('rejects an invalid JSON string', async () => {
      await expect(
        sendFcm({ deviceToken: 't', serviceAccountJson: '{ not json', body: 'b' }),
      ).rejects.toThrow(/Invalid FCM service account JSON/);
    });

    it('rejects a non-object JSON value', async () => {
      await expect(
        sendFcm({ deviceToken: 't', serviceAccountJson: '42', body: 'b' }),
      ).rejects.toThrow(/Invalid FCM service account JSON/);
    });

    it('rejects a missing project_id', async () => {
      const sa = JSON.stringify({ client_email: 'a@b', private_key: 'k' });
      await expect(
        sendFcm({ deviceToken: 't', serviceAccountJson: sa, body: 'b' }),
      ).rejects.toThrow(/missing project_id/);
    });

    it('rejects a missing client_email', async () => {
      const sa = JSON.stringify({ project_id: 'p', private_key: 'k' });
      await expect(
        sendFcm({ deviceToken: 't', serviceAccountJson: sa, body: 'b' }),
      ).rejects.toThrow(/missing client_email/);
    });

    it('rejects a missing private_key', async () => {
      const sa = JSON.stringify({ project_id: 'p', client_email: 'a@b' });
      await expect(
        sendFcm({ deviceToken: 't', serviceAccountJson: sa, body: 'b' }),
      ).rejects.toThrow(/missing private_key/);
    });
  });

  describe('sendFcm — happy path', () => {
    it('sends a POST to fcm.googleapis.com with the bearer + project_id and returns the message id', async () => {
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { access_token: 'tok-1', expires_in: 3600 },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        body: { name: 'projects/proj-1/messages/abc123' },
      });
      const result = await sendFcm({
        deviceToken: 'device-1',
        serviceAccountJson: SERVICE_ACCOUNT(),
        body: 'hello',
        data: { k: 'v' },
      });
      expect(result.messageId).toBe('projects/proj-1/messages/abc123');
      // The token call.
      const tokenCall = fetchState.captured[0]!;
      expect(tokenCall.url).toBe('https://oauth2.googleapis.com/token');
      expect(tokenCall.init?.method).toBe('POST');
      // The FCM call.
      const fcmCall = fetchState.captured[1]!;
      expect(fcmCall.url).toBe('https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
      expect(fcmCall.init?.method).toBe('POST');
      const headers = (fcmCall.init?.headers ?? {}) as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer tok-1');
      const body = JSON.parse(fcmCall.init?.body as string);
      expect(body.message).toMatchObject({
        token: 'device-1',
        notification: { title: 'NineDeploy', body: 'hello' },
        data: { k: 'v' },
      });
    });

    it('defaults the title to "NineDeploy" when the caller omits it', async () => {
      const sa = SERVICE_ACCOUNT(undefined, 'a-title@proj');
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { access_token: 'tok', expires_in: 3600 },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        body: { name: 'projects/proj-1/messages/x' },
      });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b' });
      const fcmCall = fetchState.captured[1]!;
      const body = JSON.parse(fcmCall.init?.body as string);
      expect(body.message.notification.title).toBe('NineDeploy');
    });

    it('emits an empty data object when the caller omits it', async () => {
      const sa = SERVICE_ACCOUNT(undefined, 'a-data@proj');
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { access_token: 'tok', expires_in: 3600 },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        body: { name: 'projects/proj-1/messages/x' },
      });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b' });
      const fcmCall = fetchState.captured[1]!;
      const body = JSON.parse(fcmCall.init?.body as string);
      expect(body.message.data).toEqual({});
    });

    it('honours a custom token_uri from the service account', async () => {
      const sa = JSON.stringify({
        project_id: 'proj-1',
        client_email: 'custom-token-uri@proj',
        private_key: privateKeyPem,
        token_uri: 'https://token.example.com/oauth',
      });
      fetchState.responses.set('https://token.example.com/oauth', {
        body: { access_token: 'tok-2', expires_in: 3600 },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        body: { name: 'projects/proj-1/messages/x' },
      });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b' });
      const tokenCall = fetchState.captured[0]!;
      expect(tokenCall.url).toBe('https://token.example.com/oauth');
    });
  });

  describe('sendFcm — error paths', () => {
    it('throws when the FCM endpoint returns a non-OK status', async () => {
      const sa = SERVICE_ACCOUNT(undefined, 'a-fcm-503@proj');
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { access_token: 'tok', expires_in: 3600 },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        status: 503, body: 'downstream busy',
      });
      await expect(
        sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b' }),
      ).rejects.toThrow(/FCM send failed: 503/);
    });

    it('throws when the OAuth2 token exchange returns a non-OK status', async () => {
      const sa = SERVICE_ACCOUNT(undefined, 'a-token-401@proj');
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        status: 401, body: 'invalid_grant',
      });
      await expect(
        sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b' }),
      ).rejects.toThrow(/FCM token exchange failed: 401/);
    });

    it('throws when the OAuth2 response has no access_token', async () => {
      const sa = SERVICE_ACCOUNT(undefined, 'a-token-noaccess@proj');
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { expires_in: 3600 }, // missing access_token
      });
      await expect(
        sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b' }),
      ).rejects.toThrow(/no access_token/);
    });
  });

  describe('bearer cache', () => {
    it('reuses a cached bearer on a second call with the same service account', async () => {
      const sa = SERVICE_ACCOUNT(undefined, 'cache-reuse@proj');
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { access_token: 'tok-cached', expires_in: 3600 },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        body: { name: 'projects/proj-1/messages/x' },
      });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b' });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b2' });
      // 1 token call + 2 FCM calls = 3 captures.
      expect(fetchState.captured).toHaveLength(3);
      const tokenCalls = fetchState.captured.filter((c) => c.url === 'https://oauth2.googleapis.com/token');
      expect(tokenCalls).toHaveLength(1);
    });

    it('mints a fresh bearer when the cached one is within the 60s skew window', async () => {
      const sa = SERVICE_ACCOUNT(undefined, 'cache-skew@proj');
      // expires_in: 30 means the lib's `expiresAt` is now+30s; the
      // 60s skew check (`expiresAt > now + 60000`) is false, so
      // a new token is requested.
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { access_token: 'tok-1', expires_in: 30 },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        body: { name: 'projects/proj-1/messages/x' },
      });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b' });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa, body: 'b2' });
      const tokenCalls = fetchState.captured.filter((c) => c.url === 'https://oauth2.googleapis.com/token');
      expect(tokenCalls).toHaveLength(2);
    });

    it('mints a fresh bearer for a different client_email', async () => {
      const sa1 = JSON.stringify({
        project_id: 'proj-1',
        client_email: 'cache-different-1@proj',
        private_key: privateKeyPem,
      });
      const sa2 = JSON.stringify({
        project_id: 'proj-1',
        client_email: 'cache-different-2@proj',
        private_key: privateKeyPem,
      });
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { access_token: 'tok', expires_in: 3600 },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        body: { name: 'projects/proj-1/messages/x' },
      });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa1, body: 'b' });
      await sendFcm({ deviceToken: 'd', serviceAccountJson: sa2, body: 'b2' });
      const tokenCalls = fetchState.captured.filter((c) => c.url === 'https://oauth2.googleapis.com/token');
      expect(tokenCalls).toHaveLength(2);
    });

    it('delivers a happy-path send and defaults a missing expires_in', async () => {
      // A distinct client_email forces a real token exchange; the token
      // response intentionally omits expires_in (the ?? 3600 default branch).
      const sa = JSON.stringify({
        project_id: 'proj-1',
        client_email: 'fresh-bearer@proj-1.iam.gserviceaccount.com',
        private_key: privateKeyPem,
      });
      fetchState.responses.set('https://oauth2.googleapis.com/token', {
        body: { access_token: 'tok-123' },
      });
      fetchState.responses.set('https://fcm.googleapis.com/v1/projects/proj-1/messages:send', {
        body: { name: 'projects/proj-1/messages/42' },
      });
      await expect(
        sendFcm({ deviceToken: 'dev', serviceAccountJson: sa, body: 'ping' }),
      ).resolves.toEqual({ messageId: 'projects/proj-1/messages/42' });
      expect(fetchState.captured.some((c) => c.url === 'https://oauth2.googleapis.com/token')).toBe(true);
    });
  });
});
