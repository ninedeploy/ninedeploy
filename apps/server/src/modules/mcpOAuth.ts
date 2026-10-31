import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import {
  getClient,
  issueCode,
  issueTokens,
  pkceMatches,
  redirectUriAllowed,
  refreshTokens,
  registerClient,
  revokeToken,
  takeCode,
  type McpAccess,
} from '../lib/mcpOAuth.js';
import { HttpError } from '../lib/errors.js';
import { getMcpHttpPolicy } from './mcpHttp.js';

/**
 * R4 remote MCP: OAuth 2.1 for MCP clients that cannot send a fixed header
 * (the MCP authorization spec, 2025-06-18). All of it answers only while
 * remote MCP is on.
 *  - `/.well-known/oauth-protected-resource[/v1/mcp]` (RFC 9728) and
 *    `/.well-known/oauth-authorization-server` (RFC 8414): discovery.
 *  - `POST /v1/oauth/register` (RFC 7591): public clients only.
 *  - The authorization endpoint is the dashboard page `/oauth/authorize`: the
 *    signed-in user sees the client's name and where it sends them back, and
 *    approves read-only or full access through `POST /v1/oauth/authorize`.
 *  - `POST /v1/oauth/token`: authorization_code with PKCE S256, refresh_token
 *    with rotation. `POST /v1/oauth/revoke` (RFC 7009).
 * The issuer and resource follow the address the client used, so a panel
 * reached under two names answers consistently on each.
 */

const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;
const resourceOf = (req: FastifyRequest) => `${origin(req)}/v1/mcp`;
export const protectedResourceMetadataUrl = (req: FastifyRequest) => `${origin(req)}/.well-known/oauth-protected-resource/v1/mcp`;

async function requireOn(req: FastifyRequest): Promise<void> {
  if (!(await getMcpHttpPolicy(req.server.db)).enabled) throw new HttpError(404, 'not_found', 'Remote MCP is off');
}

/** RFC 6749 §5.2 error body. */
function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error, error_description: description });
}

/** Discovery documents, at the origin root. */
export const mcpOAuthWellKnownRoutes: FastifyPluginAsync = async (app) => {
  const resourceMetadata = async (req: FastifyRequest) => {
    await requireOn(req);
    return {
      resource: resourceOf(req),
      authorization_servers: [origin(req)],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:read', 'mcp:full'],
      resource_name: 'NineDeploy',
    };
  };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/v1/mcp', resourceMetadata);
  app.get('/.well-known/oauth-authorization-server', async (req) => {
    await requireOn(req);
    const base = origin(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/v1/oauth/token`,
      registration_endpoint: `${base}/v1/oauth/register`,
      revocation_endpoint: `${base}/v1/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:read', 'mcp:full'],
      authorization_response_iss_parameter_supported: true,
    };
  });
};

const registration = z.object({
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string().max(500)).min(1).max(5),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
  response_types: z.array(z.literal('code')).optional(),
});

const authorizeRequest = z.object({
  response_type: z.literal('code'),
  client_id: z.string().max(60),
  redirect_uri: z.string().max(500),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'code_challenge must be a base64url SHA-256'),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(500).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(500).optional(),
});

const LIMIT = { max: 20, timeWindow: '1 minute' };

