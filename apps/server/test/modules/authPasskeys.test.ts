import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authRoutes } from '../../src/modules/auth.js';
import { asUser, buildTestApp, createFakeDb, sessionRow, userRow } from '../helpers.js';

// WebAuthn lib mocked: routes' contract is challenge storage + credential persistence.
const webauthnMocks = vi.hoisted(() => ({
  beginRegistration: vi.fn(async () => '{"challenge":"r"}'),
  finishRegistration: vi.fn(async () => ({
    credentialId: 'cred-1',
    publicKey: 'pub',
    counter: 3,
    transports: ['internal'],
  })),
  beginAuthentication: vi.fn(async () => '{"challenge":"a"}'),
  finishAuthentication: vi.fn(async () => 4),
}));
vi.mock('../../src/lib/webauthn.js', () => webauthnMocks);

const sessionsMocks = vi.hoisted(() => ({
  issueSessionTokens: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 })),
  refreshSessionTokens: vi.fn(async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 })),
  findLiveSession: vi.fn(async () => null),
  revokeAllSessions: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/sessions.js', () => sessionsMocks);

const jwtVerify = vi.hoisted(() => ({ verifyJwt: vi.fn(async () => ({ type: 'access', jti: 'jti-1' })) }));
vi.mock('../../src/lib/jwt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/jwt.js')>();
  return { ...actual, verifyJwt: jwtVerify.verifyJwt };
});

/** r502: registration needs step-up — these headers carry a bearer whose
 *  (mocked) session row is FRESH, the passwordless proof. */
const stepUpHeaders = () => ({ ...asUser(), authorization: 'Bearer fresh-session' });

async function app(db = createFakeDb({ findFirst: { users: userRow() } })) {
  const a = await buildTestApp({ db });
  await a.register(authRoutes);
  return a;
}

