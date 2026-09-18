import { describe, expect, it, vi, beforeEach } from 'vitest';
import { consumeResetToken, issueResetToken, RESET_TTL_MS, pruneResetTokens } from '../../src/lib/passwordReset.js';
import { hashPassword, sha256, verifyPassword } from '../../src/lib/crypto.js';
import { createFakeDb } from '../helpers.js';
import type { User } from '@ninedeploy/db';

vi.mock('../../src/lib/notifier.js', () => ({ notifyEvent: vi.fn() }));

const user = {
  id: 1, email: 'a@b.c', name: null, isOperator: true, passwordHash: 'x',
  tokenVersion: 3, createdAt: new Date(), updatedAt: new Date(),
} as unknown as User;

const row = (over: Record<string, unknown> = {}) => ({
  id: 7,
  userId: 1,
  tokenHash: sha256('tok'),
  expiresAt: new Date(Date.now() + 60_000),
  usedAt: null,
  requestedFrom: null,
  createdAt: new Date(),
  ...over,
});

describe('passwordReset tokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues a hashed token with a 30-minute expiry', async () => {
    const db = createFakeDb({});
    const { token, expiresAt } = await issueResetToken(db, user, '1.2.3.4');
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + RESET_TTL_MS - 5000);
    expect(expiresAt.getTime()).toBeLessThan(Date.now() + RESET_TTL_MS + 5000);
    // A missing source IP normalizes to null.
    await expect(issueResetToken(db, user, undefined)).resolves.toHaveProperty('token');
  });

  it('consumes a valid token: sets the password and bumps tokenVersion', async () => {
    const removePasskeys = vi.fn(() => []);
    const removeLinks = vi.fn(() => []);
    const removeTokens = vi.fn(() => []);
    const revokeSessions = vi.fn(() => []);
    const newHash = await hashPassword('fresh-password');
    const db = createFakeDb({
      findFirst: {
        passwordResetTokens: row(),
        users: { ...user, tokenVersion: 3 },
      },
      update: { users: [{ ...user, tokenVersion: 4, passwordHash: newHash }], password_reset_tokens: [{}], sessions: revokeSessions },
      delete: { webauthn_credentials: removePasskeys, oauth_identities: removeLinks, api_tokens: removeTokens },
    });
    const updated = await consumeResetToken(db, 'tok', 'fresh-password');
    expect(updated.tokenVersion).toBe(4);
    expect(await verifyPassword(updated.passwordHash, 'fresh-password')).toBe(true);
    expect(await verifyPassword(updated.passwordHash, 'other')).toBe(false);
    expect(removePasskeys).toHaveBeenCalledOnce();
    expect(removeLinks).toHaveBeenCalledOnce();
    expect(removeTokens).toHaveBeenCalledOnce();
    expect(revokeSessions).toHaveBeenCalledOnce();
  });

  it('rejects an unknown token with a generic message', async () => {
    const db = createFakeDb({ findFirst: { passwordResetTokens: undefined } });
    await expect(consumeResetToken(db, 'nope'.repeat(5), 'fresh-password')).rejects.toThrow(
      'Invalid or expired reset token',
    );
  });

  it('rejects and deletes an expired token', async () => {
    const db = createFakeDb({
      findFirst: { passwordResetTokens: row({ expiresAt: new Date(Date.now() - 1000) }) },
      delete: { password_reset_tokens: [{}] },
    });
    await expect(consumeResetToken(db, 'tok', 'fresh-password')).rejects.toThrow(
      'Invalid or expired reset token',
    );
  });

  it('throws unauthorized when the owning user vanished', async () => {
    const db = createFakeDb({
      findFirst: { passwordResetTokens: row(), users: undefined },
    });
    await expect(consumeResetToken(db, 'tok', 'fresh-password')).rejects.toThrow();
  });

  it('throws unauthorized when the update returns no row', async () => {
    const db = createFakeDb({
      findFirst: { passwordResetTokens: row(), users: { ...user } },
      // The token claim succeeds, but the password write matches nothing.
      update: { users: [], password_reset_tokens: [{}] },
    });
    await expect(consumeResetToken(db, 'tok', 'fresh-password')).rejects.toThrow();
  });

  it('rejects when the token was already claimed by a concurrent request', async () => {
    const db = createFakeDb({
      findFirst: { passwordResetTokens: row(), users: { ...user } },
      update: { password_reset_tokens: [] },
    });
    await expect(consumeResetToken(db, 'tok', 'fresh-password')).rejects.toThrow(
      'Invalid or expired reset token',
    );
  });

  it('prunes expired tokens', async () => {
    const db = createFakeDb({ delete: { password_reset_tokens: [{}] } });
    await expect(pruneResetTokens(db)).resolves.toBeUndefined();
  });
});
