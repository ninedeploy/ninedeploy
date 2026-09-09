import { eq } from 'drizzle-orm';
import type { DB } from '@ninedeploy/db';
import { apiTokens, users } from '@ninedeploy/db';
import type { AuthUser } from '../plugins/auth.js';
import { sha256 } from './crypto.js';
import { verifyJwt, type AppJwtPayload } from './jwt.js';

/**
 * Narrow an API-token-authed user in place: only an explicit `operator` scope
 * may carry the instance-operator flag. The HTTP `authenticate` hook applies
 * this to every request; the `/v1/events` WebSocket resolves the bearer
 * itself and must apply it too — without it, a scope-restricted token of an
 * operator sees the global event feed, including operator-only system events
 * and every other tenant's activity.
 */
export function narrowScopes(user: { isOperator: boolean; tokenScopes?: string[] | null }): void {
  // Only a PRESENT scope list narrows: `null`/undefined means an interactive
  // session or a legacy unrestricted token, which keep the owner's flag.
  if (Array.isArray(user.tokenScopes) && !user.tokenScopes.includes('operator')) {
    user.isOperator = false;
  }
}

/**
 * Resolve a raw bearer credential to a user (id only) + the instance-operator
 * flag read from `users.is_instance_operator`.
 *
 * The legacy global `users.role` column is gone (migration `0034` rebuilds the
 * table without it), so the JWT no longer carries a role, the DB no longer has
 * one, and nothing here reads one. The `isOperator` flag is computed fresh
 * on every call, so granting or revoking it takes effect on the next request —
 * not the next access-token refresh. It is deliberately NOT derived from
 * workspace membership (that inference let any member self-promote by creating
 * a workspace); see `lib/resourceAccess.ts`.
 *
 * The user is rejected when:
 *   • the credential is invalid (signature, expiry, format)
 *   • the underlying user no longer exists
 *   • the token was issued before the user's `tokenVersion` was bumped
 *     (logout / password change → all outstanding JWTs for that user are
 *     invalidated)
 *
 * Shared by the HTTP `authenticate` pre-handler and the WebSocket log stream
 * (which cannot easily set Authorization headers).
 */
export async function resolveUser(db: DB, token: string): Promise<AuthUser | null> {
  // JWT access token (three dot-separated segments).
  if (token.split('.').length === 3) {
    let payload: AppJwtPayload;
    try {
      payload = await verifyJwt(token);
    } catch {
      return null;
    }
    if (payload.type !== 'access') return null;
    const baseUser = await loadBaseUser(db, Number(payload.sub));
    if (!baseUser) return null;
    // Reject tokens minted before the current tokenVersion (revoked sessions).
    // ver is mandatory: a token without it skips revocation entirely.
    if (payload.ver === undefined || payload.ver !== baseUser.tokenVersion) return null;
    // Interactive sessions are never scope-restricted; scopes are an
    // API-token concept.
    return { id: baseUser.id, isOperator: baseUser.isInstanceOperator, tokenScopes: null };
  }

  // Opaque API token — compare by sha256 hash. Revoked by row deletion.
  const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.hash, sha256(token)) });
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  const baseUser = await loadBaseUser(db, row.userId);
  if (!baseUser) return null;
  // Scopes ride along so the auth plugin can narrow the request (it has the
  // HTTP method; this function does not). An empty list means unrestricted —
  // see `apiTokenScope` in @ninedeploy/schemas for why.
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  return { id: baseUser.id, isOperator: baseUser.isInstanceOperator, tokenScopes: scopes.length > 0 ? scopes : null };
}

interface LoadedUser {
  id: number;
  tokenVersion: number;
  /**
   * `users.is_instance_operator` — the ONLY source of the operator flag.
   *
   * The legacy `users.role` column used to be read here as a second grant path
   * ("role === 'admin' also means operator"). Migration `0034` rebuilds the
   * `users` table without that column, so the branch was unreachable in
   * production and existed purely to keep test fixtures passing — a second,
   * dead authorization path in the auth core, kept alive by its own tests.
   * Migration `0038` deliberately backfills the flag NARROWLY (bootstrap user +
   * owners/admins of the oldest workspace); honouring a stray `role` column
   * would have quietly widened exactly the grant that migration set out to
   * close. Removed.
   */
  isInstanceOperator: boolean;
}

async function loadBaseUser(db: DB, userId: number): Promise<LoadedUser | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return null;
  return {
    id: user.id,
    tokenVersion: user.tokenVersion,
    isInstanceOperator: user.isInstanceOperator === true,
  };
}