describe('auth passkey routes', () => {
  beforeEach(() => {
    sessionsMocks.findLiveSession.mockReset();
    sessionsMocks.findLiveSession.mockResolvedValue(sessionRow({ userId: 1, createdAt: new Date() }) as never);
  });

  it('starts a registration ceremony', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/passkey/register/options', headers: stepUpHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json().options).toBe('{"challenge":"r"}');
  });

  it('verifies registration and stores the credential', async () => {
    const db = createFakeDb({
      findFirst: { users: userRow() },
      insert: { webauthn_credentials: [{ id: 9, name: 'key', createdAt: new Date('2026-01-01T00:00:00Z') }] },
    });
    const res = await (await app(db)).inject({
      method: 'POST',
      url: '/passkey/register/verify',
      headers: stepUpHeaders(),
      payload: { name: 'key', response: { id: 'x' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 9, name: 'key', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('maps verification failures to 400s', async () => {
    webauthnMocks.finishRegistration.mockRejectedValueOnce(new Error('bad attestation'));
    const res = await (await app()).inject({
      method: 'POST',
      url: '/passkey/register/verify',
      headers: stepUpHeaders(),
      payload: { name: 'key', response: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('bad attestation');
  });

  it('401s the registration ceremony when the user is gone', async () => {
    const gone = await (await app(createFakeDb())).inject({
      method: 'POST',
      url: '/passkey/register/options',
      headers: asUser(),
    });
    expect(gone.statusCode).toBe(401);
  });

  it('401s registration verification when the user is gone', async () => {
    const res = await (await app(createFakeDb())).inject({
      method: 'POST',
      url: '/passkey/register/verify',
      headers: asUser(),
      payload: { name: 'key', response: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400s registration when the insert returns no row', async () => {
    const db = createFakeDb({ findFirst: { users: userRow() }, insert: { webauthn_credentials: [] } });
    const res = await (await app(db)).inject({
      method: 'POST',
      url: '/passkey/register/verify',
      headers: stepUpHeaders(),
      payload: { name: 'key', response: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Could not store passkey');
  });

  it('stringifies non-Error registration failures', async () => {
    webauthnMocks.finishRegistration.mockRejectedValueOnce('nope');
    const res = await (await app()).inject({
      method: 'POST',
      url: '/passkey/register/verify',
      headers: stepUpHeaders(),
      payload: { name: 'key', response: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Passkey verification failed');
  });

  it('401s passkey login when the user vanished after credential lookup', async () => {
    const db = createFakeDb({
      findFirst: {
        users: undefined,
        webauthnCredentials: { id: 1, userId: 1, credentialId: 'cred-1', publicKey: 'pub', counter: 0 },
      },
    });
    const res = await (await app(db)).inject({
      method: 'POST',
      url: '/passkey/login/verify',
      payload: { response: { id: 'cred-1' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('stringifies non-Error login verification failures', async () => {
    const db = createFakeDb({
      findFirst: {
        users: userRow(),
        webauthnCredentials: { id: 1, userId: 1, credentialId: 'cred-1', publicKey: 'pub', counter: 0 },
      },
    });
    webauthnMocks.finishAuthentication.mockRejectedValueOnce('bad token');
    const res = await (await app(db)).inject({
      method: 'POST',
      url: '/passkey/login/verify',
      payload: { response: { id: 'cred-1' } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Passkey verification failed');
  });

  it('flags no session without an authorization header', async () => {
    const db = createFakeDb({ findMany: { sessions: [sessionRow({ id: 1, jti: 'other' })] } });
    const res = await (await app(db)).inject({ method: 'GET', url: '/sessions', headers: asUser() });
    expect(res.json()[0].current).toBe(false);
  });

  it('lists registered passkeys', async () => {
    const db = createFakeDb({
      findFirst: { users: userRow() },
      select: {
        webauthn_credentials: [
          { id: 3, name: 'yubi', createdAt: new Date('2026-01-01T00:00:00Z') },
        ],
      },
    });
    const res = await (await app(db)).inject({ method: 'GET', url: '/passkey', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 3, name: 'yubi', createdAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('removes a passkey', async () => {
    const res = await (await app()).inject({ method: 'DELETE', url: '/passkey/3', headers: asUser() });
    expect(res.json()).toEqual({ ok: true });
  });

  it('starts a login ceremony publicly', async () => {
    const db = createFakeDb({ select: { webauthn_credentials: [] } });
    const res = await (await app(db)).inject({ method: 'POST', url: '/passkey/login/options' });
    expect(res.statusCode).toBe(200);
    expect(res.json().options).toBe('{"challenge":"a"}');
  });

  it('completes passkey login with a session', async () => {
    const db = createFakeDb({
      findFirst: {
        users: userRow(),
        webauthnCredentials: {
          id: 1,
          userId: 1,
          credentialId: 'cred-1',
          publicKey: 'pub',
          counter: 0,
          transports: '[]',
          name: 'key',
          createdAt: new Date(),
        },
      },
    });
    const res = await (await app(db)).inject({
      method: 'POST',
      url: '/passkey/login/verify',
      payload: { response: { id: 'cred-1' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      // `PublicUser` carries the workspace count and creation date now.
      user: {
        id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        isOperator: true,
        workspaceCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 900 },
    });
  });

  it('rejects a login response without a credential id', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/passkey/login/verify',
      payload: { response: {} },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid passkey response');
  });

  it('rejects an unknown credential id', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/passkey/login/verify',
      payload: { response: { id: 'ghost' } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Unknown passkey');
  });

  it('maps login verification failures to 401s', async () => {
    const db = createFakeDb({
      findFirst: {
        users: userRow(),
        webauthnCredentials: { id: 1, userId: 1, credentialId: 'cred-1', publicKey: 'pub', counter: 0 },
      },
    });
    webauthnMocks.finishAuthentication.mockRejectedValueOnce(new Error('signature mismatch'));
    const res = await (await app(db)).inject({
      method: 'POST',
      url: '/passkey/login/verify',
      payload: { response: { id: 'cred-1' } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('signature mismatch');
  });
});

describe('auth session routes', () => {
  it('lists live sessions flagged by the token jti', async () => {
    const rows = [
      sessionRow({ id: 1, jti: 'jti-1', ip: '10.0.0.1', userAgent: 'ua', lastUsedAt: null }),
      sessionRow({ id: 4, jti: 'jti-4', lastUsedAt: new Date('2026-01-02T00:00:00Z') }),
      sessionRow({ id: 5, jti: 'jti-5', lastUsedAt: null, createdAt: new Date('2026-01-04T00:00:00Z') }),
      sessionRow({ id: 2, jti: 'jti-2', revokedAt: new Date() }),
      sessionRow({ id: 3, jti: 'jti-3', expiresAt: new Date(Date.now() - 1000) }),
    ];
    const db = createFakeDb({ findMany: { sessions: rows } });
    const res = await (await app(db)).inject({
      method: 'GET',
      url: '/sessions',
      headers: { ...asUser(), authorization: 'Bearer access-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(3);
    // Exactly one row (the jti match) carries the current flag.
    expect(body.filter((r: { current: boolean }) => r.current)).toEqual([
      expect.objectContaining({ id: 1, ip: '10.0.0.1' }),
    ]);
  });

  it('flags no session when the bearer token cannot be verified', async () => {
    jwtVerify.verifyJwt.mockRejectedValueOnce(new Error('bad'));
    const db = createFakeDb({ findMany: { sessions: [sessionRow({ id: 1, jti: 'other' })] } });
    const res = await (await app(db)).inject({
      method: 'GET',
      url: '/sessions',
      headers: { ...asUser(), authorization: 'Bearer x' },
    });
    expect(res.json()[0].current).toBe(false);
  });

  it('revokes a session', async () => {
    const res = await (await app()).inject({ method: 'DELETE', url: '/sessions/4', headers: asUser() });
    expect(res.json()).toEqual({ ok: true });
  });

  it('logout also revokes every session row', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/logout', headers: asUser() });
    expect(res.json()).toEqual({ ok: true });
    expect(sessionsMocks.revokeAllSessions).toHaveBeenCalled();
  });

  // r502: a briefly stolen session could plant a passkey (a durable way back
  // in that even survives a password change). Registration now needs the
  // current password or a sign-in from the last 10 minutes.
  describe('r502: step-up for passkey registration', () => {
    it('refuses options and verify from a bare, non-fresh session', async () => {
      sessionsMocks.findLiveSession.mockResolvedValue(
        sessionRow({ userId: 1, createdAt: new Date(Date.now() - 60 * 60 * 1000) }) as never,
      );
      webauthnMocks.finishRegistration.mockClear();
      const a = await app();
      const options = await a.inject({ method: 'POST', url: '/passkey/register/options', headers: stepUpHeaders() });
      expect(options.statusCode).toBe(403);
      expect(options.json().error.code).toBe('reauth_required');
      const verify = await a.inject({
        method: 'POST',
        url: '/passkey/register/verify',
        headers: stepUpHeaders(),
        payload: { name: 'planted', response: { id: 'x' } },
      });
      expect(verify.statusCode).toBe(403);
      expect(webauthnMocks.finishRegistration).not.toHaveBeenCalled();
    });

    it('refuses a wrong password with invalid_password (403, not a session-ending 401)', async () => {
      const res = await (await app()).inject({
        method: 'POST',
        url: '/passkey/register/verify',
        headers: asUser(),
        payload: { name: 'k', response: { id: 'x' }, password: 'wrong' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('invalid_password');
    });

    it("refuses a fresh session that belongs to someone else", async () => {
      sessionsMocks.findLiveSession.mockResolvedValue(sessionRow({ userId: 99, createdAt: new Date() }) as never);
      const res = await (await app()).inject({ method: 'POST', url: '/passkey/register/options', headers: stepUpHeaders() });
      expect(res.statusCode).toBe(403);
    });

    it('accepts the current password as step-up', async () => {
      const { hashPassword } = await import('../../src/lib/crypto.js');
      const db = createFakeDb({
        findFirst: { users: userRow({ passwordHash: await hashPassword('the-real-one') }) },
        insert: { webauthn_credentials: [{ id: 5, name: 'k', createdAt: new Date('2026-01-01T00:00:00Z') }] },
      });
      sessionsMocks.findLiveSession.mockResolvedValue(null as never);
      const res = await (await app(db)).inject({
        method: 'POST',
        url: '/passkey/register/verify',
        headers: asUser(),
        payload: { name: 'k', response: { id: 'x' }, password: 'the-real-one' },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
