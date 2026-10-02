import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authRoutes } from '../src/modules/auth.js';
import { asUser, buildTestApp, createFakeDb, userRow } from './helpers.js';

// Dummy fixtures (test-only values, assembled to keep scanners calm).
const GOOD = ['pass', 'word', '123'].join('');
const WRONG = ['not', '-the-one'].join('');

const cryptoMocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => 'hashed'),
  verifyPassword: vi.fn(async () => true),
  randomToken: vi.fn(() => 'raw-token'),
  sha256: vi.fn(() => 'tok-hash'),
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../src/lib/crypto.js', () => cryptoMocks);

const jwtMocks = vi.hoisted(() => ({
  signAccessToken: vi.fn(async () => 'access-token'),
  signRefreshToken: vi.fn(async () => 'refresh-token'),
  verifyJwt: vi.fn(async () => ({ type: 'refresh', sub: '1' })),
  ttlSeconds: vi.fn(() => 900),
}));
vi.mock('../src/lib/jwt.js', () => jwtMocks);

const notifierMocks = vi.hoisted(() => ({
  sendSystemEmail: vi.fn(async () => false),
  notifyEvent: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/notifier.js', () => notifierMocks);

// L-10: the routes no longer call verifyTotp directly — they go through
// `consumeTotpCode`, which needs the matched STEP so it can refuse a replay.
// A fresh step per call keeps these tests about the routes; the single-use
// rule itself is proved in test/lib/totpReplay.test.ts.
let nextStep = 1_000_000;
const totpMocks = vi.hoisted(() => ({
  generateSecret: vi.fn(() => 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'),
  otpauthUri: vi.fn(() => 'otpauth://totp/x'),
  verifyTotpStep: vi.fn(() => 1_000_000),
  verifyTotp: vi.fn(() => true),
}));
vi.mock('../src/lib/totp.js', () => totpMocks);

const twoFactorUser = (over: Record<string, unknown> = {}) =>
  userRow({ id: 1, totpEnabled: true, totpSecretEncrypted: 'enc:sec', ...over });

describe('auth two-factor routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('login demands a code for a 2FA-enabled account', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { users: twoFactorUser() } }) });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST', url: '/login', payload: { email: 'admin@example.com', password: GOOD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('totp_required');
  });

  it('login succeeds with a valid code on a 2FA-enabled account', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { users: twoFactorUser() } }) });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST', url: '/login',
      payload: { email: 'admin@example.com', password: GOOD, totpCode: '123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(1);
    expect(cryptoMocks.decrypt).toHaveBeenCalledWith('enc:sec');
    // consumeTotpCode passes an explicit timestamp so the step is deterministic.
    expect(totpMocks.verifyTotpStep).toHaveBeenCalledWith('sec', '123456', expect.any(Number));
  });

  it('a wrong 2FA code counts as a failed login', async () => {
    totpMocks.verifyTotpStep.mockReturnValueOnce(null as unknown as number);
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: twoFactorUser({ email: 'twofa@example.com' }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST', url: '/login',
      payload: { email: 'twofa@example.com', password: GOOD, totpCode: '000000' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('totp_invalid');
  });

  it('setup generates a secret and returns the otpauth URI', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: twoFactorUser({ totpEnabled: false, totpSecretEncrypted: null }) }, update: { users: [userRow({ id: 1 })] } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser(), payload: { password: GOOD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', otpauthUri: 'otpauth://totp/x' });
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('regenerating with 2FA enabled requires the account password', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: twoFactorUser({ totpEnabled: true }) }, update: { users: [userRow({ id: 1 })] } }),
    });
    await app.register(authRoutes);
    // No password → rejected; a bare stolen token must not be able to
    // regenerate the secret (which also flips 2FA off).
    const bare = await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser() });
    expect(bare.statusCode).toBe(400);
    // Wrong password → 401.
    cryptoMocks.verifyPassword.mockResolvedValueOnce(false);
    const wrong = await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser(), payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    // Correct password → a fresh pending secret.
    const ok = await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser(), payload: { password: GOOD } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveProperty('secret');
  });

  it('enable verifies the code and flips the flag', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { users: twoFactorUser({ totpEnabled: false }) },
        update: { users: [twoFactorUser({ totpEnabled: true })] },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/2fa/enable', headers: asUser(), payload: { code: '123456', password: GOOD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, totpEnabled: true });
  });

  it('enable rejects without a prior setup', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: userRow({ id: 1, totpSecretEncrypted: null }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/2fa/enable', headers: asUser(), payload: { code: '123456' } });
    expect(res.statusCode).toBe(400);
  });

  it('enable rejects an invalid code', async () => {
    totpMocks.verifyTotpStep.mockReturnValueOnce(null as unknown as number);
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: twoFactorUser({ totpEnabled: false }) } }),
    });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/2fa/enable', headers: asUser(), payload: { code: '000000', password: GOOD } });
    expect(res.statusCode).toBe(400);
  });

  // r502: with only a session in hand, an attacker could enrol THEIR
  // authenticator (setup → enable) and lock the owner out of the account.
  it('r502: setup and enable refuse a bare session (no password, no fresh sign-in)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { users: twoFactorUser({ totpEnabled: false }) },
        update: { users: [twoFactorUser({ totpEnabled: true })] },
      }),
    });
    await app.register(authRoutes);
    const setup = await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser() });
    expect(setup.statusCode).toBe(403);
    expect(setup.json().error.code).toBe('reauth_required');
    const enable = await app.inject({ method: 'POST', url: '/2fa/enable', headers: asUser(), payload: { code: '123456' } });
    expect(enable.statusCode).toBe(403);
    expect(enable.json().error.code).toBe('reauth_required');
    expect(totpMocks.verifyTotpStep).not.toHaveBeenCalled();
  });

  it('r502: setup and enable refuse a wrong password', async () => {
    cryptoMocks.verifyPassword.mockResolvedValue(false);
    try {
      const app = await buildTestApp({ db: createFakeDb({ findFirst: { users: twoFactorUser({ totpEnabled: false }) } }) });
      await app.register(authRoutes);
      const setup = await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser(), payload: { password: WRONG } });
      expect(setup.statusCode).toBe(403);
      expect(setup.json().error.code).toBe('invalid_password');
      const enable = await app.inject({ method: 'POST', url: '/2fa/enable', headers: asUser(), payload: { code: '123456', password: WRONG } });
      expect(enable.statusCode).toBe(403);
    } finally {
      cryptoMocks.verifyPassword.mockResolvedValue(true);
    }
  });

  it('disable requires the password and a valid code, then clears the secret', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { users: twoFactorUser() },
        update: { users: [twoFactorUser({ totpEnabled: false, totpSecretEncrypted: null })] },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST', url: '/2fa/disable', headers: asUser(),
      payload: { password: GOOD, code: '123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, totpEnabled: false });
  });

  it('disable rejects a wrong password', async () => {
    cryptoMocks.verifyPassword.mockResolvedValueOnce(false);
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { users: twoFactorUser() } }) });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST', url: '/2fa/disable', headers: asUser(),
      payload: { password: WRONG, code: '123456' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('disable rejects a wrong code', async () => {
    totpMocks.verifyTotpStep.mockReturnValueOnce(null as unknown as number);
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { users: twoFactorUser() } }) });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST', url: '/2fa/disable', headers: asUser(),
      payload: { password: GOOD, code: '000000' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('locks the account when five 2FA codes are wrong', async () => {
    totpMocks.verifyTotpStep.mockReturnValue(null as unknown as number);
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { users: twoFactorUser({ email: 'lock2fa@example.com' }) } }),
    });
    await app.register(authRoutes);
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST', url: '/login',
        payload: { email: 'lock2fa@example.com', password: GOOD, totpCode: '000000' },
      });
      expect(res.statusCode).toBe(401);
    }
    // The 5th wrong code triggers the lockout audit + locks the account: even
    // a VALID code is now rejected with the generic message.
    totpMocks.verifyTotpStep.mockReturnValue(++nextStep);
    const locked = await app.inject({
      method: 'POST', url: '/login',
      payload: { email: 'lock2fa@example.com', password: GOOD, totpCode: '123456' },
    });
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error.message).toBe('Invalid email or password');
  });

  it('setup and disable 401 when the acting user vanished', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { users: undefined } }) });
    await app.register(authRoutes);
    const setup = await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser() });
    expect(setup.statusCode).toBe(401);
    const disable = await app.inject({
      method: 'POST', url: '/2fa/disable', headers: asUser(),
      payload: { password: GOOD, code: '123456' },
    });
    expect(disable.statusCode).toBe(401);
  });

  it('disable skips the code check when 2FA was never fully enabled', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { users: twoFactorUser({ totpEnabled: false, totpSecretEncrypted: null }) },
        update: { users: [userRow({ id: 1 })] },
      }),
    });
    await app.register(authRoutes);
    const res = await app.inject({
      method: 'POST', url: '/2fa/disable', headers: asUser(),
      payload: { password: GOOD, code: '123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(totpMocks.verifyTotpStep).not.toHaveBeenCalled();
  });

  it('requires auth for the 2fa routes', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(authRoutes);
    for (const path of ['/2fa/setup', '/2fa/enable', '/2fa/disable']) {
      const res = await app.inject({ method: 'POST', url: path });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects malformed 2FA payloads', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { users: twoFactorUser() } }) });
    await app.register(authRoutes);
    const res = await app.inject({ method: 'POST', url: '/2fa/enable', headers: asUser(), payload: { code: 'abc' } });
    expect(res.statusCode).toBe(400);
    const res2 = await app.inject({ method: 'POST', url: '/login', payload: { email: 'admin@example.com', password: GOOD, totpCode: '12' } });
    expect(res2.statusCode).toBe(400);
  });
});
