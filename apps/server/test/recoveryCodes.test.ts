import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, userRecoveryCodes, users } from '@ninedeploy/db';

/**
 * 0.16.3 two-factor recovery codes against a real migrated SQLite: ten are
 * handed out once when 2FA is turned on, each signs in once in place of the
 * authenticator code, a new set replaces the old one, and turning 2FA off (or
 * re-enrolling) deletes the set. TOTP verification is faked (a fresh step per
 * call); the single-use TOTP rule has its own test (lib/totpReplay).
 */

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);
const totp = vi.hoisted(() => {
  let step = 1_000_000;
  return {
    generateSecret: vi.fn(() => 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'),
    otpauthUri: vi.fn(() => 'otpauth://totp/x'),
    verifyTotpStep: vi.fn(() => ++step),
    verifyTotp: vi.fn(() => true),
  };
});
vi.mock('../src/lib/totp.js', () => totp);
vi.mock('../src/lib/jwt.js', () => ({
  signAccessToken: vi.fn(async () => 'access-token'),
  signRefreshToken: vi.fn(async () => 'refresh-token'),
  verifyJwt: vi.fn(async () => ({ type: 'refresh', sub: '1' })),
  ttlSeconds: vi.fn(() => 900),
}));
vi.mock('../src/lib/notifier.js', () => ({ sendSystemEmail: vi.fn(async () => false), notifyEvent: vi.fn(async () => undefined) }));

const { authRoutes } = await import('../src/modules/auth.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { normalizeRecoveryCode } = await import('../src/lib/recoveryCodes.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const PASSWORD = ['correct', '-horse-', 'battery'].join('');
let db: DB;
let seq = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
});

/** A user with 2FA turned on through the routes; returns the codes `enable` handed out. */
async function enrolled() {
  // A fresh address per test: the lockout counter is per (email, ip) and process-wide.
  const email = `twofa-${++seq}@example.com`;
  await db.insert(users).values({ id: 1, email, passwordHash: await hashPassword(PASSWORD) });
  const app = await buildTestApp({ db });
  await app.register(authRoutes);
  expect((await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser(), payload: { password: PASSWORD } })).statusCode).toBe(200);
  const on = await app.inject({ method: 'POST', url: '/2fa/enable', headers: asUser(), payload: { code: '123456', password: PASSWORD } });
  expect(on.statusCode).toBe(200);
  const { recoveryCodes } = on.json() as { recoveryCodes: string[] };
  const login = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/login', payload: { email, password: PASSWORD, ...payload } });
  const remaining = async () => (await app.inject({ method: 'GET', url: '/2fa/recovery-codes', headers: asUser() })).json() as { totpEnabled: boolean; remaining: number };
  const stored = async () => db.select().from(userRecoveryCodes).where(eq(userRecoveryCodes.userId, 1));
  return { app, email, recoveryCodes, login, remaining, stored };
}

