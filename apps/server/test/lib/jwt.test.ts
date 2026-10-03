import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { config } from '../../src/config.js';
import { signAccessToken, signRefreshToken, ttlSeconds, verifyJwt } from '../../src/lib/jwt.js';

const secret = new TextEncoder().encode(config.jwt.secret);

/** Build a token directly with jose using the same secret jwt.ts uses. */
async function rawToken(claims: { type?: string; sub?: string }, expiry: string) {
  let jwt = new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub ?? '1');
  if (expiry !== 'none') jwt = jwt.setExpirationTime(expiry);
  return jwt.sign(secret);
}

describe('jwt', () => {
  it('signs and verifies an access token', async () => {
    const token = await signAccessToken(42);
    const payload = await verifyJwt(token);
    expect(payload.jti).toBeUndefined();
    expect(payload.sub).toBe('42');
    expect(payload.type).toBe('access');
  });

  it('signs and verifies a refresh token', async () => {
    const token = await signRefreshToken(7);
    const payload = await verifyJwt(token);
    expect(payload.sub).toBe('7');
    expect(payload.type).toBe('refresh');
    // Session-carrying variants include both the version and the jti.
    const sessionToken = await signRefreshToken(7, 3, 'jti-x');
    expect(await verifyJwt(sessionToken)).toMatchObject({ ver: 3, jti: 'jti-x' });
    const access = await signAccessToken(7, 3, 'jti-x');
    expect(await verifyJwt(access)).toMatchObject({ ver: 3, jti: 'jti-x' });
  });

  it('rejects an expired token', async () => {
    const token = await rawToken({ type: 'access' }, '-10s');
    await expect(verifyJwt(token)).rejects.toThrow();
  });

  it('rejects a malformed token', async () => {
    await expect(verifyJwt('not.a.jwt')).rejects.toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const other = new TextEncoder().encode('a-different-secret-for-signing-xxxx');
    const token = await new SignJWT({ type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('1')
      .setExpirationTime('1h')
      .sign(other);
    await expect(verifyJwt(token)).rejects.toThrow();
  });

  it('verifies a token with no expiration when claims are valid', async () => {
    const token = await rawToken({ type: 'access' }, 'none');
    const payload = await verifyJwt(token);
    expect(payload.type).toBe('access');
  });
});

describe('ttlSeconds', () => {
  it('parses supported units', () => {
    expect(ttlSeconds('30s')).toBe(30);
    expect(ttlSeconds('15m')).toBe(900);
    expect(ttlSeconds('2h')).toBe(7200);
    expect(ttlSeconds('7d')).toBe(604800);
    expect(ttlSeconds('1d')).toBe(86400);
  });

  it('tolerates whitespace between number and unit', () => {
    expect(ttlSeconds('5 m')).toBe(300);
  });

  it('falls back to 900 for unparseable input', () => {
    expect(ttlSeconds('abc')).toBe(900);
    expect(ttlSeconds('')).toBe(900);
    expect(ttlSeconds('15')).toBe(900);
    expect(ttlSeconds('15y')).toBe(900);
  });
});
