import { and, count, eq, sql } from 'drizzle-orm';
import { oauthIdentities, users, type DB, type OidcProvider } from '@ninedeploy/db';
import { hashPassword, randomToken, sha256 } from './crypto.js';
import { normalizeEmail, SSO_TOTP_REFUSAL } from './authHelpers.js';
import { forbidden, HttpError, unauthorized } from './errors.js';
import { findLiveSession } from './sessions.js';
import type { OAuthLinkContext, OidcUserInfo } from './oauth.js';

export function oauthProviderFingerprint(provider: Pick<OidcProvider, 'issuerUrl' | 'clientId'>): string {
  return sha256(JSON.stringify([provider.issuerUrl, provider.clientId]));
}

/** Resolve a stable identity; linking requires a still-live initiating local session. */
export async function resolveOAuthIdentity(db: DB, provider: OidcProvider, info: OidcUserInfo, link?: OAuthLinkContext) {
  if (info.emailVerified !== true || !info.sub?.trim()) throw forbidden('A verified email and stable SSO subject are required');
  const fingerprint = oauthProviderFingerprint(provider);
  return db.transaction(async (tx) => {
    const identity = await tx.query.oauthIdentities.findFirst({
      where: and(eq(oauthIdentities.providerId, provider.id), eq(oauthIdentities.subject, info.sub)),
    });
    let user = identity && identity.providerFingerprint === fingerprint
      ? await tx.query.users.findFirst({ where: eq(users.id, identity.userId) })
      : undefined;
    if (link) {
      const session = await findLiveSession(tx, link.sessionJti);
      const local = await tx.query.users.findFirst({ where: eq(users.id, link.userId) });
      if (link.providerFingerprint !== fingerprint || !session || session.userId !== link.userId ||
          !local || local.tokenVersion !== link.tokenVersion || local.deactivatedAt) {
        throw unauthorized('The account-linking session expired or was revoked; sign in and try again');
      }
      if (normalizeEmail(local.email) !== normalizeEmail(info.email)) throw forbidden('The SSO email must match the signed-in account');
      if (identity && identity.userId !== local.id) throw forbidden('This SSO identity is already linked to another account');
      user = local;
    } else if (!user) {
      const existing = await tx.query.users.findFirst({ where: sql`lower(${users.email}) = ${normalizeEmail(info.email)}` });
      // Refuse before any workspace/invitation/session writes.
      if (existing?.totpEnabled) throw forbidden(SSO_TOTP_REFUSAL);
      if (existing?.deactivatedAt) throw unauthorized('This account has been deactivated', 'account_deactivated');
      if (existing) throw new HttpError(403, 'account_link_required', 'Sign in to your existing account and link this provider in account settings');
      if (!provider.autoEnroll) throw forbidden('Auto-enrollment is disabled for this SSO provider');
      // A stale identity must not be reassigned after provider configuration changes.
      if (identity) throw new HttpError(403, 'account_link_required', 'This SSO identity must be linked again from account settings');
      const [total] = await tx.select({ n: count() }).from(users);
      const firstUser = (total?.n ?? 0) === 0;
      const [created] = await tx.insert(users).values({
        email: normalizeEmail(info.email),
        passwordHash: await hashPassword(randomToken(32)),
        name: info.name ?? null,
        isInstanceOperator: firstUser,
      }).returning();
      if (!created) throw new Error('Could not create SSO account');
      await tx.insert(oauthIdentities).values({ providerId: provider.id, subject: info.sub, userId: created.id, providerFingerprint: fingerprint });
      return { user: created, created: true, firstUser };
    }
    if (!user) throw unauthorized();
    if (user.deactivatedAt) throw unauthorized('This account has been deactivated', 'account_deactivated');
    // Explicit linking already proved a fully authenticated local session;
    // ordinary SSO login still cannot substitute for the local second factor.
    if (user.totpEnabled && !link) throw forbidden(SSO_TOTP_REFUSAL);
    if (link) {
      if (identity) {
        await tx.update(oauthIdentities).set({ providerFingerprint: fingerprint }).where(eq(oauthIdentities.id, identity.id));
      } else {
        await tx.insert(oauthIdentities).values({ providerId: provider.id, subject: info.sub, userId: user.id, providerFingerprint: fingerprint });
      }
    }
    return { user, created: false, firstUser: false };
  });
}
