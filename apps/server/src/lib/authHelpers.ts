import { sql } from 'drizzle-orm';
import { users, type DB, type User } from '@ninedeploy/db';

/** SSO callbacks cannot mint full sessions until the local second factor is satisfied. */
export const SSO_TOTP_REFUSAL =
  'This account has two-factor authentication enabled; SSO sign-in cannot satisfy it yet. Sign in with password and code.';

/**
 * Look up a user by their lowercased email address. The
 * `users.email` column is stored lowercased (a precondition enforced
 * by the email/password flow at create time) so callers can pass
 * the raw SAML attribute directly and trust the comparison.
 *
 * PR #23-b (Sprint 6) is the first caller: the SAML POST consumer
 * receives an `email` attribute from the IdP and uses this to find
 * the matching local user before minting a session. Future callers
 * (operator panel "find by email" search, audit reconciliation) can
 * share the same helper.
 */
export async function findUserByEmail(
  db: Pick<DB, 'query'>,
  email: string,
): Promise<User | undefined> {
  const normalized = normalizeEmail(email);
  if (!normalized) return undefined;
  // r159: compare case-insensitively. Accounts created before emails were
  // normalized on write keep their original casing, and an exact match made
  // SSO sign-in fail for `Alice@Corp.com`.
  return db.query.users.findFirst({ where: sql`lower(${users.email}) = ${normalized}` });
}

/** The canonical stored form of an email address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
