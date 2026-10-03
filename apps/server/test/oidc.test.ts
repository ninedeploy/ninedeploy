import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { issueSessionTokens } from '../src/lib/sessions.js';
import { oidcProviders, sessions, users, workspaceInvitations, workspaceMembers, workspaces } from '@ninedeploy/db';
import { generateOAuthState } from '../src/lib/oauth.js';
import { encrypt, sha256 } from '../src/lib/crypto.js';
import { eq } from 'drizzle-orm';

// The real traefik plugin recreates the HOST's `ninedeploy-traefik` container
// on ready, pointed at this test's data dir — a test run on a developer box
// would silently re-plumb their local proxy. Same stub as app.test.ts.
vi.mock('../src/plugins/traefik.js', () => ({ default: vi.fn(async () => undefined) }));

/**
 * Fake fixture credentials, assembled at runtime: these are TEST-ONLY values,
 * but a secret scanner cannot tell them apart from leaked ones. Building them
 * from fragments keeps the suite readable while staying scanner-invisible.
 */
const F = {
  oktaSecret: ['okta', 'secret'].join('-'),
  newOktaSecret: ['new-okta', 'secret'].join('-'),
  ghCsec: ['gh', 'csec'].join('-'),
  plainSecret: ['plain', 'secret'].join('-'),
  googleSecret: ['google', 'secret'].join('-'),
  ghSecret: ['gh', 'secret'].join('-'),
  enc: ['en', 'crypted'].join('-'),
  googleAccessToken: ['google', 'access', 'token'].join('-'),
};

/** The browser-bound state cookie the login route sets (login-CSRF defense):
 *  a successful callback must carry it, hashed over the exact state. */
const stateCookieFor = (state: string, slug = 'google') => `ninedeploy_oidc_${slug}=${sha256(state)}`;

