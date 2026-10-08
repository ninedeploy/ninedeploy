import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { oauthIdentities, oidcProviders, sessions, users, workspaceMembers, workspaces } from '@ninedeploy/db';
import { buildApp } from '../src/app.js';
import { issueSessionTokens } from '../src/lib/sessions.js';
import { verifyJwt } from '../src/lib/jwt.js';
import { generateOAuthState, verifyOAuthState } from '../src/lib/oauth.js';
import { sha256 } from '../src/lib/crypto.js';

// The real traefik plugin recreates the HOST's `ninedeploy-traefik` container
// on ready; the worker/collector/backup schedulers would start real timers and
// docker calls. Same stubs as app.test.ts / oidc.test.ts.
vi.mock('../src/plugins/traefik.js', () => ({ default: vi.fn(async () => undefined) }));
// 0.14 background plugins: inert here, so booting the app never reaches the host's Docker (public-DB sidecars) or staging files (imports).
vi.mock('../src/plugins/publicDatabaseAccess.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/databaseImports.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/worker.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/collector.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/backupScheduler.js', () => ({ default: vi.fn(async () => undefined) }));

/**
 * 0.10.36 auth hardening, asserted through the REAL app (real auth plugin,
 * real routes, real database) — the seam where these fixes are wired, not
 * just the units behind them.
 */
