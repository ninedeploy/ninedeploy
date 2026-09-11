import { and, eq, isNull } from 'drizzle-orm';
import type { DB, User } from '@ninedeploy/db';
import { sessions } from '@ninedeploy/db';
import type { TokenPair } from '@ninedeploy/schemas';
import { config } from '../config.js';
import { signAccessToken, signRefreshToken, ttlSeconds } from './jwt.js';

/**
 * Session-backed token issuance. Every refresh token carries a `jti` that must
 * reference a live `sessions` row — revoking the row (or deleting it) kills the
 * session's refresh capability even without a tokenVersion bump.
 *
 * Access tokens are not per-session-checked on every request (they live
 * minutes); revocation takes full effect when the access token expires.
 */
export async function issueSessionTokens(
  db: Pick<DB, 'insert' | 'update'>,
  user: Pick<User, 'id' | 'tokenVersion'>,
  ctx?: { ip?: string; userAgent?: string },
): Promise<TokenPair> {
  const jti = crypto.randomUUID();
  const refreshTtl = ttlSeconds(config.jwt.refreshTtl);
  const expiresAt = new Date(Date.now() + refreshTtl * 1000);
  // Both token types carry the jti so the sessions list can flag the current
  // one from a plain access-token request. The refresh token is bound to the
  // row's expiry from the very first issue (r091): without `gen`, the login
  // refresh token skipped the rotation check in refreshSessionTokens and could
  // be replayed for the whole session, sliding its expiry each time.
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(user.id, user.tokenVersion, jti),
    signRefreshToken(user.id, user.tokenVersion, jti, expiresAt.getTime()),
  ]);
  // Best-effort row write: even if it failed, the token pair stays valid (a
  // missing row simply means no session-list entry / no per-session revoke).
  try {
    await db.insert(sessions).values({
      userId: user.id,
      jti,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent?.slice(0, 300) ?? null,
      lastUsedAt: new Date(),
      expiresAt,
    });
  } catch {
    /* non-fatal — see above */
  }
  return { accessToken, refreshToken, expiresIn: ttlSeconds(config.jwt.accessTtl) };
}

/**
 * Refresh-rotation issue: keep the same session jti (so revocation survives
 * refreshes) but advance the row's expiry and bind the NEW refresh token to
 * that expiry via its `gen` claim.
 *
 * The generation binding is what makes rotation real: a refresh token from a
 * PREVIOUS generation carries the expiry value that was live when it was
 * minted, which no longer matches the row — so a replayed or stolen old
 * refresh token is refused before any DB write, and cannot slide the session
 * forward or mint a fresh pair. Tokens minted before this claim existed have
 * no `gen`; they are accepted once (and immediately re-minted with one), so
 * the rollout does not log every existing session out.
 *
 * The session row must already exist and be live — callers verify that before
 * calling.
 */
export async function refreshSessionTokens(
  db: Pick<DB, 'query' | 'update'>,
  user: Pick<User, 'id' | 'tokenVersion'>,
  jti: string,
  tokenGen?: number,
): Promise<TokenPair> {
  if (tokenGen !== undefined) {
    // Generation check FIRST: a stale refresh token must not even slide the
    // session's expiry (that would hand whoever holds the old token a
    // session-extension oracle).
    const row = await db.query.sessions.findFirst({ where: eq(sessions.jti, jti) });
    if (!row || row.revokedAt || row.expiresAt.getTime() !== tokenGen) {
      throw new Error('session_revoked');
    }
  }
  // Rotate the row FIRST, conditioned on it still being live: if a concurrent
  // revoke (logout / session delete) lands between the caller's check and
  // here, no token pair is issued for the revoked session.
  const refreshTtl = ttlSeconds(config.jwt.refreshTtl);
  const expiresAt = new Date(Date.now() + refreshTtl * 1000);
  const rotated = await db
    .update(sessions)
    .set({ lastUsedAt: new Date(), expiresAt })
    .where(and(eq(sessions.jti, jti), isNull(sessions.revokedAt)))
    .returning();
  if (!rotated.length) throw new Error('session_revoked');
  const nextGen = expiresAt.getTime();
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(user.id, user.tokenVersion, jti),
    signRefreshToken(user.id, user.tokenVersion, jti, nextGen),
  ]);
  return { accessToken, refreshToken, expiresIn: ttlSeconds(config.jwt.accessTtl) };
}

/** Load a live (unrevoked, unexpired) session by jti. */
export async function findLiveSession(db: Pick<DB, 'query'>, jti: string) {
  const row = await db.query.sessions.findFirst({ where: eq(sessions.jti, jti) });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

/** Revoke every session of a user (logout / password change / reset / role change). */
export async function revokeAllSessions(db: Pick<DB, 'update'>, userId: number): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
