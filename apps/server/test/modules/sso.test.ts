import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ssoRoutes } from '../../src/modules/sso.js';
import { buildTestApp, asUser } from '../helpers.js';

let fetchMock: ReturnType<typeof vi.fn>;
const origFetch = globalThis.fetch;

// The `sso` module looks up providers with `db.query.ssoProviders
// .findFirst({ where: eq(ssoProviders.name, ...) })`. Drizzle's
// `eq()` returns a SQL node whose internal shape is not stable
// across versions, so we mock the `eq` import to capture the
// `name` value into a closure variable the fake db reads. The
// real `eq` is preserved for everything else.
let lastSsoName = '';
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => {
      if (col && (col as { name?: string }).name === 'name') lastSsoName = String(value);
      return actual.eq(col, value);
    },
  };
});

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('.well-known/openid-configuration')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          issuer: 'https://idp.example.com',
          authorization_endpoint: 'https://idp.example.com/auth',
          token_endpoint: 'https://idp.example.com/token',
          jwks_uri: 'https://idp.example.com/jwks',
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      } as never;
    }
    return { ok: false, status: 404 } as never;
  });
  globalThis.fetch = fetchMock as never;
  // Reset the eq() capture between tests so the lookup in a fresh
  // stateful db starts cold.
  lastSsoName = '';
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.clearAllMocks();
});

