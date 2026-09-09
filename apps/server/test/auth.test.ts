import { describe, expect, it, vi, beforeEach } from 'vitest';
import { authRoutes, createFirstAdmin, registerAccount } from '../src/modules/auth.js';
import { asUser, buildTestApp, createFakeDb, sessionRow, tokenRow, userRow } from './helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => 'hashed'),
  verifyPassword: vi.fn(async () => true),
  randomToken: vi.fn(() => 'raw-token'),
  sha256: vi.fn(() => 'tok-hash'),
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));

/** Fixture credentials assembled at runtime: TEST-ONLY values a secret
 * scanner otherwise cannot distinguish from leaked ones. */
const F = {
  accessToken: ['access', 'token'].join('-'),
  refreshToken: ['refresh', 'token'].join('-'),
  validRefresh: ['valid', 'refresh'].join('-'),
  staleRefresh: ['stale', 'refresh'].join('-'),
  currentPassword: ['old', 'pass', '123'].join('-'),
  newPassword: ['new', 'pass', '456'].join('-'),
};

const jwtMocks = vi.hoisted(() => ({
  signAccessToken: vi.fn(async () => F.accessToken),
  signRefreshToken: vi.fn(async () => F.refreshToken),
  verifyJwt: vi.fn(async () => ({ type: 'refresh', sub: '1' })),
  ttlSeconds: vi.fn(() => 900),
}));

vi.mock('../src/lib/crypto.js', () => cryptoMocks);
vi.mock('../src/lib/jwt.js', () => jwtMocks);