describe('auth hardening through the mounted app', () => {
  let app: FastifyInstance;
  let userId: number;

  beforeAll(async () => {
    app = await buildApp();
    await app.db.delete(oauthIdentities);
    await app.db.delete(oidcProviders);
    await app.db.delete(workspaceMembers);
    await app.db.delete(workspaces);
    await app.db.delete(users);
    const [u] = await app.db
      .insert(users)
      .values({ email: 'harden@auth.test', passwordHash: 'not-a-real-hash', name: 'Harden', isInstanceOperator: true })
      .returning();
    userId = u!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const me = (token: string) =>
    app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });

  // r503: DELETE /auth/sessions/:id only stopped the refresh token; the access
  // token of the revoked device kept working for up to 15 minutes.
  it('r503: revoking a session ends its access token on the next request', async () => {
    const laptop = await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 });
    const phone = await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 });
    expect((await me(laptop.accessToken)).statusCode).toBe(200);
    expect((await me(phone.accessToken)).statusCode).toBe(200);

    const phoneJti = (await verifyJwt(phone.accessToken)).jti!;
    const row = await app.db.query.sessions.findFirst({ where: eq(sessions.jti, phoneJti) });
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${row!.id}`,
      headers: { authorization: `Bearer ${laptop.accessToken}` },
    });
    expect(revoke.statusCode).toBe(200);

    // The revoked device is out immediately; the other session is untouched.
    expect((await me(phone.accessToken)).statusCode).toBe(401);
    expect((await me(laptop.accessToken)).statusCode).toBe(200);
  });

  // r502: planting a passkey / enrolling TOTP needs a password or a FRESH
  // sign-in. Asserted on the mounted routes with real session rows.
  it('r502: a session older than 10 minutes cannot start passkey or 2FA enrolment without the password', async () => {
    const pair = await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 });
    const jti = (await verifyJwt(pair.accessToken)).jti!;
    await app.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sessions.jti, jti));
    const auth = { authorization: `Bearer ${pair.accessToken}` };
    const passkey = await app.inject({ method: 'POST', url: '/v1/auth/passkey/register/options', headers: auth, payload: {} });
    expect(passkey.statusCode).toBe(403);
    expect(passkey.json().error.code).toBe('reauth_required');
    const totp = await app.inject({ method: 'POST', url: '/v1/auth/2fa/setup', headers: auth, payload: {} });
    expect(totp.statusCode).toBe(403);
    expect(totp.json().error.code).toBe('reauth_required');
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/2fa/setup', headers: auth, payload: { password: 'guess' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('invalid_password');
  });

  it('r502: a sign-in from just now is accepted as step-up (SSO-only accounts have no password)', async () => {
    const pair = await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/2fa/setup',
      headers: { authorization: `Bearer ${pair.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('otpauthUri');
  });

  it('r503: an access token whose session row was deleted is refused', async () => {
    const pair = await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 });
    const jti = (await verifyJwt(pair.accessToken)).jti!;
    await app.db.delete(sessions).where(eq(sessions.jti, jti));
    expect((await me(pair.accessToken)).statusCode).toBe(401);
  });

  // ── r507: allowed email domains per SSO provider ──────────────────────────
  describe('r507: SSO email-domain restriction', () => {
    const originalFetch = globalThis.fetch;
    let operatorToken: string;

    /** Drive a GitHub callback whose profile carries `email` (no network: GitHub uses plain fetch). */
    const githubCallback = async (email: string, id: number) => {
      const state = generateOAuthState('github', '/');
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: ['gho', String(id)].join('_') }) } as never)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id, login: `u${id}`, name: 'Dev', email }) } as never);
      try {
        return await app.inject({
          method: 'POST',
          url: '/v1/auth/oidc/github/callback',
          headers: { cookie: `ninedeploy_oidc_github=${sha256(state)}` },
          payload: { code: 'c', state },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    };

    beforeAll(async () => {
      operatorToken = (await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 })).accessToken;
    });

    it('stores a normalised domain list on create and lists it', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/providers',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          name: 'GitHub',
          slug: 'github',
          clientId: 'gh-client',
          clientSecret: ['gh', 'secret'].join('-'),
          scopes: 'read:user user:email',
          autoEnroll: true,
          allowedDomains: ['@Corp.test'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().allowedDomains).toEqual(['corp.test']);
      const list = await app.inject({ method: 'GET', url: '/v1/auth/oidc/providers', headers: { authorization: `Bearer ${operatorToken}` } });
      expect(list.json().find((p: { slug: string }) => p.slug === 'github').allowedDomains).toEqual(['corp.test']);
    });

    it('refuses to auto-enroll an email outside the allowed domains — no account is created', async () => {
      const res = await githubCallback('outsider@gmail.test', 501);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('sso_domain_not_allowed');
      expect(res.json().error.message).toContain('corp.test');
      expect(await app.db.query.users.findFirst({ where: eq(users.email, 'outsider@gmail.test') })).toBeUndefined();
    });

    it('enrolls an email inside the allowed domains', async () => {
      const res = await githubCallback('dev@corp.test', 502);
      expect(res.statusCode).toBe(200);
      expect(res.json().user.email).toBe('dev@corp.test');
    });

    it('an enrolled user whose domain is later removed cannot sign in again', async () => {
      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/auth/oidc/providers/${(await app.db.query.oidcProviders.findFirst())!.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { allowedDomains: ['other.test'] },
      });
      expect(patch.json().allowedDomains).toEqual(['other.test']);
      expect((await githubCallback('dev@corp.test', 502)).statusCode).toBe(403);
    });

    it('an empty list (the upgrade default) restores the old unrestricted behaviour', async () => {
      const providerId = (await app.db.query.oidcProviders.findFirst())!.id;
      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/auth/oidc/providers/${providerId}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { allowedDomains: [] },
      });
      expect(patch.json().allowedDomains).toEqual([]);
      expect((await githubCallback('outsider@gmail.test', 501)).statusCode).toBe(200);
    });

    it('rejects a malformed domain', async () => {
      const providerId = (await app.db.query.oidcProviders.findFirst())!.id;
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/auth/oidc/providers/${providerId}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { allowedDomains: ['not a domain'] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── r505: SSO fragment tokens are bound to the tab that started the flow ──
  // (runs after the r507 block, which leaves an unrestricted GitHub provider)
  describe('r505: sign-in nonce round trip', () => {
    const originalFetch = globalThis.fetch;
    const NONCE = 'tab-nonce_0123456789abcdef';

    const callback = async (state: string) => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gho_505' }) } as never)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 505, login: 'u505', name: 'N', email: 'nonce@corp.test' }) } as never);
      try {
        return await app.inject({
          method: 'GET',
          url: `/v1/auth/oidc/github/callback?code=c&state=${encodeURIComponent(state)}`,
          headers: { cookie: `ninedeploy_oidc_github=${sha256(state)}` },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    };

    it('carries the web nonce from the start route into the signed state', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/auth/oidc/github/login?returnTo=%2Fservices&nonce=${NONCE}` });
      expect(res.statusCode).toBe(302);
      const state = new URL(res.headers.location as string).searchParams.get('state')!;
      expect(verifyOAuthState(state)).toMatchObject({ returnTo: '/services', clientNonce: NONCE });
    });

    it('refuses a malformed nonce at the start route', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/auth/oidc/github/login?nonce=%3Cscript%3E' });
      expect(res.statusCode).toBe(400);
    });

    it('lands a nonce flow on the dedicated SPA callback with the nonce and a safe return path', async () => {
      const res = await callback(generateOAuthState('github', '/services', undefined, NONCE));
      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      expect(location.startsWith('/auth/callback#')).toBe(true);
      const fragment = new URLSearchParams(location.slice(location.indexOf('#') + 1));
      expect(fragment.get('nonce')).toBe(NONCE);
      expect(fragment.get('return_to')).toBe('/services');
      expect(fragment.get('access_token')).toBeTruthy();
      expect(fragment.get('refresh_token')).toBeTruthy();
    });

    it('a cross-origin returnTo still collapses to / inside the nonce redirect', async () => {
      const res = await callback(generateOAuthState('github', '//evil.example.com', undefined, NONCE));
      const location = res.headers.location as string;
      expect(location.startsWith('/auth/callback#')).toBe(true);
      expect(new URLSearchParams(location.slice(location.indexOf('#') + 1)).get('return_to')).toBe('/');
    });

    it('a flow started without a nonce (pre-upgrade page) keeps the legacy redirect', async () => {
      const res = await callback(generateOAuthState('github', '/'));
      expect((res.headers.location as string).startsWith('/#access_token=')).toBe(true);
    });
  });
});