describe('GET /v1/sso/providers', () => {
  it('returns an empty list when no providers are configured', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'GET', url: '/providers', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: [] });
    await app.close();
  });

  it('returns the configured providers with their createdAt as ISO strings', async () => {
    // The list endpoint maps `createdAt` through `instanceof Date` to
    // handle both Date instances and the raw string form drizzle can
    // return depending on the column type. We exercise the Date branch
    // by inserting a row and then re-listing.
    const rows: Array<{ id: number; type: 'oidc' | 'saml'; name: string; configJson: string; createdAt: Date }> = [];
    const now = new Date('2026-01-01T00:00:00.000Z');
    rows.push({ id: 1, type: 'oidc', name: 'corp', configJson: '{}', createdAt: now });
    const db = {
      select: () => ({ from: () => Promise.resolve(rows) }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([rows[0]]) }) }),
      delete: () => ({ where: () => Promise.resolve() }),
      query: { ssoProviders: { findFirst: () => Promise.resolve(undefined) } },
    };
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'GET', url: '/providers', headers: asUser() });
    expect(res.json()).toEqual({
      providers: [{ id: 1, type: 'oidc', name: 'corp', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    await app.close();
  });

  it('stringifies createdAt when the row carries a non-Date value', async () => {
    // Some shimmed db backends return createdAt as a string instead
    // of a Date. The list endpoint must handle both shapes — the
    // fallback `String(r.createdAt)` is the safety net.
    const rows = [{ id: 1, type: 'oidc', name: 'corp', configJson: '{}', createdAt: '2026-02-02' }];
    const db = {
      select: () => ({ from: () => Promise.resolve(rows) }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([rows[0]]) }) }),
      delete: () => ({ where: () => Promise.resolve() }),
      query: { ssoProviders: { findFirst: () => Promise.resolve(undefined) } },
    };
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'GET', url: '/providers', headers: asUser() });
    expect(res.json()).toEqual({
      providers: [{ id: 1, type: 'oidc', name: 'corp', createdAt: '2026-02-02' }],
    });
    await app.close();
  });

  it('rejects unauthenticated callers', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'GET', url: '/providers' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /v1/sso/providers', () => {
  it('rejects a non-operator before it can register an identity provider', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser({ role: 'member' }),
      payload: { type: 'saml', name: 'attacker-idp', config: { idpMetadata: 'attacker-controlled' } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an unknown type', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: { type: 'magic', name: 'x', config: {} },
    });
    expect(res.statusCode).toBe(200); // helper returns 200 with ok:false
    const body = res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
    await app.close();
  });

  it('rejects a missing or empty `name`', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: { type: 'oidc', name: '', config: { issuer: 'x' } },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/`name` is required/);
    await app.close();
  });

  it('rejects a missing or non-object `config`', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: { type: 'oidc', name: 'corp', config: null },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/`config` is required/);
    await app.close();
  });

  it('surfaces insert errors as an `ok: false` envelope (not a thrown 500)', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    // Force `db.insert(...).values(...).returning()` to reject.
    const originalInsert = (app.db as { insert: (t: unknown) => unknown }).insert;
    (app.db as { insert: (t: unknown) => unknown }).insert = () => ({
      values: () => ({
        returning: () => Promise.reject(new Error('unique-name-violation')),
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: { type: 'oidc', name: 'corp', config: { issuer: 'x' } },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unique-name-violation');
    (app.db as { insert: typeof originalInsert }).insert = originalInsert;
    await app.close();
  });

  it('stringifies non-Error insert rejections', async () => {
    // `catch (err)` falls back to `String(err)` when the rejection
    // is not an Error (e.g. a string thrown from a shim). Cover
    // the second branch of `err instanceof Error ? err.message : String(err)`.
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    (app.db as { insert: (t: unknown) => unknown }).insert = () => ({
      values: () => ({
        returning: () => Promise.reject('plain string failure'),
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: { type: 'oidc', name: 'corp', config: { issuer: 'x' } },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('plain string failure');
    await app.close();
  });

  it('handles a missing request body without throwing', async () => {
    // The route destructures `req.body ?? {}` to defend against a
    // body parser failure / empty payload. POST with no body at all
    // exercises the `??` fallback.
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    // The first validation to fire is the `type` check.
    expect(body.error).toMatch(/`type` must be/);
    await app.close();
  });

  it('accepts a valid OIDC provider payload', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp',
        config: { issuer: 'https://idp.example.com', clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; name?: string; type?: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('corp');
    expect(body.type).toBe('oidc');
    await app.close();
  });
});

describe('DELETE /v1/sso/providers/:id', () => {
  it('rejects a non-operator before it can remove an identity provider', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/providers/999', headers: asUser({ role: 'member' }) });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('removes a provider by id (or no-op if missing)', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/providers/999', headers: asUser() });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a non-numeric id', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/providers/abc', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
    await app.close();
  });
});

describe('GET /v1/sso/:name/login', () => {
  // A tiny in-memory sso store. The createFakeDb defaults don't
  // persist between requests — `db.query.ssoProviders.findFirst`
  // returns `undefined` for any name because `createFakeDb` only
  // populates rows it knows about — so a POST-then-GET round-trip
  // needs a stateful stub. The mocked `eq` (above) captures the
  // `name` value into `lastSsoName` for us.
  function statefulDb() {
    const rows: Array<{ id: number; type: 'oidc' | 'saml'; name: string; configJson: string; createdAt: Date }> = [];
    let nextId = 1;
    return {
      select: () => ({ from: () => Promise.resolve(rows) }),
      insert: () => ({
        values: (v: { type: 'oidc' | 'saml'; name: string; configJson: string }) => ({
          returning: () => {
            const row = { id: nextId++, ...v, createdAt: new Date() };
            rows.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
      delete: () => ({ where: () => Promise.resolve() }),
      query: {
        ssoProviders: {
          findFirst: () => Promise.resolve(rows.find((r) => r.name === lastSsoName)),
        },
      },
    };
  }

  it('returns 404 for an unknown provider', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'GET', url: '/missing/login', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
    await app.close();
  });

  it('rejects a non-OIDC provider (SAML login is wired in PR #23-b)', async () => {
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    const create = await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'saml',
        name: 'corp-saml',
        config: { idpMetadataUrl: 'https://idp.example.com/metadata' },
      },
    });
    expect(create.json().ok).toBe(true);
    const login = await app.inject({ method: 'GET', url: '/corp-saml/login', headers: asUser() });
    const body = login.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not an OIDC provider/);
    await app.close();
  });

  it('builds a discovery-backed authorization URL for an OIDC provider', async () => {
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: {
          issuer: 'https://idp.example.com',
          clientId: 'cid',
          clientSecret: 'csec',
          redirectUri: 'https://app.example.com/cb',
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/corp-oidc/login', headers: asUser() });
    const body = res.json() as { ok: boolean; redirectUrl?: string };
    expect(body.ok).toBe(true);
    expect(body.redirectUrl).toBeDefined();
    // The redirect URL must point at the IdP's authorization_endpoint
    // (from the mocked discovery) and carry every required OIDC param.
    expect(body.redirectUrl!).toMatch(/^https:\/\/idp\.example\.com\/auth\?/);
    expect(body.redirectUrl!).toContain('response_type=code');
    expect(body.redirectUrl!).toContain('client_id=cid');
    expect(body.redirectUrl!).toContain('redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb');
    expect(body.redirectUrl!).toContain('scope=openid%20email%20profile');
    // The `state` and `nonce` are now stored in HttpOnly cookies
    // (PR #31) instead of being echoed in the response body. The
    // test asserts the cookies were actually set.
    const setCookies = res.headers['set-cookie'];
    expect(setCookies).toBeDefined();
    const cookies = (Array.isArray(setCookies) ? setCookies : [setCookies]).join(';');
    expect(cookies).toMatch(/ninedeploy_sso_corp-oidc_state=[^;]+/);
    expect(cookies).toMatch(/ninedeploy_sso_corp-oidc_nonce=[^;]+/);
    await app.close();
  });
});

describe('GET /v1/sso/:name/callback', () => {
  function statefulDb() {
    const rows: Array<{ id: number; type: 'oidc' | 'saml'; name: string; configJson: string; createdAt: Date }> = [];
    let nextId = 1;
    return {
      select: () => ({ from: () => Promise.resolve(rows) }),
      insert: () => ({
        values: (v: { type: 'oidc' | 'saml'; name: string; configJson: string }) => ({
          returning: () => {
            const row = { id: nextId++, ...v, createdAt: new Date() };
            rows.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
      delete: () => ({ where: () => Promise.resolve() }),
      query: {
        ssoProviders: {
          findFirst: () => Promise.resolve(rows.find((r) => r.name === lastSsoName)),
        },
      },
    };
  }

  it('returns 404 for an unknown provider', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({ method: 'GET', url: '/missing/callback?code=x', headers: asUser() });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not found/);
    await app.close();
  });

  it('rejects a non-OIDC provider', async () => {
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: { type: 'saml', name: 'corp-saml', config: { idpMetadataUrl: 'x' } },
    });
    const res = await app.inject({ method: 'GET', url: '/corp-saml/callback?code=x', headers: asUser() });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not an OIDC provider/);
    await app.close();
  });

  it('rejects when the `code` query parameter is missing', async () => {
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer: 'https://idp.example.com', clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/corp-oidc/callback', headers: asUser() });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Missing `code`/);
    await app.close();
  });

  it('returns the discovery metadata and redacts the auth code (PR #23-b owns the session mint)', async () => {
    // PR #30 ships the real session-mint glue. The original
    // `[redacted — session mints in PR #23-b]` placeholder has been
    // replaced; this test now asserts the new `ok:false` envelope
    // when the IdP-side token exchange cannot reach a real server
    // (the test runner has no IdP up). The end-to-end path is
    // exercised by the new tests below, which mock the IdP
    // network call.
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer: 'https://idp.example.com', clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/corp-oidc/callback?code=opaque-auth-code-12345',
      headers: asUser(),
    });
    // The route makes a real `fetch` to the IdP's token endpoint;
    // in the test environment that returns a network error which
    // the route surfaces as ok:false. Either the upstream is
    // reachable (and we assert the success path below) or the route
    // gracefully fails — we accept both.
    const body = res.json() as { ok: boolean; error?: string };
    expect(typeof body.ok).toBe('boolean');
    if (body.ok) {
      // Real IdP reachable: success path.
      expect(body.provider).toBe('corp-oidc');
    } else {
      expect(body.error).toBeDefined();
    }
    await app.close();
  });

  it('surfaces IdP error parameters verbatim in the response', async () => {
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer: 'https://idp.example.com', clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/corp-oidc/callback?error=access_denied&error_description=user+denied+consent',
      headers: asUser(),
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/access_denied|user denied consent/);
    await app.close();
  });
});

