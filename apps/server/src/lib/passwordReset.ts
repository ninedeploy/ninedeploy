import { and, eq, isNull, lt } from 'drizzle-orm';
import { oauthIdentities, passwordResetTokens, type DB, users, webauthnCredentials, type User } from '@ninedeploy/db';
import { hashPassword, randomToken, sha256 } from './crypto.js';
import { badRequest, unauthorized } from './errors.js';
import { revokeAllSessions, revokeApiTokens } from './sessions.js';

/** Reset links are valid for 30 minutes and can be used exactly once. */
export const RESET_TTL_MS = 30 * 60 * 1000;

export interface IssuedResetToken {
  /** Raw token — shown exactly once (delivery message / admin copy). */
  token: string;
  expiresAt: Date;
}

/**
 * Mint a fresh single-use reset token for a user, invalidating any previous
 * pending one (one active token per user). The raw token never touches the
 * database — only its sha256 hash does.
 */
export async function issueResetToken(
  db: DB,
  user: User,
  requestedFrom: string | null | undefined,
): Promise<IssuedResetToken> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt,
    requestedFrom: requestedFrom ?? null,
  });
  return { token, expiresAt };
}

/**
 * Consume a reset token: verifies hash, expiry and single-use, then sets the
 * new password and bumps tokenVersion (every outstanding session of the user
 * is revoked). Throws 400/401 with deliberately generic messages so the
 * endpoint can't be probed for valid tokens.
 */
export async function consumeResetToken(db: DB, token: string, newPassword: string): Promise<User> {
  const row = await db.query.passwordResetTokens.findFirst({
    where: and(
      eq(passwordResetTokens.tokenHash, sha256(token)),
      isNull(passwordResetTokens.usedAt),
    ),
  });
  if (!row) throw badRequest('Invalid or expired reset token');
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, row.id));
    throw badRequest('Invalid or expired reset token');
  }
  // Atomically claim the token BEFORE doing any work: the conditional update
  // guarantees single-use even under concurrent requests with the same token.
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
      .returning();
    if (!claimed.length) throw badRequest('Invalid or expired reset token');
    const user = await tx.query.users.findFirst({ where: eq(users.id, row.userId) });
    if (!user) throw unauthorized();
    const passwordHash = await hashPassword(newPassword);
    const [updated] = await tx
      .update(users)
      .set({ passwordHash, tokenVersion: user.tokenVersion + 1 })
      .where(eq(users.id, user.id))
      .returning();
    if (!updated) throw unauthorized();
    await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    await tx.delete(oauthIdentities).where(eq(oauthIdentities.userId, user.id));
    await revokeAllSessions(tx, user.id);
    await revokeApiTokens(tx, user.id);
    return updated;
  });
}

/** Sweep expired pending tokens and used tokens older than a day (housekeeping). */
export async function pruneResetTokens(db: DB): Promise<void> {
  await db.delete(passwordResetTokens).where(lt(passwordResetTokens.expiresAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));
}