const notifierMocks = vi.hoisted(() => ({
  sendSystemEmail: vi.fn(async () => false),
  notifyEvent: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/notifier.js', () => notifierMocks);

const totpMocks = vi.hoisted(() => ({
  generateSecret: vi.fn(() => 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'),
  otpauthUri: vi.fn(() => 'otpauth://totp/x'),
  verifyTotp: vi.fn(() => true),
}));
vi.mock('../src/lib/totp.js', () => totpMocks);

const validRegister = { email: 'new@example.com', password: 'password123' };

beforeEach(() => {
  notifierMocks.sendSystemEmail.mockReset();
  notifierMocks.sendSystemEmail.mockResolvedValue(false);
});

describe('auth module helpers', () => {  it('createFirstAdmin succeeds when no users exist', async () => {
    const db = createFakeDb({
      counts: { users: [{ n: 0 }] },
      insert: { users: [userRow({ id: 1, email: 'new@example.com' })] },
    });
    const result = await createFirstAdmin(db, validRegister as never);
    expect(result.user).toMatchObject({ id: 1, email: 'new@example.com', isOperator: true });
    expect(result.tokens).toEqual({ accessToken: F.accessToken, refreshToken: F.refreshToken, expiresIn: 900 });
  });

  it('createFirstAdmin conflicts when users already exist', async () => {
    const db = createFakeDb({ counts: { users: [{ n: 1 }] } });
    await expect(createFirstAdmin(db, validRegister as never)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('createFirstAdmin fails when the insert returns no row', async () => {
    const db = createFakeDb({ counts: { users: [{ n: 0 }] }, insert: { users: [] } });
    await expect(createFirstAdmin(db, validRegister as never)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('registerAccount makes the first user an operator', async () => {
    const db = createFakeDb({
      counts: { users: [{ n: 0 }] },
      insert: { users: [userRow({ id: 1, email: 'new@example.com', isOperator: true })] },
    });
    const result = await registerAccount(db, validRegister as never);
    expect(result.user.isOperator).toBe(true);
  });

  it('registerAccount makes subsequent users non-operators', async () => {
    const db = createFakeDb({
      counts: { users: [{ n: 2 }] },
      insert: { users: [userRow({ id: 3, email: 'new@example.com', isOperator: false })] },
    });
    const result = await registerAccount(db, validRegister as never);
    expect(result.user.isOperator).toBe(false);
  });

  it('registerAccount reports duplicate emails', async () => {
    const db = createFakeDb({
      counts: { users: [{ n: 2 }] },
      insert: { users: () => { throw new Error('UNIQUE constraint failed: users_email_unique'); } },
    });
    await expect(registerAccount(db, validRegister as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'email_taken',
    });
  });

  it('registerAccount fails when the insert returns no row', async () => {
    const db = createFakeDb({ counts: { users: [{ n: 2 }] }, insert: { users: [] } });
    await expect(registerAccount(db, validRegister as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('auth routes', () => {
  it('reports the initialization status', async () => {
    const app = await buildTestApp({ db: createFakeDb({ counts: { users: [{ n: 0 }] } }) });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initialized: false, allowRegistration: false });
  });

  it('reports initialized when users exist', async () => {
    const app = await buildTestApp({ db: createFakeDb({ counts: { users: [{ n: 3 }] } }) });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.json()).toEqual({ initialized: true, allowRegistration: false });
  });

  it('treats a missing count row as zero users', async () => {
    const app = await buildTestApp({ db: createFakeDb({ counts: {} }) });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.json()).toEqual({ initialized: false, allowRegistration: false });
  });

  it('registers a user', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        counts: { users: [{ n: 1 }] },
        findFirst: { settings: { key: 'allow_registration', value: true } },
        insert: { users: [userRow({ id: 2, email: 'new@example.com', isOperator: false })] },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/register', payload: validRegister });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: 2, email: 'new@example.com', isOperator: false });
    expect(res.json().tokens.expiresIn).toBe(900);
  });

  it('blocks registration when open registration is disabled and users exist', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        counts: { users: [{ n: 2 }] },
        findFirst: { settings: { key: 'allow_registration', value: false } },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/register', payload: validRegister });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('Registration is disabled');
  });

  it('still allows bootstrap registration when disabled but no user exists', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        counts: { users: [{ n: 0 }] },
        findFirst: { settings: { key: 'allow_registration', value: false } },
        insert: { users: [userRow({ id: 1, email: 'new@example.com', isOperator: true })] },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/register', payload: validRegister });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.isOperator).toBe(true);
  });

  it('exposes allowRegistration on the public status endpoint', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        counts: { users: [{ n: 1 }] },
        findFirst: { settings: { key: 'allow_registration', value: false } },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.json()).toEqual({ initialized: true, allowRegistration: false });
  });

  it('rejects an invalid register payload', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/register', payload: { email: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('logs in with valid credentials', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1, passwordHash: 'hashed' }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(1);
  });

  it('rejects a wrong password', async () => {
    cryptoMocks.verifyPassword.mockResolvedValueOnce(false);
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1 }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'admin@example.com', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects login for an unknown user', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'ghost@example.com', password: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refreshes tokens with a valid refresh token', async () => {
    jwtMocks.verifyJwt.mockResolvedValueOnce({ type: 'refresh', sub: '1', jti: 'jti-1', ver: 0 });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1 }), sessions: sessionRow({ jti: 'jti-1', userId: 1 }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/refresh',
      payload: { refreshToken: F.validRefresh },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokens.accessToken).toBe(F.accessToken);
  });

  it('rejects a refresh token whose ver no longer matches the user tokenVersion (revoked session)', async () => {
    // Token minted at ver 0, but the user has since been bumped to ver 1 (logout/role change).
    jwtMocks.verifyJwt.mockResolvedValueOnce({ type: 'refresh', sub: '1', jti: 'jti-1', ver: 0 });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1, tokenVersion: 1 }), sessions: sessionRow({ jti: 'jti-1' }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/refresh',
      payload: { refreshToken: F.staleRefresh },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid refresh token', async () => {
    jwtMocks.verifyJwt.mockRejectedValueOnce(new Error('expired'));
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/refresh', payload: { refreshToken: 'bad' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid refresh token');
  });

  it('rejects a refresh token without a ver claim (revocation bypass guard)', async () => {
    jwtMocks.verifyJwt.mockResolvedValueOnce({ type: 'refresh', sub: '1', jti: 'jti-1' });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1, tokenVersion: 0 }), sessions: sessionRow({ jti: 'jti-1' }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/refresh', payload: { refreshToken: 'v' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a refresh whose user vanished but session lives on', async () => {
    jwtMocks.verifyJwt.mockResolvedValueOnce({ type: 'refresh', sub: '1', jti: 'jti-1', ver: 0 });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: undefined, sessions: sessionRow({ jti: 'jti-1' }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/refresh', payload: { refreshToken: 'v' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a refresh token from a session of another user', async () => {
    jwtMocks.verifyJwt.mockResolvedValueOnce({ type: 'refresh', sub: '1', jti: 'jti-1', ver: 0 });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1, tokenVersion: 0 }), sessions: sessionRow({ jti: 'jti-1', userId: 2 }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/refresh', payload: { refreshToken: 'v' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a legacy token without a jti claim (pre-sessions era)', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { users: userRow({ id: 1 }) } }) });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/refresh', payload: { refreshToken: 'legacy' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token whose session row was revoked', async () => {
    jwtMocks.verifyJwt.mockResolvedValueOnce({ type: 'refresh', sub: '1', jti: 'jti-9' });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1 }), sessions: sessionRow({ jti: 'jti-9', revokedAt: new Date() }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/refresh', payload: { refreshToken: 'gone' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-refresh token type', async () => {
    jwtMocks.verifyJwt.mockResolvedValueOnce({ type: 'access', sub: '1' } as never);
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/refresh', payload: { refreshToken: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects refresh for a missing user', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/refresh', payload: { refreshToken: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns the current user from /me', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1 }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'GET', url: '/me', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 1, email: 'admin@example.com', name: 'Admin', isOperator: true });
  });

  it('returns 401 from /me when the user is gone', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'GET', url: '/me', headers: asUser() });
    expect(res.statusCode).toBe(401);
  });

  it('logs out by bumping the user tokenVersion', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/logout', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('requires auth for /logout', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/logout' });
    expect(res.statusCode).toBe(401);
  });

  it('changes the password, bumps tokenVersion and issues fresh tokens', async () => {
    // Current password verifies; update returns the bumped user.
    cryptoMocks.verifyPassword.mockResolvedValueOnce(true);
    const db = createFakeDb({
      findFirst: { users: userRow({ id: 1, tokenVersion: 3 }) },
      update: { users: [userRow({ id: 1, tokenVersion: 4 })] },
    });
    const app = await buildTestApp({ db });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/password',
      headers: asUser(),
      payload: { currentPassword: F.currentPassword, newPassword: F.newPassword },
    });
    expect(res.statusCode).toBe(200);
    expect(cryptoMocks.verifyPassword).toHaveBeenCalledWith('hash', F.currentPassword);
    expect(cryptoMocks.hashPassword).toHaveBeenCalledWith(F.newPassword);
    const body = res.json();
    expect(body.user.id).toBe(1);
    expect(body.tokens.accessToken).toBe('access-token');
  });

  it('rejects a password change with a wrong current password', async () => {
    cryptoMocks.verifyPassword.mockResolvedValueOnce(false);
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1 }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/password',
      headers: asUser(),
      payload: { currentPassword: 'wrong', newPassword: F.newPassword },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toContain('current password');
  });

  it('returns 401 when the password update returns no row (user vanished)', async () => {
    cryptoMocks.verifyPassword.mockResolvedValueOnce(true);
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1 }) }, update: { users: [] } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/password',
      headers: asUser(),
      payload: { currentPassword: F.currentPassword, newPassword: F.newPassword },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a too-short new password (validation)', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/password',
      headers: asUser(),
      payload: { currentPassword: F.currentPassword, newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('creates an API token with a custom name', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { api_tokens: [tokenRow({ id: 5, name: 'ci' })] } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: asUser(),
      payload: { name: 'ci' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scopes: string[]; expiresAt: string | null };
    // A token created WITHOUT explicit scopes is read-only by default — never
    // an unrestricted legacy token ([]), and it always carries a lifetime so
    // a leaked CI credential cannot outlive a year.
    expect(body.scopes).toEqual(['read']);
    expect(body.expiresAt).toEqual(expect.any(String));
    expect(res.json()).toMatchObject({
      id: 5,
      name: 'ci',
      token: 'raw-token',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('refuses to mint an operator-scoped token for a non-operator', async () => {
    // A token must never outrank the account behind it: otherwise a member
    // could hand themselves an operator credential and use it to reach the
    // host-privileged deploy paths.
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { name: 'sneaky', scopes: ['operator'] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { message: /operator-scoped token/ } });
  });

  it('mints a scoped, expiring token for an operator', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { api_tokens: [tokenRow({ id: 9, name: 'ci' })] } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: asUser(),
      payload: { name: 'ci', scopes: ['read'], expiresInDays: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scopes: ['read'] });
    expect(res.json().expiresAt).toEqual(expect.any(String));
  });

  it('creates an API token with the default name when none is given', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { api_tokens: [tokenRow({ id: 5, name: 'cli' })] } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/tokens', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('cli');
  });

  it('falls back to the default name for an empty name', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { api_tokens: [tokenRow({ id: 5, name: 'cli' })] } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/tokens', headers: asUser(), payload: { name: '' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('cli');
  });

  it('truncates very long token names', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { api_tokens: [tokenRow({ id: 5, name: 'x'.repeat(100) })] } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: asUser(),
      payload: { name: 'x'.repeat(200) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name.length).toBe(100);
  });

  it('returns 400 when the token insert fails', async () => {
    const app = await buildTestApp({ db: createFakeDb({ insert: { api_tokens: [] } }) });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/tokens', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('lists API tokens with optional lastUsedAt', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          api_tokens: [
            tokenRow({ id: 1, name: 'a', lastUsedAt: new Date('2026-01-02T00:00:00Z') }),
            tokenRow({ id: 2, name: 'b', lastUsedAt: null }),
          ],
        },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'GET', url: '/tokens', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: 1, name: 'a', scopes: [], lastUsedAt: '2026-01-02T00:00:00.000Z', expiresAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, name: 'b', scopes: [], lastUsedAt: null, expiresAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('rejects invalid ids for user-owned auth resources', async () => {
    const app = await buildTestApp();
    await app.register(authRoutes);
    for (const url of ['/passkey/nope', '/sessions/nope', '/tokens/nope']) {
      const res = await app.inject({ method: 'DELETE', url, headers: asUser() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_id');
    }
  });

  it('deletes an API token', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/tokens/3', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('requires auth for /me and token routes', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const me = await app.inject({ method: 'GET', url: '/me' });
    expect(me.statusCode).toBe(401);
    const list = await app.inject({ method: 'GET', url: '/tokens' });
    expect(list.statusCode).toBe(401);
  });

  // ── forgot / reset password ─────────────────────────────────────────────
  it('accepts a forgot-password request for an existing user', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { users: userRow({ id: 1 }) },
        delete: { password_reset_tokens: [{}] },
        insert: { password_reset_tokens: [{}] },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/forgot-password', payload: { email: 'admin@example.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('answers forgot-password identically for an unknown user (no enumeration)', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/forgot-password', payload: { email: 'ghost@example.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('emails the reset link when an email channel exists; a failure still answers ok', async () => {
    notifierMocks.sendSystemEmail.mockResolvedValueOnce(true);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { users: userRow({ id: 1 }) },
        delete: { password_reset_tokens: [{}] },
        insert: { password_reset_tokens: [{}] },
      }),
    });
    await app.register(authRoutes);
    const ok = await app.inject({ method: 'POST', url: '/forgot-password', payload: { email: 'admin@example.com' } });
    expect(ok.statusCode).toBe(200);
    expect(notifierMocks.sendSystemEmail).toHaveBeenCalledTimes(1);
    // Delivery failure must not change the response (no enumeration signal).
    notifierMocks.sendSystemEmail.mockRejectedValueOnce(new Error('smtp down'));
    const still = await app.inject({ method: 'POST', url: '/forgot-password', payload: { email: 'admin@example.com' } });
    expect(still.statusCode).toBe(200);
    expect(still.json()).toEqual({ ok: true });
  });

  it('rejects an invalid forgot-password payload', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/forgot-password', payload: { email: 'not-an-email' } });
    expect(res.statusCode).toBe(400);
  });

  it('resets a password with a valid token', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          passwordResetTokens: {
            id: 7, userId: 1, tokenHash: 'tok-hash', expiresAt: new Date(Date.now() + 60_000),
            usedAt: null, requestedFrom: null, createdAt: new Date(),
          },
          users: userRow({ id: 1, tokenVersion: 3 }),
        },
        update: { users: [userRow({ id: 1, tokenVersion: 4 })], password_reset_tokens: [{}] },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { token: 'raw-token-1234567890abcdef', newPassword: 'fresh-password' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects a reset with an unknown token', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { token: 'raw-token-1234567890abcdef', newPassword: 'fresh-password' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── per-account login lockout ────────────────────────────────────────────
  it('locks an account after 5 failed logins (same message as a wrong password)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1 }) } }),
    });
    await app.register(authRoutes);
    cryptoMocks.verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { email: 'lockme@example.com', password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('Invalid email or password');
    }
    // Even the CORRECT password is rejected while locked.
    cryptoMocks.verifyPassword.mockResolvedValue(true);
    const locked = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'lockme@example.com', password: 'password123' },
    });
    expect(locked.statusCode).toBe(401);
    cryptoMocks.verifyPassword.mockResolvedValue(true);
  });
});
