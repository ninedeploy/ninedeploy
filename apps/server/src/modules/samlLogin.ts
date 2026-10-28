import { parse as parseQuery } from 'node:querystring';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { generateServiceProviderMetadata } from '@node-saml/node-saml';
import { ssoProviders } from '@ninedeploy/db';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { findUserByEmail, SSO_TOTP_REFUSAL } from '../lib/authHelpers.js';
import { decrypt } from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { generateOAuthState, verifyOAuthState } from '../lib/oauth.js';
import { panelOrigin } from '../lib/panelOrigin.js';
import { emailInDomains, resolveSamlConfig, samlEmail, samlFor, type ResolvedSamlProvider } from '../lib/samlLogin.js';
import { issueSessionTokens } from '../lib/sessions.js';

/**
 * G3.6 SAML sign-in (see lib/samlLogin.ts), mounted under `/auth/saml`.
 *
 *  - `GET /providers/public`  the sign-in buttons (id, name, authUrl)
 *  - `GET /:id/metadata`      this panel as a service provider, for the IdP
 *  - `GET /:id/login`         start: an AuthnRequest, with the tab's nonce and
 *                             return path in the signed RelayState
 *  - `POST /:id/acs`          the IdP's response: verified, then the session
 *                             is handed to the SPA's `/auth/callback` exactly
 *                             as an OIDC sign-in is (the tab's nonce must match)
 */

const fail = (status: number, code: string, message: string) => new HttpError(status, code, message);

/** Same rule as the OIDC callback: a return path on this panel, nothing else. */
function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || [...raw].some((c) => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f || c === '\\')) return '/';
  try {
    return new URL(raw, config.publicUrl).origin === new URL(config.publicUrl).origin ? raw : '/';
  } catch {
    return '/';
  }
}

export const samlLoginRoutes: FastifyPluginAsync = async (app) => {
  // The IdP posts the response as a form.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => {
    done(null, parseQuery(String(body)));
  });

  const load = async (rawId: string): Promise<{ id: number; name: string; cfg: ResolvedSamlProvider }> => {
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
    const row = id ? await app.db.query.ssoProviders.findFirst({ where: eq(ssoProviders.id, id) }) : undefined;
    if (!row || row.type !== 'saml') throw notFound('No such SAML provider');
    let cfg: ResolvedSamlProvider;
    try {
      cfg = resolveSamlConfig(JSON.parse(row.configJson.startsWith('{') ? row.configJson : decrypt(row.configJson)));
    } catch (err) {
      throw fail(409, 'saml_config_invalid', `The SAML provider "${row.name}" is not configured for sign-in: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { id: row.id, name: row.name, cfg };
  };
  const sp = async (id: number) => {
    const origin = await panelOrigin(app.db);
    return { entityId: `${origin}/v1/auth/saml/${id}/metadata`, acsUrl: `${origin}/v1/auth/saml/${id}/acs` };
  };

  app.get('/providers/public', async () => {
    const rows = await app.db.select({ id: ssoProviders.id, name: ssoProviders.name, type: ssoProviders.type, configJson: ssoProviders.configJson }).from(ssoProviders);
    return rows
      .filter((r) => {
        if (r.type !== 'saml') return false;
        try {
          resolveSamlConfig(JSON.parse(r.configJson.startsWith('{') ? r.configJson : decrypt(r.configJson)));
          return true;
        } catch {
          return false;
        }
      })
      .map((r) => ({ id: r.id, name: r.name, authUrl: `/v1/auth/saml/${r.id}/login` }));
  });

  app.get('/:id/metadata', async (req, reply) => {
    const { id } = await load((req.params as { id: string }).id);
    const { entityId, acsUrl } = await sp(id);
    const xml = generateServiceProviderMetadata({ issuer: entityId, callbackUrl: acsUrl, identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', wantAssertionsSigned: true });
    return reply.type('application/samlmetadata+xml; charset=utf-8').send(xml);
  });

  app.get('/:id/login', async (req, reply) => {
    const { id, cfg } = await load((req.params as { id: string }).id);
    const q = req.query as { returnTo?: string; nonce?: string };
    // The SPA's nonce is required: it is what binds the response to this tab.
    if (typeof q.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(q.nonce)) throw fail(400, 'saml_nonce_required', 'Start the sign-in from the panel’s sign-in page');
    const relayState = generateOAuthState(`saml:${id}`, safeReturnTo(q.returnTo), undefined, q.nonce);
    const url = await samlFor(id, cfg, await sp(id)).getAuthorizeUrlAsync(relayState, undefined, {});
    return reply.redirect(url);
  });

  app.post('/:id/acs', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, name, cfg } = await load((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const samlResponse = typeof body['SAMLResponse'] === 'string' ? body['SAMLResponse'] : '';
    const state = typeof body['RelayState'] === 'string' ? verifyOAuthState(body['RelayState']) : null;
    if (!samlResponse || !state || state.slug !== `saml:${id}` || !state.clientNonce) {
      throw fail(400, 'saml_state_invalid', 'This sign-in was not started here, or it expired. Sign in again.');
    }
    let email: string | null;
    try {
      const { profile } = await samlFor(id, cfg, await sp(id)).validatePostResponseAsync({ SAMLResponse: samlResponse });
      email = profile ? samlEmail(profile, cfg.emailAttribute) : null;
    } catch (err) {
      void audit(app.db, null, 'auth.saml_refused', `${name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
      throw fail(401, 'saml_response_invalid', 'The identity provider’s answer could not be verified. Sign in again.');
    }
    if (!email) throw fail(401, 'saml_no_email', 'The identity provider did not send an email address');
    if (!emailInDomains(email, cfg.emailDomains)) {
      void audit(app.db, null, 'auth.sso_domain_refused', `${name} (${email})`);
      throw fail(403, 'sso_domain_not_allowed', `This sign-in provider only accepts accounts from: ${cfg.emailDomains.join(', ')}`);
    }
    const user = await findUserByEmail(app.db, email);
    if (!user) throw fail(403, 'saml_no_account', `No account uses ${email}. Ask an administrator to invite you first.`);
    if (user.totpEnabled) throw fail(403, 'saml_totp', SSO_TOTP_REFUSAL);
    const tokens = await issueSessionTokens(app.db, user, { ip: req.ip, userAgent: req.headers['user-agent'], method: { amr: 'sso', idp: `sso:${id}` } });
    void audit(app.db, user.id, 'auth.sso_login', `${name} (${email})`, undefined, { ip: req.ip, userAgent: req.headers['user-agent'] });
    const fragment = new URLSearchParams({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      nonce: state.clientNonce,
      return_to: safeReturnTo(state.returnTo),
    });
    return reply.code(303).header('cache-control', 'no-store').header('location', `/auth/callback#${fragment.toString()}`).send();
  });
};