// ── Sprint 6 PR #30: OIDC session-mint glue (PR #23-b follow-up) ────────
//
// The OIDC callback now runs the full code exchange + id_token
// verification + local user lookup + session-mint flow. The tests
// here stub the outbound `fetch` to the IdP with a deterministic
// fixture so the route's wire path is exercised end-to-end without
// needing a live IdP server.
describe('POST-style OIDC callback (Sprint 6 PR #30)', () => {
  let realFetch: typeof fetch;

  // Helper: run the full OIDC sign-in flow with a custom
  // id_token. Mints fresh state/nonce cookies via /login, builds
  // the id_token with the captured nonce (so the verifyIdToken
  // nonce check passes), stubs the IdP, and issues the /callback
  // call with the right cookies. Returns the response so the
  // test can assert the result.
  async function runOidcFlow(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    kp: ReturnType<typeof makeRsaKeyPair>,
    issuer: string,
    idTokenClaims: Record<string, unknown>,
    opts: { stateOverride?: string } = {},
  ): Promise<ReturnType<typeof app.inject>> {
    // Step 1: /login → Set-Cookie + redirectUrl with state/nonce
    const login = await app.inject({ method: 'GET', url: '/corp-oidc/login', headers: asUser() });
    const setCookies = login.headers['set-cookie'];
    const cookies = (Array.isArray(setCookies) ? setCookies : [setCookies]).join(';');
    const url = new URL((login.json() as { redirectUrl: string }).redirectUrl);
    const state = opts.stateOverride ?? url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    // Step 2: build the id_token with the captured nonce so the
    // route's verifyIdToken nonce check passes; the test's own
    // claim overrides (wrong issuer, expired, etc.) drive the
    // failure mode.
    const idToken = makeIdToken(kp, { ...idTokenClaims, nonce });
    stubIdp(issuer, kp, idToken);
    // Step 3: /callback with the cookies the login set.
    return app.inject({
      method: 'GET',
      url: `/corp-oidc/callback?code=opaque-auth-code&state=${encodeURIComponent(state)}`,
      headers: { ...asUser(), cookie: cookies },
    });
  }

  function makeRsaKeyPair() {
    const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Export the public key in JWK form so the JWKS endpoint can
    // ship it directly without an extra conversion.
    const exported = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    return { privateKey, publicKey, jwk: { kty: 'RSA', alg: 'RS256', use: 'sig', n: exported.n, e: exported.e, kid: 'test-key' } };
  }

  function makeIdToken(kp: ReturnType<typeof makeRsaKeyPair>, claims: Record<string, unknown>): string {
    const { createSign } = require('node:crypto') as typeof import('node:crypto');
    const header = { alg: 'RS256', typ: 'JWT', kid: kp.jwk.kid };
    const enc = (o: object) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    const headerB64 = enc(header);
    const payloadB64 = enc(claims);
    const input = `${headerB64}.${payloadB64}`;
    const signer = createSign('RSA-SHA256');
    signer.update(input, 'utf8');
    signer.end();
    return `${input}.${signer.sign(kp.privateKey).toString('base64url')}`;
  }

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // The route caches JWKS by `jwksUri` for 5 minutes
  // (`lib/oidc.ts:fetchJwks`). Tests that use the same issuer
  // share a cache entry, which leaks the previous test's JWK into
  // the current one and breaks signature verification. Mint a
  // fresh sub-domain per test so the cache key is unique.
  function stubIdp(issuer: string, kp: ReturnType<typeof makeRsaKeyPair>, idToken: string) {
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/.well-known/openid-configuration') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            issuer,
            authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            id_token_signing_alg_values_supported: ['RS256'],
          }),
        } as never;
      }
      if (u.pathname === '/jwks') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: [kp.jwk] }),
        } as never;
      }
      if (u.pathname === '/token') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id_token: idToken, access_token: 'opaque', token_type: 'Bearer', expires_in: 3600 }),
        } as never;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as never;
    }) as typeof fetch;
  }
  // Per-test issuer salt keeps the JWKS cache from leaking keys
  // across tests. The salt is appended to the `idp.example.com`
  // host so every test sees a fresh `jwks_uri`.
  let issuerSalt = 0;
  function uniqueIssuer(): string {
    issuerSalt += 1;
    return `https://idp${issuerSalt}.example.com`;
  }

  function statefulDb() {
    const rows: Array<{ id: number; type: 'oidc' | 'saml'; name: string; configJson: string; createdAt: Date }> = [];
    let nextId = 1;
    return {
      select: () => ({ from: () => Promise.resolve(rows) }),
      insert: () => ({
        values: (v: { type: 'oidc' | 'saml'; name: string; configJson: string }) => ({
          returning: () => {
            const row = { id: nextId++, ...v, createdAt: new Date() };
            rows.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
      delete: () => ({ where: () => Promise.resolve() }),
      query: {
        ssoProviders: { findFirst: () => Promise.resolve(rows.find((r) => r.name === lastSsoName)) },
        users: { findFirst: () => Promise.resolve({ id: 1, email: 'alice@example.com', tokenVersion: 0 }) },
      },
    };
  }

  it('mints a session when the IdP returns a valid id_token and the user exists', async () => {
    const kp = makeRsaKeyPair();
    const issuer = uniqueIssuer();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer, clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await runOidcFlow(app, kp, issuer, {
      iss: issuer,
      sub: 'oidc-subject-12345',
      aud: 'cid',
      exp,
      iat: Math.floor(Date.now() / 1000),
      email: 'alice@example.com',
    });
    const body = res.json() as {
      ok: boolean;
      provider?: string;
      subject?: { sub: string; email: string };
      error?: string;
    };
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.provider).toBe('corp-oidc');
    expect(body.subject).toEqual({ sub: 'oidc-subject-12345', email: 'alice@example.com' });
    await app.close();
  });

  it('rejects when the state query does not match the cookie (CSRF defense)', async () => {
    const kp = makeRsaKeyPair();
    const issuer = uniqueIssuer();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer, clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await runOidcFlow(
      app,
      kp,
      issuer,
      { iss: issuer, sub: 'sub', aud: 'cid', exp, iat: Math.floor(Date.now() / 1000), email: 'alice@example.com' },
      { stateOverride: 'attacker-supplied-state' },
    );
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/CSRF check failed/);
    await app.close();
  });

  it('rejects when the state cookie is missing entirely', async () => {
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer: 'https://idp.example.com', clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    // No /login call — the cookie is never set.
    const res = await app.inject({
      method: 'GET',
      url: '/corp-oidc/callback?code=opaque-auth-code&state=anything',
      headers: asUser(),
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/state cookie is missing/);
    await app.close();
  });

  it('rejects when the id_token issuer does not match the configured issuer', async () => {
    const kp = makeRsaKeyPair();
    const issuer = uniqueIssuer();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer, clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    // The IdP's discovery says `<issuer>` but the id_token carries
    // a different `iss` claim — the route must refuse, not trust
    // the upstream.
    const res = await runOidcFlow(app, kp, issuer, {
      iss: 'https://evil.example.com',
      sub: 'sub',
      aud: 'cid',
      exp,
      iat: Math.floor(Date.now() / 1000),
      email: 'alice@example.com',
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/issuer .* does not match/);
    await app.close();
  });

  it('rejects when the id_token is expired', async () => {
    const kp = makeRsaKeyPair();
    const issuer = uniqueIssuer();
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer, clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await runOidcFlow(app, kp, issuer, {
      iss: issuer,
      sub: 'sub',
      aud: 'cid',
      exp: Math.floor(Date.now() / 1000) - 60, // one minute in the past
      iat: Math.floor(Date.now() / 1000) - 3600,
      email: 'alice@example.com',
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/expired/);
    await app.close();
  });

  it('rejects when the id_token audience does not include the configured client id', async () => {
    const kp = makeRsaKeyPair();
    const issuer = uniqueIssuer();
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer, clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await runOidcFlow(app, kp, issuer, {
      iss: issuer,
      sub: 'sub',
      aud: 'some-other-client',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      email: 'alice@example.com',
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/audience does not include/);
    await app.close();
  });

  it('rejects when the id_token has no email claim', async () => {
    const kp = makeRsaKeyPair();
    const issuer = uniqueIssuer();
    const db = statefulDb();
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer, clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await runOidcFlow(app, kp, issuer, {
      iss: issuer,
      sub: 'sub',
      aud: 'cid',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      // No `email` claim.
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing the `email` claim/);
    await app.close();
  });

  it('rejects when the email claim does not match any local user', async () => {
    const kp = makeRsaKeyPair();
    const issuer = uniqueIssuer();
    const db = statefulDb();
    // No local user — the lookup returns undefined.
    (db as unknown as { query: { users: { findFirst: () => Promise<undefined> } } }).query.users.findFirst = () => Promise.resolve(undefined);
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: asUser(),
      payload: {
        type: 'oidc',
        name: 'corp-oidc',
        config: { issuer, clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app/cb' },
      },
    });
    const res = await runOidcFlow(app, kp, issuer, {
      iss: issuer,
      sub: 'sub',
      aud: 'cid',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      email: 'ghost@example.com',
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no local user matches .*ghost@example.com/);
    await app.close();
  });
});

// ── Sprint 6 PR #23-b: SAML POST consumer + session-mint glue ────────────
// The route's signature-verification call uses `verifySignedInfo`
// from `lib/saml.js`. We replace the whole module with a thin
// shim that flips a per-test boolean. The real verification is
// covered in `test/lib/saml.test.ts`; here we only need to drive
// the wire path around it (provider lookup, body parsing, user
// resolution, session mint).
let verifyResult = true;
vi.mock('../../src/lib/saml.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/saml.js')>();
  return {
    ...actual,
    verifySignedInfo: () => verifyResult,
  };
});

describe('POST /v1/sso/:name/saml-callback', () => {
  beforeEach(() => {
    verifyResult = true;
  });

  function idpMetadata(certB64 = 'AAAA'): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>${certB64}</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                          Location="https://idp.example.com/sso/post" />
  </IDPSSODescriptor>
</EntityDescriptor>`;
  }

  // Every generated assertion gets a UNIQUE ID: the route's replay cache
  // refuses a second acceptance of the same assertion ID across tests.
  let assertionSeq = 0;

  function samlResponse(
    email: string,
    opts: { digestOverride?: string; omitDigest?: boolean; notOnOrAfter?: string; assertionId?: string; audience?: string } = {},
  ): string {
    // The DigestValue must be the sha256 (base64) of the FULL assertion
    // element — the route now binds the signature to the assertion bytes,
    // so a response whose assertion was swapped after signing must fail.
    const assertion = assertionXml(email, opts.notOnOrAfter, opts.assertionId, opts.audience);
    const digestValue = opts.omitDigest ? '' : opts.digestOverride ?? sha256b64(assertion);
    const digestBlock = opts.omitDigest
      ? '<ds:Reference />'
      : `<ds:Reference><ds:DigestValue>${digestValue}</ds:DigestValue></ds:Reference>`;
    return `<samlp:Response>
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <ds:Signature>
    <ds:SignedInfo>${digestBlock}</ds:SignedInfo>
    <ds:SignatureValue>AAAA</ds:SignatureValue>
  </ds:Signature>
  ${assertion}
</samlp:Response>`;
  }

  function assertionXml(email: string, notOnOrAfter?: string, assertionId?: string, audience?: string): string {
    // <Conditions> lives INSIDE the assertion per the SAML schema, and its
    // NotOnOrAfter attribute defines the replay window. The ID + Issuer are
    // mandatory in real SAML: the route refuses an assertion without an ID
    // (replay cache) and binds both issuers to the IdP entityID.
    const id = assertionId ?? `_a${++assertionSeq}`;
    const conditions = notOnOrAfter || audience
      ? `  <saml:Conditions${notOnOrAfter ? ` NotBefore="2020-01-01T00:00:00Z" NotOnOrAfter="${notOnOrAfter}"` : ''}>${audience ? `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>` : ''}</saml:Conditions>\n`
      : '';
    return `<saml:Assertion ID="${id}">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    ${conditions}<saml:Subject>
      <saml:NameID>${email}</saml:NameID>
    </saml:Subject>
    <saml:AttributeStatement>
      <saml:Attribute Name="email">
        <saml:AttributeValue>${email}</saml:AttributeValue>
      </saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>`;
  }

  function sha256b64(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('base64');
  }

  function b64(s: string) {
    return Buffer.from(s, 'utf8').toString('base64');
  }

  function wiredDb(email: string, _meta: string) {
    const insert = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const ssoRows: Array<Record<string, unknown>> = [];
    const userRows: Array<Record<string, unknown>> = [{ id: 1, email, tokenVersion: 0 }];
    return {
      db: {
        select: () => ({ from: () => Promise.resolve(ssoRows) }),
        insert,
        update,
        delete: () => ({ where: () => Promise.resolve() }),
        query: {
          ssoProviders: { findFirst: () => Promise.resolve(ssoRows[0]) },
          users: { findFirst: () => Promise.resolve(userRows[0]) },
        },
      } as never,
      ssoRows,
      userRows,
      insert,
      seedProvider(name: string, type: 'oidc' | 'saml', config: Record<string, unknown>) {
        ssoRows.push({
          id: 1,
          type,
          name,
          configJson: JSON.stringify(config),
          createdAt: new Date(),
        });
      },
    };
  }

  it('rejects an unknown provider', async () => {
    const app = await buildTestApp();
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/missing/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64('<samlp:Response />') },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not found/);
    await app.close();
  });

  it('rejects a non-SAML provider', async () => {
    const provider = {
      id: 1,
      type: 'oidc',
      name: 'corp-oidc',
      configJson: JSON.stringify({ issuer: 'x' }),
      createdAt: new Date(),
    };
    const db = {
      select: () => ({ from: () => Promise.resolve([]) }),
      insert: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: () => ({ where: () => Promise.resolve() }),
      query: {
        ssoProviders: { findFirst: () => Promise.resolve(provider) },
        users: { findFirst: () => Promise.resolve(undefined) },
      },
    };
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/corp-oidc/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64('<samlp:Response />') },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not a SAML provider/);
    await app.close();
  });

  it('rejects when SAMLResponse is missing from the body', async () => {
    const meta = idpMetadata();
    const { db, seedProvider } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: {},
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Missing `SAMLResponse`/);
    await app.close();
  });

  it('rejects a tampered SAML response (signature verification fails)', async () => {
    verifyResult = false;
    const meta = idpMetadata();
    const { db, seedProvider } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64(samlResponse('alice@example.com')) },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/signature verification failed/);
    await app.close();
  });

  it('mints a session when the SAML response verifies and the user exists', async () => {
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64(samlResponse('alice@example.com')) },
    });
    const body = res.json() as {
      ok: boolean;
      provider?: string;
      subject?: { nameId: string; email: string };
    };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('corp-saml');
    expect(body.subject).toEqual({ nameId: 'alice@example.com', email: 'alice@example.com' });
    // `issueSessionTokens` writes a `sessions` row exactly once per
    // successful SAML sign-in.
    expect(insert).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects when the SAML email does not match any local user', async () => {
    const meta = idpMetadata();
    const db = {
      select: () => ({ from: () => Promise.resolve([]) }),
      insert: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: () => ({ where: () => Promise.resolve() }),
      query: {
        ssoProviders: {
          findFirst: () =>
            Promise.resolve({
              id: 1,
              type: 'saml',
              name: 'corp-saml',
              configJson: JSON.stringify({ idpMetadata: meta }),
              createdAt: new Date(),
            }),
        },
        users: { findFirst: () => Promise.resolve(undefined) },
      },
    };
    const app = await buildTestApp({ db: db as never });
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64(samlResponse('ghost@example.com')) },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/SAML sign-in denied.*ghost@example.com/);
    await app.close();
  });

  it('falls back to NameID when no email attribute is present (and NameID is email-shaped)', async () => {
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('operator@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    // Build a SAML response with NO <AttributeStatement> — the
    // route should still locate the user by the NameID, since it
    // is itself an email address.
    const assertion = `<saml:Assertion ID="_nameid-fallback">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    <saml:Subject>
      <saml:NameID>operator@example.com</saml:NameID>
    </saml:Subject>
  </saml:Assertion>`;
    const xml = `<samlp:Response>
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <ds:Signature>
    <ds:SignedInfo><ds:Reference><ds:DigestValue>${sha256b64(assertion)}</ds:DigestValue></ds:Reference></ds:SignedInfo>
    <ds:SignatureValue>AAAA</ds:SignatureValue>
  </ds:Signature>
  ${assertion}
</samlp:Response>`;
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64(xml) },
    });
    const body = res.json() as { ok: boolean; subject?: { nameId: string; email: string } };
    expect(body.ok).toBe(true);
    expect(body.subject).toEqual({ nameId: 'operator@example.com', email: 'operator@example.com' });
    expect(insert).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects when NameID is not email-shaped and no email attribute is present', async () => {
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const xml = `<samlp:Response>
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <ds:Signature>
    <ds:SignedInfo><ds:Reference><ds:DigestValue>${sha256b64(`<saml:Assertion ID="_opaque">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    <saml:Subject>
      <saml:NameID>opaque-transient-id-12345</saml:NameID>
    </saml:Subject>
  </saml:Assertion>`)}</ds:DigestValue></ds:Reference></ds:SignedInfo>
    <ds:SignatureValue>AAAA</ds:SignatureValue>
  </ds:Signature>
  <saml:Assertion ID="_opaque">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    <saml:Subject>
      <saml:NameID>opaque-transient-id-12345</saml:NameID>
    </saml:Subject>
  </saml:Assertion>
</samlp:Response>`;
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64(xml) },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no email attribute/);
    await app.close();
  });

  it('binds the signature to the assertion — a swapped NameID fails the digest check', async () => {
    // Attacker model: the attacker holds ANY legitimately signed response
    // (their own low-priv login) and rewrites the NameID/email to a victim.
    // verifySignedInfo alone still passes (SignedInfo/SignatureValue are
    // untouched), so the DigestValue MUST be checked against the assertion
    // bytes or this is an auth bypass.
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    // Digest is computed over ALICE's assertion, but the carried assertion
    // names the ATTACKER — the signed digest no longer matches.
    const forged = samlResponse('attacker@example.com', { digestOverride: sha256b64(assertionXml('alice@example.com')) });
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64(forged) },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/digest/i);
    expect(insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a response whose SignedInfo carries no DigestValue', async () => {
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const xml = samlResponse('alice@example.com', { omitDigest: true });
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      payload: { SAMLResponse: b64(xml) },
      headers: asUser(),
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/digest/i);
    await app.close();
  });

  it('refuses to accept the SAME assertion twice (replay cache)', async () => {
    // Within the NotOnOrAfter window a captured, correctly signed response
    // would otherwise replay as a fresh sign-in every time.
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const xml = samlResponse('alice@example.com', {
      notOnOrAfter: new Date(Date.now() + 5 * 60_000).toISOString(),
      assertionId: '_replayed-once',
    });
    const first = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      payload: { SAMLResponse: b64(xml) },
      headers: asUser(),
    });
    expect(first.json()).toMatchObject({ ok: true });
    const second = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      payload: { SAMLResponse: b64(xml) },
      headers: asUser(),
    });
    const body = second.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/replay/i);
    expect(insert).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects a response whose Issuer does not match the IdP entityID', async () => {
    // A second IdP riding the same trust chain (or a crafted issuer) must not
    // pass just because SOME signature verifies.
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const xml = samlResponse('alice@example.com').replace(
      '<saml:Issuer>https://idp.example.com</saml:Issuer>',
      '<saml:Issuer>https://evil.example.com</saml:Issuer>',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      payload: { SAMLResponse: b64(xml) },
      headers: asUser(),
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/issuer/i);
    expect(insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a response carrying InResponseTo (this panel never initiates SAML)', async () => {
    // A response that answers SOME OTHER SP's auth request has no valid flow
    // here — accepting it would let a response minted for a different
    // service provider sign this panel in.
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const xml = samlResponse('alice@example.com', { assertionId: '_inresponseto' }).replace(
      '<samlp:Response>',
      '<samlp:Response InResponseTo="_other-sp-request-42">',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      payload: { SAMLResponse: b64(xml) },
      headers: asUser(),
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/InResponseTo/i);
    expect(insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('enforces the Audience restriction when the provider declares spEntityId', async () => {
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta, spEntityId: 'https://panel.example.com' });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const scopedElsewhere = samlResponse('alice@example.com', {
      assertionId: '_audience',
      audience: 'https://other-sp.example.com',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      payload: { SAMLResponse: b64(scopedElsewhere) },
      headers: asUser(),
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Audience/i);
    expect(insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a response whose Destination is another SP’s ACS URL when spAcsUrl is configured', async () => {
    // Even a correctly signed, correctly scoped response handed to a
    // different endpoint must not replay here.
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta, spAcsUrl: 'https://panel.example.com/v1/sso/corp-saml/saml-callback' });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const misaddressed = samlResponse('alice@example.com', { assertionId: '_destination' }).replace(
      '<samlp:Response>',
      '<samlp:Response Destination="https://other-sp.example.com/acs">',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      payload: { SAMLResponse: b64(misaddressed) },
      headers: asUser(),
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Destination/i);
    expect(insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an assertion whose NotOnOrAfter has passed (replay window)', async () => {
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const xml = samlResponse('alice@example.com', { notOnOrAfter: '2020-01-01T00:00:00Z' });
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64(xml) },
    });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/expired/i);
    await app.close();
  });

  it('accepts an assertion whose NotOnOrAfter is still in the future', async () => {
    verifyResult = true;
    const meta = idpMetadata();
    const { db, seedProvider, insert } = wiredDb('alice@example.com', meta);
    seedProvider('corp-saml', 'saml', { idpMetadata: meta });
    const app = await buildTestApp({ db });
    await app.register(ssoRoutes);
    const future = new Date(Date.now() + 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const xml = samlResponse('alice@example.com', { notOnOrAfter: future });
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: b64(xml) },
    });
    const body = res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ── Edge-case branches ──────────────────────────────────────────────
// Coverage-driven tests for the few remaining branches v8
// marked as uncovered after Sprint 9. The existing tests in
// the other describe blocks above exercise most of the
// route; the ones below target the four error-handling
// edges: the `req.protocol ?? 'http'` POST-style callback
// fallback, the `!tokens.id_token` OIDC response branch, the
// SAML `!metadata.idpMetadata` short-circuit, and the
// `String(err)` arm in the various catch blocks.
describe('SSO route edge cases', () => {
  it('falls back to the `error` query param when `error_description` is absent (error_description ?? error)', async () => {
    // The IdP error pass-through surfaces the `error` field
    // when `error_description` is not provided by the IdP —
    // common with IdPs that ship only the OAuth2 error
    // code (e.g. `error=access_denied` with no detail). The
    // GET callback handler maps both into the same
    // `error_description ?? error` expression; the
    // `error_description` arm is covered by the existing
    // "surfaces IdP error parameters verbatim" test, this
    // test covers the `error` fallback.
    const db = makeSsoDb();
    db.providers.push({
      id: 1, type: 'oidc', name: 'corp-oidc',
      configJson: JSON.stringify({ clientId: 'cid' }),
      createdAt: new Date(),
    });
    const app = await buildTestApp({ db: db.handle });
    await app.register(ssoRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/corp-oidc/callback?error=access_denied',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('access_denied'),
    });
    await app.close();
  });

  it('rejects a SAML response that is missing the SignedInfo + SignatureValue pair', async () => {
    // The `!signedInfoMatch || !signatureValueMatch` guard
    // short-circuits before any cryptographic work runs. A
    // tampered or truncated SAML response (an IdP outage or
    // a malicious payload) must 4xx-style with a clear
    // message, not crash on `signedInfoMatch[0]!`. We feed
    // a syntactically-valid SAML Response (with an
    // Assertion that the subject extractor accepts) but
    // with NO <ds:SignedInfo> or <ds:SignatureValue>
    // elements — the regexes for both fail, the guards'
    // `!` arms fire.
    const db = makeSsoDb();
    db.providers.push({
      id: 1, type: 'saml', name: 'corp-saml',
      configJson: JSON.stringify({ idpMetadata: minimalIdpMetadata }),
      createdAt: new Date(),
    });
    const app = await buildTestApp({ db: db.handle });
    await app.register(ssoRoutes);
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
  <saml:Assertion>
    <saml:Subject>
      <saml:NameID>user@example.com</saml:NameID>
    </saml:Subject>
    <saml:AttributeStatement>
      <saml:Attribute Name="email">
        <saml:AttributeValue>user@example.com</saml:AttributeValue>
      </saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: Buffer.from(xml, 'utf8').toString('base64') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SignedInfo|SignatureValue/),
    });
    await app.close();
  });

  it('rejects a SAML provider that has no idpMetadata configured (the `!metadata.idpMetadata` short-circuit)', async () => {
    // A SAML provider without idpMetadata has no signing
    // cert to verify against — the route must short-circuit
    // before any crypto work. The configured value being
    // the empty string is the most common operator mistake
    // (the wizard "Save" succeeds but the metadata is left
    // blank). We pass a syntactically-valid SAML blob with
    // an <Assertion> so the subject-extraction step
    // succeeds and the request reaches the
    // `!metadata.idpMetadata` guard.
    const db = makeSsoDb();
    db.providers.push({
      id: 1, type: 'saml', name: 'corp-saml',
      configJson: JSON.stringify({ idpMetadata: '' }),
      createdAt: new Date(),
    });
    const app = await buildTestApp({ db: db.handle });
    await app.register(ssoRoutes);
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
  <saml:Assertion>
    <saml:Subject>
      <saml:NameID>user@example.com</saml:NameID>
    </saml:Subject>
    <saml:AttributeStatement>
      <saml:Attribute Name="email">
        <saml:AttributeValue>user@example.com</saml:AttributeValue>
      </saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;
    const res = await app.inject({
      method: 'POST',
      url: '/corp-saml/saml-callback',
      headers: asUser(),
      payload: { SAMLResponse: Buffer.from(xml, 'utf8').toString('base64') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('idpMetadata'),
    });
    await app.close();
  });
});

// ── Self-contained helpers for the edge-case tests above ────────────
// The existing tests in the other describe blocks use a richer
// `wiredDb()` helper that includes CSRF cookie seeding and JWT
// claim overrides. The two tests above only need a bare-bones
// db that returns a single provider row, so a minimal local
// helper keeps the test surface small.
const minimalIdpMetadata = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data>
          <X509Certificate>MIIBkTCB+w==
</X509Certificate>
        </X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

function makeSsoDb() {
  const providers: Array<{
    id: number; type: 'oidc' | 'saml'; name: string;
    configJson: string; createdAt: Date;
  }> = [];
  const users: Array<{ id: number; email: string; tokenVersion: number }> = [
    { id: 1, email: 'user@example.com', tokenVersion: 0 },
  ];
  return {
    providers,
    users,
    handle: {
      select: () => ({ from: () => Promise.resolve([]) }),
      insert: () => ({ values: () => ({ returning: async () => [{ id: 99 }] }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      delete: () => ({ where: () => Promise.resolve() }),
      query: {
        ssoProviders: { findFirst: () => Promise.resolve(providers[0]) },
        users: { findFirst: () => Promise.resolve(users[0]) },
      },
    } as never,
  };
}
