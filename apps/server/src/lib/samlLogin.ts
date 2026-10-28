import { InMemoryCacheProvider } from '@node-saml/node-saml/lib/in-memory-cache-provider.js';
import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import { z } from 'zod';
import { parseIdpMetadata, wrapPem } from './saml.js';

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
 *  - The asserted email must be in one of the provider's `emailDomains`, and
 *    an account with that email must already exist (no auto-enrolment).
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

/** The email the assertion names: the configured attribute, a common email attribute, or an email NameID. */
export function samlEmail(profile: Profile, emailAttribute?: string): string | null {
  const attr = (name: string) => {
    const v = (profile as Record<string, unknown>)[name];
    return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
  };
  const candidates = [
    emailAttribute ? attr(emailAttribute) : null,
    attr('email'),
    attr('mail'),
    attr('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'),
    profile.nameID,
  ];
  const email = candidates.find((v): v is string => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  return email ? email.trim().toLowerCase() : null;
}

export function emailInDomains(email: string, domains: string[]): boolean {
  const domain = email.split('@')[1] ?? '';
  return domains.includes(domain);
}