/** The registration, token and revocation endpoints (public), under /v1/oauth. */
export const mcpOAuthServerRoutes: FastifyPluginAsync = async (app) => {
  // Token and revocation requests are form-encoded (RFC 6749 §4.1.3).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  app.post('/register', { config: { rateLimit: LIMIT } }, async (req, reply) => {
    await requireOn(req);
    const parsed = registration.safeParse(req.body ?? {});
    if (!parsed.success) return oauthError(reply, 400, 'invalid_client_metadata', parsed.error.issues[0]?.message ?? 'Invalid client metadata');
    const bad = parsed.data.redirect_uris.find((u) => !redirectUriAllowed(u));
    if (bad) return oauthError(reply, 400, 'invalid_redirect_uri', 'Redirect URIs must be https, or http on localhost');
    try {
      const name = parsed.data.client_name ?? 'MCP client';
      const { clientId, client } = await registerClient(app.db, name, parsed.data.redirect_uris);
      return reply.code(201).header('Cache-Control', 'no-store').send({
        client_id: clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    } catch {
      return oauthError(reply, 503, 'temporarily_unavailable', 'Too many registered clients; try again later');
    }
  });

  app.post('/token', { config: { rateLimit: LIMIT } }, async (req, reply) => {
    await requireOn(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
    const clientId = str('client_id');
    const client = await getClient(app.db, clientId);
    if (!client) return oauthError(reply, 401, 'invalid_client', 'Unknown client');
    if (str('grant_type') === 'authorization_code') {
      const grant = takeCode(str('code'));
      if (!grant || grant.clientId !== clientId || grant.redirectUri !== str('redirect_uri')) {
        return oauthError(reply, 400, 'invalid_grant', 'The authorization code is invalid, expired or already used');
      }
      if (!pkceMatches(str('code_verifier'), grant.codeChallenge)) return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
      if (str('resource') && str('resource') !== grant.resource) return oauthError(reply, 400, 'invalid_target', 'The resource does not match the authorization');
      const tokens = await issueTokens(app.db, grant, client.name);
      void audit(app.db, grant.userId, 'mcp.oauth.grant', `MCP: ${client.name}`, { clientId, access: grant.access });
      return reply.header('Cache-Control', 'no-store').send(tokens);
    }
    if (str('grant_type') === 'refresh_token') {
      const tokens = await refreshTokens(app.db, str('refresh_token'), clientId);
      if (!tokens) return oauthError(reply, 400, 'invalid_grant', 'The refresh token is invalid, expired or revoked');
      return reply.header('Cache-Control', 'no-store').send(tokens);
    }
    return oauthError(reply, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  app.post('/revoke', { config: { rateLimit: LIMIT } }, async (req, reply) => {
    await requireOn(req);
    const token = (req.body as Record<string, unknown> | undefined)?.['token'];
    if (typeof token === 'string' && token) await revokeToken(app.db, token);
    return reply.code(200).header('Cache-Control', 'no-store').send({});
  });
};

/** The dashboard's consent page calls these as the signed-in user (an interactive session, never an API token). */
export const mcpOAuthConsentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRequest', app.requireInteractive);

  /** Check an authorization request before showing it; nothing about a bad one is sent anywhere. */
  async function check(req: FastifyRequest, input: unknown) {
    await requireOn(req);
    const parsed = authorizeRequest.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', parsed.error.issues[0]?.message ?? 'Invalid authorization request');
    const client = await getClient(app.db, parsed.data.client_id);
    if (!client) throw new HttpError(400, 'invalid_client', 'This MCP client is not registered with the panel');
    if (!client.redirectUris.includes(parsed.data.redirect_uri)) throw new HttpError(400, 'invalid_request', 'The redirect address is not one the client registered');
    if (parsed.data.resource && parsed.data.resource !== resourceOf(req)) throw new HttpError(400, 'invalid_target', 'The client asked for access to another server');
    return { request: parsed.data, client };
  }

  app.get('/authorize', async (req) => {
    const { request, client } = await check(req, req.query);
    return {
      client: { name: client.name, redirectHost: new URL(request.redirect_uri).host },
      requestedAccess: request.scope?.split(' ').includes('mcp:read') && !request.scope.split(' ').includes('mcp:full') ? 'read' : 'full',
    };
  });

  const decision = z.object({ approve: z.boolean(), access: z.enum(['read', 'full']).default('full') });

  app.post('/authorize', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { request } = await check(req, body['request']);
    const { approve, access } = decision.parse(body);
    const to = new URL(request.redirect_uri);
    if (approve) {
      const code = issueCode({
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        codeChallenge: request.code_challenge,
        userId: req.user!.id,
        access: access as McpAccess,
        resource: resourceOf(req),
      });
      to.searchParams.set('code', code);
    } else {
      to.searchParams.set('error', 'access_denied');
    }
    if (request.state !== undefined) to.searchParams.set('state', request.state);
    to.searchParams.set('iss', origin(req));
    return { redirect: to.toString() };
  });
};

