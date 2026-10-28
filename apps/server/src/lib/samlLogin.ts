import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';
import { InMemoryCacheProvider } from '@node-saml/node-saml/lib/in-memory-cache-provider.js';
import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import { z } from 'zod';
import { parseIdpMetadata, wrapPem } from './saml.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G3.6 SAML sign-in, on `@node-saml/node-saml` (xml-crypto for XML-DSig with
 * Exclusive C14N and the enveloped-signature transform, xmldom for parsing),
 * replacing the hand-rolled verifier that could never match a real IdP.
 *
 *  - SP-initiated only: the panel sends an AuthnRequest and accepts a
 *    response only `InResponseTo` a request it issued in the last 10 minutes
 *    (`validateInResponseTo: 'always'`, one cache per provider). Each request
 *    id is spent on use, so a response cannot be replayed.
 *  - The assertion must be signed by the configured certificate; the audience
 *    must be this panel's SP entity id; clock skew is one minute.
 *  - The asserted email must be in one of the provider's `emailDomains`.
 *  - Like OIDC, a SAML identity (provider + NameID) signs in only the account
 *    it was linked to, from that account's own signed-in session (Settings →
 *    Account). An existing account that never linked it gets
 *    `account_link_required`; there is no auto-enrolment. A link is bound to
 *    the IdP's configuration: changing the sign-in URL, certificate or issuer
 *    asks everyone to link again.
 */

export const samlProviderConfig = z
  .object({
    /** Either the IdP metadata XML, or the three values below. */
    idpMetadataXml: z.string().max(200_000).optional(),
    entryPoint: z.string().url().optional(),
    idpCert: z.string().min(1).max(20_000).optional(),
    idpIssuer: z.string().max(1000).optional(),
    /** The attribute that carries the email; the NameID when it is an email otherwise. */
    emailAttribute: z.string().max(200).optional(),
    /** Accounts of these email domains may sign in through the provider. */
    emailDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).min(1).max(50),
  })
  .strict()
  .refine((c) => !!c.idpMetadataXml || (!!c.entryPoint && !!c.idpCert), {
    message: 'Give the IdP metadata XML, or its entryPoint and signing certificate',
  });
export type SamlProviderConfig = z.infer<typeof samlProviderConfig>;

export interface ResolvedSamlProvider {
  entryPoint: string;
  idpCert: string;
  idpIssuer?: string;
  emailAttribute?: string;
  emailDomains: string[];
}

/** Read the metadata (when given) into the values node-saml needs. */
export function resolveSamlConfig(raw: unknown): ResolvedSamlProvider {
  const c = samlProviderConfig.parse(raw);
  let entryPoint = c.entryPoint;
  let idpCert = c.idpCert;
  let idpIssuer = c.idpIssuer;
  if (c.idpMetadataXml) {
    const md = parseIdpMetadata(c.idpMetadataXml);
    entryPoint ??= md.ssoUrl;
    idpCert ??= md.signingCert;
    idpIssuer ??= md.entityId;
  }
  if (!entryPoint || !/^https:\/\//.test(entryPoint)) throw new Error('The IdP sign-in URL must be https');
  const cert = idpCert!.includes('BEGIN CERTIFICATE') ? idpCert! : wrapPem(idpCert!);
  return { entryPoint, idpCert: cert, ...(idpIssuer && { idpIssuer }), ...(c.emailAttribute && { emailAttribute: c.emailAttribute }), emailDomains: c.emailDomains.map((d) => d.toLowerCase()) };
}

/** One request-id cache per provider, shared by its login and ACS calls. */
const caches = new Map<number, InMemoryCacheProvider>();
const REQUEST_TTL_MS = 10 * 60_000;

export function samlFor(providerId: number, cfg: ResolvedSamlProvider, sp: { entityId: string; acsUrl: string }): SAML {
  let cache = caches.get(providerId);
  if (!cache) {
    cache = new InMemoryCacheProvider({ keyExpirationPeriodMs: REQUEST_TTL_MS });
    caches.set(providerId, cache);
  }
  return new SAML({
    entryPoint: cfg.entryPoint,
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    idpCert: cfg.idpCert,
    ...(cfg.idpIssuer && { idpIssuer: cfg.idpIssuer }),
    audience: sp.entityId,
    wantAssertionsSigned: true,
    // Most IdPs sign the assertion only; a signed response is accepted too.
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider: cache,
    acceptedClockSkewMs: 60_000,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    disableRequestedAuthnContext: true,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  });
}

export function resetSamlCaches(): void {
  caches.clear();
}

/**
 * The email the assertion names: only the configured attribute when there is
 * one; otherwise a common email attribute or an email NameID.
 */
export function samlEmail(profile: Profile, emailAttribute?: string): string | null {
  const attr = (name: string) => {
    const v = (profile as Record<string, unknown>)[name];
    return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
  };
  const candidates = emailAttribute
    ? [attr(emailAttribute)]
    : [attr('email'), attr('mail'), attr('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'), profile.nameID];
  const email = candidates.find((v): v is string => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  return email ? email.trim().toLowerCase() : null;
}

export function emailInDomains(email: string, domains: string[]): boolean {
  const domain = email.split('@')[1] ?? '';
  return domains.includes(domain);
}

// ── Linked identities ───────────────────────────────────────────────────────

/** The IdP configuration a link is bound to. */
export function samlProviderFingerprint(cfg: ResolvedSamlProvider): string {
  return createHash('sha256').update(JSON.stringify([cfg.entryPoint, cfg.idpCert.replace(/\s+/g, ''), cfg.idpIssuer ?? null])).digest('hex');
}

const linkKey = (providerId: number, subject: string) => `saml_identity:${providerId}:${createHash('sha256').update(subject).digest('hex')}`;

interface StoredLink {
  userId: number;
  fingerprint: string;
}

/** The account a provider's subject is linked to, when the link matches the IdP's current configuration. */
export async function linkedSamlUser(db: DB, providerId: number, subject: string, fingerprint: string): Promise<{ userId: number } | { stale: true } | null> {
  const link = await getSettingJson<StoredLink>(db, linkKey(providerId, subject), null);
  if (!link || !Number.isInteger(link.userId)) return null;
  return link.fingerprint === fingerprint ? { userId: link.userId } : { stale: true };
}

export async function linkSamlIdentity(db: DB, providerId: number, subject: string, userId: number, fingerprint: string): Promise<void> {
  const existing = await getSettingJson<StoredLink>(db, linkKey(providerId, subject), null);
  if (existing && existing.userId !== userId) throw new Error('This SAML identity is already linked to another account');
  await setSettingJson<StoredLink>(db, linkKey(providerId, subject), { userId, fingerprint });
}

export async function unlinkSamlIdentity(db: DB, providerId: number, subject: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, linkKey(providerId, subject)));
}