describe('two-factor recovery codes', () => {
  it('enable hands out ten distinct codes, shown once and stored only as hashes', async () => {
    const { app, recoveryCodes, stored, remaining } = await enrolled();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/);
    const rows = await stored();
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(recoveryCodes.some((c) => row.codeHash.includes(c.replace(/-/g, '')))).toBe(false);
    }
    expect(await remaining()).toEqual({ totpEnabled: true, remaining: 10 });
    await app.close();
  });

  it('a code signs in once in place of the authenticator code, typed loosely', async () => {
    const { app, recoveryCodes, login, remaining } = await enrolled();
    expect((await login({})).json().error.code).toBe('totp_required');
    const loose = ` ${recoveryCodes[0]!.toUpperCase().replace(/-/g, ' ')} `;
    const ok = await login({ recoveryCode: loose });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(auditMock.audit).toHaveBeenCalledWith(db, 1, 'auth.recovery_code_used', expect.any(String), { remaining: 9 });
    expect(await remaining()).toEqual({ totpEnabled: true, remaining: 9 });

    // Spent: refused, as is a code that was never issued.
    const again = await login({ recoveryCode: recoveryCodes[0] });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('recovery_code_invalid');
    expect((await login({ recoveryCode: 'zzzz-zzzz-zzzz-zzzz' })).json().error.code).toBe('recovery_code_invalid');
    expect((await login({ recoveryCode: 'short' })).json().error.code).toBe('recovery_code_invalid');
    // A TOTP code still works, and wins when both are sent.
    expect((await login({ totpCode: '123456', recoveryCode: recoveryCodes[1] })).statusCode).toBe(200);
    expect(await remaining()).toEqual({ totpEnabled: true, remaining: 9 });
    await app.close();
  });

  it('a new set needs the password and a current code, and replaces the old one', async () => {
    const { app, recoveryCodes, login, remaining } = await enrolled();
    const regen = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/2fa/recovery-codes', headers: asUser(), payload });
    expect((await regen({ code: '123456', password: 'wrong' })).statusCode).toBe(403);
    expect((await regen({ password: PASSWORD })).statusCode).toBe(400);
    totp.verifyTotpStep.mockReturnValueOnce(null as unknown as number);
    expect((await regen({ code: '000000', password: PASSWORD })).statusCode).toBe(400);
    expect(await remaining()).toEqual({ totpEnabled: true, remaining: 10 });

    const fresh = await regen({ code: '123456', password: PASSWORD });
    expect(fresh.statusCode).toBe(200);
    const { recoveryCodes: next } = fresh.json() as { recoveryCodes: string[] };
    expect(next).toHaveLength(10);
    expect(next.some((c) => recoveryCodes.includes(c))).toBe(false);
    expect(auditMock.audit).toHaveBeenCalledWith(db, 1, 'auth.recovery_codes_regenerated', expect.any(String));
    expect((await login({ recoveryCode: recoveryCodes[2] })).statusCode).toBe(401);
    expect((await login({ recoveryCode: next[0] })).statusCode).toBe(200);
    await app.close();
  });

  it('turning 2FA off, or enrolling again, deletes the set; without 2FA there is nothing to regenerate', async () => {
    const { app, stored, remaining } = await enrolled();
    // Re-enrolment (setup with 2FA on) flips 2FA off and drops the old set.
    expect((await app.inject({ method: 'POST', url: '/2fa/setup', headers: asUser(), payload: { password: PASSWORD } })).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
    expect(await remaining()).toEqual({ totpEnabled: false, remaining: 0 });
    expect((await app.inject({ method: 'POST', url: '/2fa/recovery-codes', headers: asUser(), payload: { code: '123456', password: PASSWORD } })).statusCode).toBe(400);

    expect((await app.inject({ method: 'POST', url: '/2fa/enable', headers: asUser(), payload: { code: '123456', password: PASSWORD } })).statusCode).toBe(200);
    expect(await stored()).toHaveLength(10);
    expect((await app.inject({ method: 'POST', url: '/2fa/disable', headers: asUser(), payload: { code: '123456', password: PASSWORD } })).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
    await app.close();
  });

  it('an account that turned 2FA on before 0.16.3 has none until it generates a set, and signs in as before', async () => {
    const { app, login, remaining } = await enrolled();
    await db.delete(userRecoveryCodes);
    expect(await remaining()).toEqual({ totpEnabled: true, remaining: 0 });
    expect((await login({ totpCode: '123456' })).statusCode).toBe(200);
    expect((await login({ recoveryCode: 'abcd-efgh-jkmn-pqrs' })).statusCode).toBe(401);
    await app.close();
  });
});

describe('normalizeRecoveryCode', () => {
  it('ignores case, spaces and dashes; reads o as 0 and i/l as 1; refuses anything else', () => {
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRS')).toBe('abcdefghjkmnpqrs');
    expect(normalizeRecoveryCode('oooo iiii llll 2345')).toBe('0000111111112345');
    expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqr')).toBeNull();
    expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqru')).toBeNull();
    expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqrs-t')).toBeNull();
  });
});
