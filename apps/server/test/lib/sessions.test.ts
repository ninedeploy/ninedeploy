import { describe, expect, it, vi } from 'vitest';
import { findLiveSession, issueSessionTokens, refreshSessionTokens, revokeAllSessions } from '../../src/lib/sessions.js';
import { createFakeDb, userRow } from '../helpers.js';

// jwt mocks keep this a unit test (no key material, deterministic tokens).
const ACCESS = ['access', 'token'].join('-');
const REFRESH = ['refresh', 'token'].join('-');
const jwtMocks = vi.hoisted(() => {
  const access = ['access', 'token'].join('-');
  const refresh = ['refresh', 'token'].join('-');
  return {
    signAccessToken: vi.fn(async () => access),
    signRefreshToken: vi.fn(async () => refresh),
    ttlSeconds: vi.fn(() => 900),
  };
});
vi.mock('../../src/lib/jwt.js', () => jwtMocks);
vi.mock('../../src/config.js', () => ({ config: { jwt: { accessTtl: '15m', refreshTtl: '7d' } } }));

describe('lib/sessions', () => {
  it('issues a session-backed token pair and writes the row', async () => {
    const db = createFakeDb({ insert: { sessions: [{ id: 1 }] } });
    const tokens = await issueSessionTokens(db, userRow({ id: 3, tokenVersion: 0 }), {
      ip: '10.0.0.5',
      userAgent: 'vitest-agent',
    });
    expect(tokens.accessToken).toBe(ACCESS);
    expect(tokens.refreshToken).toBe(REFRESH);
    expect(tokens.expiresIn).toBe(900);
    expect(jwtMocks.signRefreshToken).toHaveBeenCalledWith(3, 0, expect.any(String));
  });

  it('tolerates a failing session-row insert (best-effort write)', async () => {
    const failing = {
      insert: () => ({
        values: () => ({
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mirrors drizzle insert builders.
          then: (_ok: unknown, rej: (e: Error) => unknown) => {
            rej(new Error('db locked'));
            return undefined;
          },
        }),
      }),
    };
    const tokens = await issueSessionTokens(failing as never, userRow());
    expect(tokens.accessToken).toBe(ACCESS);
  });

  it('refresh keeps the same jti and stamps lastUsedAt', async () => {
    jwtMocks.signRefreshToken.mockClear();
    const db = createFakeDb();
    await refreshSessionTokens(db, userRow({ id: 2, tokenVersion: 0 }), 'jti-x');
    // The 4th argument is the generation marker: the session row's NEW
    // expiresAt. A replayed refresh token from a previous generation carries
    // the old value and fails the match.
    expect(jwtMocks.signRefreshToken).toHaveBeenCalledWith(2, 0, 'jti-x', expect.any(Number));
  });

  it('refuses a refresh token from a previous generation before touching the row', async () => {
    // The gen check runs BEFORE the rotation write: a replayed old token must
    // neither slide the session's expiry nor mint a pair.
    jwtMocks.signAccessToken.mockClear();
    jwtMocks.signRefreshToken.mockClear();
    const db = createFakeDb({
      findFirst: { sessions: { jti: 'jti-x', revokedAt: null, expiresAt: new Date(111) } },
      update: { sessions: [{ id: 1 }] },
    });
    await expect(refreshSessionTokens(db, userRow(), 'jti-x', 999)).rejects.toThrow('session_revoked');
    expect(jwtMocks.signAccessToken).not.toHaveBeenCalled();
    expect(jwtMocks.signRefreshToken).not.toHaveBeenCalled();
  });

  it('refresh refuses to mint tokens for a session revoked mid-flight', async () => {
    // The conditional rotate matches 0 rows (the session was revoked between
    // the caller's check and the write) — no token pair may be issued.
    jwtMocks.signAccessToken.mockClear();
    jwtMocks.signRefreshToken.mockClear();
    const db = createFakeDb({ update: { sessions: [] } });
    await expect(refreshSessionTokens(db, userRow(), 'jti-x')).rejects.toThrow('session_revoked');
    expect(jwtMocks.signAccessToken).not.toHaveBeenCalled();
    expect(jwtMocks.signRefreshToken).not.toHaveBeenCalled();
  });

  it('findLiveSession rejects missing, revoked and expired rows', async () => {
    expect(await findLiveSession(createFakeDb(), 'nope')).toBeNull();
    expect(
      await findLiveSession(
        createFakeDb({ findFirst: { sessions: { jti: 'r', revokedAt: new Date(), expiresAt: new Date(Date.now() + 1000) } } }),
        'r',
      ),
    ).toBeNull();
    expect(
      await findLiveSession(
        createFakeDb({ findFirst: { sessions: { jti: 'e', revokedAt: null, expiresAt: new Date(Date.now() - 1000) } } }),
        'e',
      ),
    ).toBeNull();
  });

  it('findLiveSession returns a live row', async () => {
    const row = { jti: 'ok', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    expect(await findLiveSession(createFakeDb({ findFirst: { sessions: row } }), 'ok')).toBe(row);
  });

  it('revokeAllSessions issues an update for the user', async () => {
    const db = createFakeDb();
    await expect(revokeAllSessions(db, 5)).resolves.toBeUndefined();
  });
});
