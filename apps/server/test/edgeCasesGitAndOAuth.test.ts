import { describe, expect, it, vi } from 'vitest';
import {
  generateOAuthState,
  verifyOAuthState,
} from '../src/lib/oauth.js';
import {
  findLiveSession,
  issueSessionTokens,
  refreshSessionTokens,
  revokeAllSessions,
} from '../src/lib/sessions.js';

describe('Edge Cases — OAuth & OIDC CSRF State Protection', () => {
  it('generates tamper-proof signed state parameters and verifies them', () => {
    const state = generateOAuthState('google-sso', '/dashboard');
    expect(state).toContain('.');

    const verified = verifyOAuthState(state);
    expect(verified).toEqual({ slug: 'google-sso', returnTo: '/dashboard' });
  });

  it('rejects tampered, malformed, and expired OAuth states', () => {
    // 1. Missing signature
    expect(verifyOAuthState('invalid-state-without-dot')).toBeNull();

    // 2. Tampered signature
    const validState = generateOAuthState('github', '/');
    const [payload, sig] = validState.split('.');
    const tamperedSig = `${sig!.slice(0, -2)}aa`;
    expect(verifyOAuthState(`${payload}.${tamperedSig}`)).toBeNull();

    // 3. Expired state (older than 15 minutes)
    const expiredPayload = Buffer.from(
      JSON.stringify({ slug: 'github', returnTo: '/', nonce: '123', ts: Date.now() - 20 * 60 * 1000 }),
    ).toString('base64url');
    // Even if signature matched, timestamp check returns null
    expect(verifyOAuthState(`${expiredPayload}.${sig}`)).toBeNull();

    // 4. Corrupted base64
    expect(verifyOAuthState('!!!invalid-base64!!!.invalidsig')).toBeNull();
  });
});

describe('Edge Cases — Session Token Issuance & Refresh Rotation', () => {
  it('issues session tokens and handles database insert errors gracefully', async () => {
    const user = { id: 1, tokenVersion: 1 };
    const mockDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw new Error('Disk full'); // Best-effort write fails
        }),
      })),
    } as any;

    const tokens = await issueSessionTokens(mockDb, user, { ip: '127.0.0.1', userAgent: 'TestRunner' });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresIn).toBeGreaterThan(0);
  });

  it('rotates refresh tokens atomically and blocks already-revoked sessions', async () => {
    const user = { id: 1, tokenVersion: 1 };
    const jti = 'session-uuid-123';

    // 1. Active session rotation succeeds
    const mockDbSuccess = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: 1, jti }]),
          })),
        })),
      })),
    } as any;

    const refreshed = await refreshSessionTokens(mockDbSuccess, user, jti);
    expect(refreshed.accessToken).toBeTruthy();
    expect(refreshed.refreshToken).toBeTruthy();

    // 2. Revoked session rotation throws session_revoked
    const mockDbRevoked = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []), // No rows matched condition (isNull(revokedAt))
          })),
        })),
      })),
    } as any;

    await expect(refreshSessionTokens(mockDbRevoked, user, jti)).rejects.toThrow('session_revoked');
  });

  it('validates live session lifecycle including expiration and revocation checks', async () => {
    const validRow = {
      id: 1,
      jti: 'live-jti',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    const expiredRow = {
      id: 2,
      jti: 'expired-jti',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
    };

    const revokedRow = {
      id: 3,
      jti: 'revoked-jti',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };

    const mockDb = {
      query: {
        sessions: {
          findFirst: vi.fn(async () => {
            return validRow;
          }),
        },
      },
    } as any;

    // Live session
    expect(await findLiveSession(mockDb, 'live-jti')).toEqual(validRow);

    // Expired session
    mockDb.query.sessions.findFirst = vi.fn(async () => expiredRow);
    expect(await findLiveSession(mockDb, 'expired-jti')).toBeNull();

    // Revoked session
    mockDb.query.sessions.findFirst = vi.fn(async () => revokedRow);
    expect(await findLiveSession(mockDb, 'revoked-jti')).toBeNull();

    // Non-existent session
    mockDb.query.sessions.findFirst = vi.fn(async () => null);
    expect(await findLiveSession(mockDb, 'missing-jti')).toBeNull();
  });

  it('revokes all active sessions for a user upon security events', async () => {
    let updateIssued = false;
    const mockDb = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => {
            updateIssued = true;
          }),
        })),
      })),
    } as any;

    await revokeAllSessions(mockDb, 42);
    expect(updateIssued).toBe(true);
  });
});