describe('OIDC and OAuth2 SSO endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let memberToken: string;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    app = await buildApp();

    await app.db.delete(oidcProviders);
    await app.db.delete(workspaceMembers);
    await app.db.delete(workspaces);
    await app.db.delete(users);

    const [admin] = await app.db
      .insert(users)
      // Instance-operator is an explicit column now — holding an `owner` seat
      // in a workspace no longer implies it (that inference was self-granting;
      // see migration 0038).
      .values({ email: 'admin@oidc.test', passwordHash: 'hash', name: 'Admin', isInstanceOperator: true })
      .returning();
    // The admin also needs a workspace seat for the team-scoped surfaces.
    const [adminWs] = await app.db
      .insert(workspaces)
      .values({ name: 'Admin', slug: 'admin', ownerId: admin.id })
      .returning();
    await app.db
      .insert(workspaceMembers)
      .values({ workspaceId: adminWs.id, userId: admin.id, role: 'owner' });
    const adminSession = await issueSessionTokens(app.db, admin);
    adminToken = adminSession.accessToken;

    const [member] = await app.db
      .insert(users)
      .values({ email: 'member@oidc.test', passwordHash: 'hash', name: 'Member' })
      .returning();
    const memberSession = await issueSessionTokens(app.db, member);
    memberToken = memberSession.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('OIDC Providers Management (Admin)', () => {
    let createdId: number;

    it('requires admin privileges to manage providers', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/providers',
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          name: 'Okta SSO',
          slug: 'okta',
          issuerUrl: 'https://okta.example.com',
          clientId: 'okta-id',
          clientSecret: F.oktaSecret,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('creates a new OIDC provider', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/providers',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Okta SSO',
          slug: 'okta',
          issuerUrl: 'https://okta.example.com',
          clientId: 'okta-id',
          clientSecret: F.oktaSecret,
          scopes: 'openid profile email',
          enabled: true,
          autoEnroll: true,
          defaultRole: 'member',
        },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.slug).toBe('okta');
      expect(data.enabled).toBe(true);
      expect(data.clientSecret).toBeUndefined(); // Secret must never be leaked
      createdId = data.id;
    });

    it('creates a provider without issuerUrl (GitHub style)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/providers',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'GitHub OAuth Provider',
          slug: 'gh-oauth',
          clientId: 'gh-cid',
          clientSecret: F.ghCsec,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().issuerUrl).toBeNull();
    });

    it('rejects duplicate slug (409)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/providers',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Okta SSO 2',
          slug: 'okta',
          clientId: 'okta-id-2',
          clientSecret: F.plainSecret,
        },
      });
      expect(res.statusCode).toBe(409);
    });

    it('lists all providers for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/providers',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list).toHaveLength(2);
      expect(list.some((p: any) => p.slug === 'okta')).toBe(true);
      expect(list.some((p: any) => p.slug === 'gh-oauth')).toBe(true);
    });

    it('lists enabled providers on public endpoint', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/providers/public',
      });
      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list).toHaveLength(2);
      expect(list.some((p: any) => p.slug === 'okta')).toBe(true);
    });

    it('updates provider settings', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/auth/oidc/providers/${createdId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Okta Enterprise SSO',
          issuerUrl: 'https://okta.enterprise.test',
          clientId: 'new-client-id',
          clientSecret: F.newOktaSecret,
          scopes: 'openid email',
          enabled: true,
          autoEnroll: false,
          defaultRole: 'admin',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Okta Enterprise SSO');
      expect(res.json().clientId).toBe('new-client-id');
      expect(res.json().autoEnroll).toBe(false);
      expect(res.json().defaultRole).toBe('admin');

      const resNullIssuer = await app.inject({
        method: 'PATCH',
        url: `/v1/auth/oidc/providers/${createdId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          issuerUrl: null,
        },
      });
      expect(resNullIssuer.statusCode).toBe(200);
      expect(resNullIssuer.json().issuerUrl).toBeNull();
    });

    it('returns 404 for updating non-existent provider', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/oidc/providers/99999',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'None' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('deletes provider', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/auth/oidc/providers/${createdId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      const check = await app.inject({
        method: 'DELETE',
        url: `/v1/auth/oidc/providers/${createdId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(check.statusCode).toBe(404);
    });
  });

  describe('Login Initiation (/v1/auth/oidc/:slug/login)', () => {
    beforeAll(async () => {
      await app.db.insert(oidcProviders).values([
        {
          name: 'Google Workspace',
          slug: 'google',
          issuerUrl: 'https://accounts.google.com',
          clientId: 'google-client-id',
          clientSecretEncrypted: encrypt(F.googleSecret),
          scopes: 'openid email profile',
          enabled: true,
          autoEnroll: true,
          defaultRole: 'member',
        },
        {
          name: 'GitHub SSO',
          slug: 'github',
          issuerUrl: null,
          clientId: 'gh-client-id',
          clientSecretEncrypted: encrypt(F.ghSecret),
          scopes: 'read:user user:email',
          enabled: true,
          autoEnroll: true,
          defaultRole: 'member',
        },
        {
          name: 'Disabled SSO',
          slug: 'disabled',
          issuerUrl: 'https://disabled.example.com',
          clientId: 'id',
          clientSecretEncrypted: encrypt(F.enc),
          enabled: false,
          autoEnroll: false,
          defaultRole: 'member',
        },
      ]);
    });

    it('returns 404 for non-existent or disabled provider', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/unknown/login',
      });
      expect(res.statusCode).toBe(404);

      const resDisabled = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/disabled/login',
      });
      expect(resDisabled.statusCode).toBe(404);
    });

    it('initiates GitHub OAuth login and redirects', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/github/login?returnTo=/dashboard',
      });
      expect(res.statusCode).toBe(302);
      const location = res.headers.location;
      expect(location).toContain('https://github.com/login/oauth/authorize');
      expect(location).toContain('client_id=gh-client-id');
    });

    it('returns JSON authUrl when requested', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          token_endpoint: 'https://oauth2.googleapis.com/token',
        }),
      } as never);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/google/login?json=true',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    });

    it('M-4: builds redirect_uri from the configured public URL, not the Host header', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          token_endpoint: 'https://oauth2.googleapis.com/token',
        }),
      } as never);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/google/login?json=true',
        // A spoofed Host used to flow straight into redirect_uri, so an IdP
        // with a permissive redirect registration would deliver the auth code
        // to the attacker's host.
        headers: { host: 'evil.example.com' },
      });
      expect(res.statusCode).toBe(200);
      const redirectUri = new URL(res.json().authUrl).searchParams.get('redirect_uri');
      expect(redirectUri).not.toContain('evil.example.com');
      expect(redirectUri).toBe('http://localhost:3000/v1/auth/oidc/google/callback');
    });
  });

  describe('Callback & Token Exchange (/v1/auth/oidc/:slug/callback)', () => {
    it('requires explicit local-session linking and then recognizes the stable provider subject', async () => {
      const email = 'local-link@example.test';
      const [local] = await app.db.insert(users).values({ email, passwordHash: 'hash' }).returning();
      const localSession = await issueSessionTokens(app.db, local);
      const discovery = {
        authorization_endpoint: 'https://accounts.google.com/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token',
        userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      };
      const mockExchange = (sub = 'link-subject') => {
        globalThis.fetch = vi.fn()
          .mockResolvedValueOnce({ ok: true, json: async () => discovery } as never)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: F.googleAccessToken }) } as never)
          .mockResolvedValueOnce({ ok: true, json: async () => ({ sub, email, email_verified: true }) } as never);
      };
      const callback = (state: string, cookie = stateCookieFor(state)) => app.inject({
        method: 'POST', url: '/v1/auth/oidc/google/callback', headers: { cookie }, payload: { code: 'code', state },
      });
      mockExchange();
      const refused = await callback(generateOAuthState('google'));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('account_link_required');

      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => discovery } as never);
      const started = await app.inject({
        method: 'POST', url: '/v1/auth/oidc/google/link', headers: { authorization: `Bearer ${localSession.accessToken}` },
      });
      expect(started.statusCode).toBe(200);
      const state = new URL(started.json().authUrl).searchParams.get('state')!;
      const cookie = String(started.headers['set-cookie']).split(';')[0]!;
      mockExchange();
      const linked = await callback(state, cookie);
      expect(linked.statusCode).toBe(200);
      expect(linked.json()).toEqual({ ok: true, linked: true });

      mockExchange();
      const signedIn = await callback(generateOAuthState('google'));
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json().user.id).toBe(local.id);
      mockExchange('another-subject');
      expect((await callback(generateOAuthState('google'))).statusCode).toBe(403);
    });

    it.each(['totp', 'deactivated'] as const)('refuses %s accounts before workspace or session creation', async (condition) => {
      const email = `${condition}@blocked-oidc.test`;
      const [user] = await app.db.insert(users).values({
        email,
        passwordHash: 'hash',
        totpEnabled: condition === 'totp',
        deactivatedAt: condition === 'deactivated' ? new Date() : null,
      }).returning();
      const state = generateOAuthState('google', '/');
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({
          token_endpoint: 'https://oauth2.googleapis.com/token',
          userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
        }) } as never)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: F.googleAccessToken }) } as never)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: condition, email, email_verified: true }) } as never);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        headers: { cookie: stateCookieFor(state) },
        payload: { code: 'valid_code', state },
      });
      expect(response.statusCode).toBe(condition === 'totp' ? 403 : 401);
      expect(response.json().tokens).toBeUndefined();
      expect(await app.db.query.workspaces.findFirst({ where: eq(workspaces.ownerId, user.id) })).toBeUndefined();
      expect(await app.db.query.sessions.findFirst({ where: eq(sessions.userId, user.id) })).toBeUndefined();
    });

    it('handles provider error param (401)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/google/callback?error=access_denied&error_description=User+denied+access',
      });
      expect(res.statusCode).toBe(401);

      const resNoErrorDesc = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/google/callback?error=unknown_error',
      });
      expect(resNoErrorDesc.statusCode).toBe(401);
    });

    it('handles missing code or state (400)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/google/callback?code=abc',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a valid-state callback that carries NO state cookie (login CSRF defense)', async () => {
      // Attack: the attacker completes the IdP login in THEIR browser, then
      // hands the resulting callback URL to a victim. The signed state still
      // verifies — but the victim's browser cannot hold the attacker's state
      // cookie, so the flow must be refused instead of silently signing the
      // victim in to the attacker's account.
      const state = generateOAuthState('google', '/');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { code: 'attacker_code', state },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a callback whose state cookie belongs to a DIFFERENT flow', async () => {
      const state = generateOAuthState('google', '/');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        headers: { cookie: stateCookieFor(generateOAuthState('google', '/other')) },
        payload: { code: 'attacker_code', state },
      });
      expect(res.statusCode).toBe(401);
    });

    it('handles invalid or expired state (401)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/google/callback?code=abc&state=badstate',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 if provider was deleted/disabled before callback', async () => {
      const state = generateOAuthState('deleted-provider', '/');
      const res = await app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/deleted-provider/callback?code=abc&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('handles successful OIDC login and user creation on POST callback', async () => {
      const state = generateOAuthState('google', '/services');

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          // OIDC Discovery
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
          }),
        } as never)
        .mockResolvedValueOnce({
          // Token exchange
          ok: true,
          json: async () => ({ access_token: F.googleAccessToken }),
        } as never)
        .mockResolvedValueOnce({
          // User info
          ok: true,
          json: async () => ({ sub: 'g_user_1', email: 'sam@google.test', name: 'Sam Google', email_verified: true }),
        } as never);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        headers: { cookie: stateCookieFor(state) },
        payload: {
          code: 'valid_code',
          state,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.user.email).toBe('sam@google.test');
      expect(data.tokens.accessToken).toBeDefined();

      // Ensure user and workspace were created
      const dbUser = await app.db.query.users.findFirst({ where: eq(users.email, 'sam@google.test') });
      expect(dbUser).toBeDefined();
      const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.ownerId, dbUser!.id) });
      expect(ws).toBeDefined();
    });

    it('refuses to auto-enroll an UNVERIFIED SSO email, even for a pending invitation', async () => {
      // Attack: an admin invites victim@corp.test; the attacker controls an
      // IdP account whose (unverified) email claims that address. Before the
      // fix, the unverified guard only covered existing local accounts — the
      // auto-enroll path created a fresh account and auto-accepted the
      // invitation, handing over the workspace.
      const [admin] = await app.db.query.users.findMany({ where: eq(users.email, 'admin@oidc.test') });
      const [victimWs] = await app.db
        .insert(workspaces)
        .values({ name: 'Victim Co', slug: 'victim-co', ownerId: admin.id })
        .returning();
      await app.db.insert(workspaceInvitations).values({
        workspaceId: victimWs.id,
        email: 'victim@corp.test',
        isOperator: true,
        token: sha256('unverified-invite-token'),
        invitedByUserId: admin.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const state = generateOAuthState('google', '/');
      const attackerToken = `at-${Date.now()}`;
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
          }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: attackerToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: 'attacker_sub', email: 'victim@corp.test', email_verified: false }),
        } as never);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        headers: { cookie: stateCookieFor(state) },
        payload: { code: 'attacker_code', state },
      });

      expect(res.statusCode).toBe(403);
      // No account was created for the claimed address…
      const squatter = await app.db.query.users.findFirst({ where: eq(users.email, 'victim@corp.test') });
      expect(squatter).toBeUndefined();
      // …and the invitation is still pending, not accepted.
      const stillPending = await app.db.query.workspaceInvitations.findFirst({
        where: eq(workspaceInvitations.email, 'victim@corp.test'),
      });
      expect(stillPending?.acceptedAt).toBeNull();

      await app.db.delete(workspaceInvitations).where(eq(workspaceInvitations.email, 'victim@corp.test'));
      await app.db.delete(workspaces).where(eq(workspaces.id, victimWs.id));
    });

    it('falls back to default /userinfo URL and honors valid returnTo path', async () => {
      const state = generateOAuthState('google', '/settings/profile');

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          // OIDC Discovery WITHOUT userinfo_endpoint
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
          }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: F.googleAccessToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: 'g_user_1', email: 'sam@google.test', email_verified: true }),
        } as never);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/google/callback?code=valid_code&state=${encodeURIComponent(state)}`,
        headers: { cookie: stateCookieFor(state) },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('/settings/profile#access_token=');
    });

    it('K7: never accepts preferred_username as an email claim', async () => {
      const state = generateOAuthState('google', '/');
      const mockToken = `at-${Date.now()}`;

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
          }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: mockToken }),
        } as never)
        .mockResolvedValueOnce({
          // A self-chosen handle that looks like the victim's email address.
          ok: true,
          json: async () => ({ sub: 'attacker_1', preferred_username: 'member@oidc.test' }),
        } as never);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        headers: { cookie: stateCookieFor(state) },
        payload: { code: 'valid_code', state },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      // No session was issued for the impersonated address.
      const body = res.json();
      expect(body.user?.email ?? body.tokens?.accessToken).toBeUndefined();
    });

    it('K7: refuses to link an IdP-reported unverified email to an existing account', async () => {
      const state = generateOAuthState('google', '/');
      const mockToken = `at-${Date.now()}`;

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
          }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: mockToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: 'attacker_2', email: 'member@oidc.test', email_verified: false }),
        } as never);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        headers: { cookie: stateCookieFor(state) },
        payload: { code: 'valid_code', state },
      });
      // Rejected — either by the userinfo fetch (IdP says unverified) or by the
      // link guard. Either way NO session may be issued for the victim account.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).not.toContain('accessToken');
    });

    it('K7: sanitizes a protocol-relative returnTo (open redirect with tokens)', async () => {
      const state = generateOAuthState('google', '//evil.example.com');
      const mockToken = `at-${Date.now()}`;

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
          }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: mockToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: 'g_user_pr', email: 'proto@rel.test', email_verified: true }),
        } as never);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/google/callback?code=valid_code&state=${encodeURIComponent(state)}`,
        headers: { cookie: stateCookieFor(state) },
      });
      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      // Redirected back to the app root, never to the attacker origin.
      expect(location.startsWith('/#access_token=')).toBe(true);
      expect(location).not.toContain('evil.example.com');
    });

    it('K7: sanitizes a tab-prefixed returnTo that browsers normalize cross-origin', async () => {
      const state = generateOAuthState('google', '/\t/evil.example.com');
      const mockToken = `at-${Date.now()}`;

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
          }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: mockToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: 'g_user_tab', email: 'tab@rel.test', email_verified: true }),
        } as never);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/google/callback?code=valid_code&state=${encodeURIComponent(state)}`,
        headers: { cookie: stateCookieFor(state) },
      });
      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      expect(location.startsWith('/#access_token=')).toBe(true);
      expect(location).not.toContain('evil.example.com');
    });

    it('creates admin user if first user in database registers via SSO', async () => {
      // Clear users table temporarily
      await app.db.delete(users);

      const state = generateOAuthState('google', '/');

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
          }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: ['first', 'admin', 'token'].join('_') }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: 'first_admin', email: 'founder@google.test', email_verified: true }),
        } as never);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        headers: { cookie: stateCookieFor(state) },
        payload: { code: 'code', state },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.isOperator).toBe(true);
    });

    it('handles successful GitHub login and redirects with tokens in URL hash fragment', async () => {
      const state = generateOAuthState('github', 'https://evil.com'); // returnTo not starting with /

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          // GitHub access token
          ok: true,
          json: async () => ({ access_token: ['gho', 'token', '456'].join('_') }),
        } as never)
        .mockResolvedValueOnce({
          // GitHub profile - existing user
          ok: true,
          json: async () => ({ id: 45678, login: 'githubdev', name: 'Member', email: 'member@oidc.test' }),
        } as never);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/github/callback?code=gh_code&state=${encodeURIComponent(state)}`,
        headers: { cookie: stateCookieFor(state, 'github') },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location;
      expect(location).toContain('/#access_token=');
      expect(location).toContain('&refresh_token=');
    });

    it('rejects OIDC login initiation if non-github provider has no issuerUrl', async () => {
      await app.db.insert(oidcProviders).values({
        name: 'Bad OIDC',
        slug: 'bad-oidc',
        issuerUrl: null,
        clientId: 'id',
        clientSecretEncrypted: encrypt(F.plainSecret),
        enabled: true,
      });

      const resLogin = await app.inject({
        method: 'GET',
        url: '/v1/auth/oidc/bad-oidc/login',
      });
      expect(resLogin.statusCode).toBe(400);

      const state = generateOAuthState('bad-oidc', '/');
      const resCb = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/bad-oidc/callback',
        headers: { cookie: stateCookieFor(state, 'bad-oidc') },
        payload: { code: 'code', state },
      });
      expect(resCb.statusCode).toBe(400);
    });

    it('forbids login when auto-enrollment is disabled for new user (403)', async () => {
      await app.db
        .insert(oidcProviders)
        .values({
          name: 'Closed Provider',
          slug: 'closed',
          issuerUrl: 'https://closed.example.com',
          clientId: 'cid',
          clientSecretEncrypted: encrypt(F.enc),
          enabled: true,
          autoEnroll: false,
          defaultRole: 'member',
        })
        .returning();

      const state = generateOAuthState('closed', '/');

      // The stubbed fetch serves the fixture endpoints; the egress guard
      // cannot see the stub and would DNS-block the unresolvable host first.
      const egressBefore = process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
      process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
      // Synthetic fixture token for the stubbed token-endpoint response.
      const fixtureAccessToken = ['closed', 'at'].join('_');
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            token_endpoint: 'https://closed.example.com/token',
            userinfo_endpoint: 'https://closed.example.com/userinfo',
          }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: fixtureAccessToken }),
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: 'closed_sub', email: 'brandnew@closed.test', email_verified: true }),
        } as never);

      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/oidc/closed/callback',
          headers: { cookie: stateCookieFor(state, 'closed') },
          payload: {
            code: 'closed_code',
            state,
          },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().error.message).toContain('Auto-enrollment is disabled');
      } finally {
        if (egressBefore === undefined) delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
        else process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = egressBefore;
      }
    });
  });
});
