import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, hashPassword, randomToken, reencrypt, sha256, verifyPassword } from '../src/lib/crypto.js';
import { isLocked, recordFailure, recordSuccess } from '../src/lib/loginLockout.js';
import { globToRegExp, matchesAny, parseWatchPaths } from '../src/lib/glob.js';
import { base32Decode, base32Encode, generateSecret, otpauthUri, totpAt, verifyTotp } from '../src/lib/totp.js';
import { spawnValidated } from '../src/lib/spawnValidated.js';
import { badRequest, notFound, unauthorized, forbidden } from '../src/lib/errors.js';
import { iso, isoDate, listResponse } from '../src/lib/serialize.js';

describe('Edge Cases — Crypto & Password Hashing', () => {
  it('handles empty string and unicode payloads safely', () => {
    const encEmpty = encrypt('');
    expect(decrypt(encEmpty)).toBe('');

    const unicode = '🔒 🚀 NineDeploy — Türkiye 🇹🇷 / 𠜎 𠜱';
    const encUnicode = encrypt(unicode);
    expect(decrypt(encUnicode)).toBe(unicode);
  });

  it('re-encrypts ciphertext and maintains envelope format', () => {
    const original = 'my-secret-key';
    const enc = encrypt(original);
    const reenc = reencrypt(enc);
    expect(decrypt(reenc)).toBe(original);
  });

  it('generates unpredictable random tokens with custom byte length', () => {
    const t1 = randomToken(16);
    const t2 = randomToken(16);
    expect(t1).not.toBe(t2);
    expect(t1.length).toBeGreaterThan(16);
  });

  it('hashes passwords with Argon2id and verifies safely', async () => {
    const hash = await hashPassword('my-secure-password');
    expect(hash.startsWith('$argon2')).toBe(true);
    expect(await verifyPassword(hash, 'my-secure-password')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
    expect(await verifyPassword('invalid-hash', 'password')).toBe(false);
  });

  it('computes deterministic SHA-256 digests', () => {
    expect(sha256('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('Edge Cases — Login Lockout & Brute-force Tracking', () => {
  const testEmail = 'attacker@example.com';

  it('does not lock user before 5 failed attempts', () => {
    recordSuccess(testEmail);
    expect(isLocked(testEmail)).toBe(false);

    for (let i = 1; i < 5; i++) {
      const locked = recordFailure(testEmail);
      expect(locked).toBe(false);
      expect(isLocked(testEmail)).toBe(false);
    }
  });

  it('locks account on 5th consecutive failure; a lock outlives a later success (r160)', () => {
    recordSuccess(testEmail);
    for (let i = 1; i < 5; i++) {
      recordFailure(testEmail);
    }
    const locked = recordFailure(testEmail);
    expect(locked).toBe(true);
    expect(isLocked(testEmail)).toBe(true);

    // A lock runs to its expiry — a success must not lift it early.
    recordSuccess(testEmail);
    expect(isLocked(testEmail)).toBe(true);
  });
});

describe('Edge Cases — Glob & Monorepo Watch Paths', () => {
  it('matches complex glob expressions with leading / trailing slashes', () => {
    const patterns = ['apps/server/**', 'packages/**'];
    expect(matchesAny('apps/server/src/index.ts', patterns)).toBe(true);
    expect(matchesAny('/packages/sdk/src/client.ts', patterns)).toBe(true);
    expect(matchesAny('website/src/App.tsx', patterns)).toBe(false);
  });

  it('parses multi-line and comma-delimited watch paths cleanly', () => {
    expect(parseWatchPaths(null)).toEqual([]);
    expect(parseWatchPaths('')).toEqual([]);
    expect(parseWatchPaths('apps/server/**, packages/sdk/**\nwebsite/**')).toEqual([
      'apps/server/**',
      'packages/sdk/**',
      'website/**',
    ]);
  });

  it('correctly matches wildcard and single character glob patterns', () => {
    const re = globToRegExp('src/?/index.*');
    expect(re.test('src/a/index.ts')).toBe(true);
    expect(re.test('src/ab/index.ts')).toBe(false);
  });
});

describe('Edge Cases — TOTP 2FA Verification Windows', () => {
  const secret = 'JBSWY3DPEHPK3PXP'; // Base32 test secret

  it('accepts tokens within T, T-1, and T+1 clock-skew windows', () => {
    const now = Date.now();
    const currentToken = totpAt(secret, now);
    expect(verifyTotp(secret, currentToken, now)).toBe(true);

    const prevToken = totpAt(secret, now - 30_000);
    expect(verifyTotp(secret, prevToken, now)).toBe(true);

    const nextToken = totpAt(secret, now + 30_000);
    expect(verifyTotp(secret, nextToken, now)).toBe(true);
  });

  it('rejects tokens outside the acceptable ±1 step window', () => {
    const now = Date.now();
    const expiredToken = totpAt(secret, now - 90_000);
    expect(verifyTotp(secret, expiredToken, now)).toBe(false);

    const farFutureToken = totpAt(secret, now + 90_000);
    expect(verifyTotp(secret, farFutureToken, now)).toBe(false);
  });

  it('returns false on malformed or empty token strings', () => {
    expect(verifyTotp(secret, '')).toBe(false);
    expect(verifyTotp(secret, 'abc')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
  });

  it('generates valid secret and otpauth URI with custom parameters', () => {
    const generated = generateSecret();
    expect(generated.length).toBeGreaterThan(16);
    expect(base32Decode(base32Encode(Buffer.from('test'))).toString()).toBe('test');

    const uri = otpauthUri(secret, 'admin@example.com', 'NineDeploy');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
  });
});

describe('Edge Cases — Spawn Validation Output Handlers', () => {
  it('collects streamed output lines and resolves exit code', async () => {
    const lines: string[] = [];
    const onLine = (l: string) => lines.push(l);

    const code = await spawnValidated('git', ['--version'], onLine);
    expect(code).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('git version'))).toBe(true);
  });
});

describe('Edge Cases — Serialization & HTTP Error Codes', () => {
  it('serializes standard NineDeploy errors with exact HTTP status codes', () => {
    expect(badRequest('invalid input').statusCode).toBe(400);
    expect(unauthorized('no token').statusCode).toBe(401);
    expect(forbidden('denied').statusCode).toBe(403);
    expect(notFound('missing').statusCode).toBe(404);
  });

  it('formats dates and list envelopes consistently with edge inputs', () => {
    expect(iso(null)).toBeNull();
    expect(iso(undefined)).toBeNull();
    expect(isoDate(null)).toBeNull();

    const d = new Date('2026-08-18T12:00:00.000Z');
    expect(iso(d)).toBe('2026-08-18T12:00:00.000Z');
    expect(isoDate(d)).toBe('2026-08-18');

    expect(listResponse(['a', 'b'])).toEqual({ items: ['a', 'b'], total: 2 });
    expect(listResponse(['a'], 10)).toEqual({ items: ['a'], total: 10 });
  });
});
