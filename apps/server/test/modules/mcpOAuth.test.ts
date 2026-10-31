/**
 * R4 remote MCP over OAuth (`modules/mcpOAuth.ts`, `lib/mcpOAuth.ts`), end to
 * end on a migrated SQLite with the real auth plugin: discovery, dynamic
 * registration, consent as a signed-in session, PKCE code exchange, the
 * token on /v1/mcp, refresh rotation, revocation and the token's audience.
 */
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTokens, settings, users, type DB } from '@ninedeploy/db';
import { like } from 'drizzle-orm';
import authPlugin from '../../src/plugins/auth.js';
import { issueSessionTokens } from '../../src/lib/sessions.js';
import { MAX_CLIENTS, resetCodes, sweepMcpOAuth } from '../../src/lib/mcpOAuth.js';
import { mcpEndpointRoutes, mcpPolicyRoutes } from '../../src/modules/mcpHttp.js';
import { mcpOAuthConsentRoutes, mcpOAuthServerRoutes, mcpOAuthWellKnownRoutes } from '../../src/modules/mcpOAuth.js';
import { closeMigratedDb, migratedDb } from '../lib/githubAppKit.js';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  process.env['JWT_SECRET'] ??= 'x'.repeat(64);
});

let db: DB;
let app: FastifyInstance;
let session: string;
const REDIRECT = 'http://127.0.0.1:33418/callback';

beforeEach(async () => {
  db = await migratedDb();
  resetCodes();
  await db.insert(users).values({ id: 4, email: 'ops@example.com', passwordHash: 'x', isInstanceOperator: true } as never);
  session = (await issueSessionTokens(db, { id: 4, tokenVersion: 0 })).accessToken;
  app = Fastify({ logger: false });
  app.decorate('db', db as never);
  await app.register(authPlugin);
  await app.register(mcpOAuthWellKnownRoutes);
  await app.register(
    async (api) => {
      api.get('/services', { preHandler: [api.authenticate] }, async () => [{ id: 1, name: 'web' }]);
      api.post('/services/:id/deploys', { preHandler: [api.authenticate] }, async () => ({ deploymentId: 77 }));
      await api.register(mcpPolicyRoutes, { prefix: '/mcp/policy' });
      await api.register(mcpEndpointRoutes, { prefix: '/mcp' });
      await api.register(mcpOAuthServerRoutes, { prefix: '/oauth' });
      await api.register(mcpOAuthConsentRoutes, { prefix: '/oauth' });
    },
    { prefix: '/v1' },
  );
  await app.inject({ method: 'PUT', url: '/v1/mcp/policy', headers: { authorization: `Bearer ${session}` }, payload: { enabled: true } });
});
afterEach(async () => {
  await app.close();
  closeMigratedDb(db);
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const form = (body: Record<string, string>) => ({ 'content-type': 'application/x-www-form-urlencoded', payload: new URLSearchParams(body).toString() });
const token = (body: Record<string, string>) => {
  const f = form(body);
  return app.inject({ method: 'POST', url: '/v1/oauth/token', headers: { 'content-type': f['content-type'] }, payload: f.payload });
};
const register = async (redirectUris = [REDIRECT]) =>
  JSON.parse((await app.inject({ method: 'POST', url: '/v1/oauth/register', payload: { client_name: 'Claude', redirect_uris: redirectUris } })).body).client_id as string;

async function authorize(clientId: string, challenge: string, access: 'read' | 'full' = 'full', approve = true) {
  const request = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: 'http://localhost:80/v1/mcp',
  };
  const res = await app.inject({ method: 'POST', url: '/v1/oauth/authorize', headers: { authorization: `Bearer ${session}` }, payload: { request, approve, access } });
  return new URL(JSON.parse(res.body).redirect as string);
}

async function fullGrant(access: 'read' | 'full' = 'full') {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const back = await authorize(clientId, challenge, access);
  const res = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: 'http://localhost:80/v1/mcp' });
  return { clientId, res, body: JSON.parse(res.body) };
}

const mcp = (bearer: string, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/mcp',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify(body),
  });
const listServices = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_services', arguments: {} } };

describe('remote MCP OAuth (R4)', () => {
  it('points an unauthenticated client at the discovery documents', async () => {
    const res = await mcp('', listServices);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="ninedeploy-mcp", resource_metadata="http://localhost:80/.well-known/oauth-protected-resource/v1/mcp"');
    const prm = JSON.parse((await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/v1/mcp' })).body);
    expect(prm).toMatchObject({ resource: 'http://localhost:80/v1/mcp', authorization_servers: ['http://localhost:80'] });
    const as = JSON.parse((await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).body);
    expect(as).toMatchObject({
      issuer: 'http://localhost:80',
      authorization_endpoint: 'http://localhost:80/oauth/authorize',
      token_endpoint: 'http://localhost:80/v1/oauth/token',
      registration_endpoint: 'http://localhost:80/v1/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('answers nothing while remote MCP is off', async () => {
    await app.inject({ method: 'PUT', url: '/v1/mcp/policy', headers: { authorization: `Bearer ${session}` }, payload: { enabled: false } });
    expect((await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/oauth/register', payload: { redirect_uris: [REDIRECT] } })).statusCode).toBe(404);
  });

  it('registers public clients with https or loopback redirect addresses only', async () => {
    expect(await register()).toMatch(/^ndc_/);
    expect(await register(['https://claude.ai/api/mcp/auth_callback'])).toMatch(/^ndc_/);
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'https://x.example/cb#frag']) {
      const res = await app.inject({ method: 'POST', url: '/v1/oauth/register', payload: { redirect_uris: [bad] } });
      expect(res.statusCode, bad).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_redirect_uri');
    }
  });

  it('runs the code flow with PKCE; the token works on /v1/mcp as the user who consented', async () => {
    const { res, body } = await fullGrant();
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:full' });
    expect(body.access_token).toMatch(/^ndmcp_/);
    expect(body.refresh_token).toMatch(/^ndmcpr_/);
    const called = JSON.parse((await mcp(body.access_token, listServices)).body).result;
    expect(called.isError).toBeUndefined();
    expect(called.content[0].text).toContain('web');
    // The grant is an API token of its user, named after the client.
    const rows = await db.select().from(apiTokens);
    expect(rows).toEqual([expect.objectContaining({ userId: 4, name: 'MCP: Claude', scopes: [] })]);
  });

  it('the consent page sees the client and where it returns; a denial goes back with access_denied', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:read' });
    const seen = await app.inject({ method: 'GET', url: `/v1/oauth/authorize?${q}`, headers: { authorization: `Bearer ${session}` } });
    expect(JSON.parse(seen.body)).toEqual({ client: { name: 'Claude', redirectHost: '127.0.0.1:33418' }, requestedAccess: 'read' });
    const back = await authorize(clientId, challenge, 'full', false);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('st-1');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('refuses consent from an API token, an unregistered redirect, another resource, or no PKCE', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const base = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' };
    const ask = (request: Record<string, string>, bearer = session) =>
      app.inject({ method: 'POST', url: '/v1/oauth/authorize', headers: { authorization: `Bearer ${bearer}` }, payload: { request, approve: true } });
    expect((await ask({ ...base, redirect_uri: 'http://127.0.0.1:9/other' })).statusCode).toBe(400);
    expect((await ask({ ...base, resource: 'https://elsewhere.example/v1/mcp' })).statusCode).toBe(400);
    expect((await ask({ ...base, code_challenge_method: 'plain' })).statusCode).toBe(400);
    const { body } = await fullGrant();
    // An OAuth token is not a session either: it cannot approve grants (nor reach this route at all).
    expect((await ask(base, body.access_token)).statusCode).toBe(401);
  });

  it('a code is single use, bound to its client, redirect and verifier', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = (await authorize(clientId, challenge)).searchParams.get('code')!;
    const base = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier };
    expect(JSON.parse((await token({ ...base, code_verifier: pkce().verifier })).body).error).toBe('invalid_grant');
    // The failed attempt spent it.
    expect(JSON.parse((await token(base)).body).error).toBe('invalid_grant');
    const other = await register();
    const code2 = (await authorize(clientId, challenge)).searchParams.get('code')!;
    expect((await token({ ...base, code: code2, client_id: other })).statusCode).toBe(400);
    expect((await token({ ...base, client_id: 'ndc_unknown_client_id' })).statusCode).toBe(401);
    expect(JSON.parse((await token({ grant_type: 'password', client_id: clientId })).body).error).toBe('unsupported_grant_type');
  });

  it('read-only consent gives a read token: write tools are not offered', async () => {
    const { body } = await fullGrant('read');
    expect(body.scope).toBe('mcp:read');
    const tools = JSON.parse((await mcp(body.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain('list_services');
    expect(tools).not.toContain('deploy_service');
  });

  it('the token is for MCP only: the API refuses it directly', async () => {
    const { body } = await fullGrant();
    expect((await app.inject({ method: 'GET', url: '/v1/services', headers: { authorization: `Bearer ${body.access_token}` } })).statusCode).toBe(401);
    // A forged internal marker does not help.
    expect((await app.inject({ method: 'GET', url: '/v1/services', headers: { authorization: `Bearer ${body.access_token}`, 'x-nd-mcp-internal': 'guess' } })).statusCode).toBe(401);
  });

  it('rotates refresh tokens; the old access and refresh tokens stop working', async () => {
    const { clientId, body } = await fullGrant();
    const res = await token({ grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: clientId });
    const next = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(next.access_token).not.toBe(body.access_token);
    expect((await mcp(body.access_token, listServices)).statusCode).toBe(401);
    expect((await mcp(next.access_token, listServices)).statusCode).toBe(200);
    expect(JSON.parse((await token({ grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: clientId })).body).error).toBe('invalid_grant');
    // Same grant row, not a new one per refresh.
    expect(await db.select().from(apiTokens)).toHaveLength(1);
  });

  it('revocation (RFC 7009) and deleting the grant under API tokens both disconnect the client', async () => {
    const a = await fullGrant();
    expect((await app.inject({ method: 'POST', url: '/v1/oauth/revoke', ...form({ token: a.body.refresh_token }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(200);
    expect((await mcp(a.body.access_token, listServices)).statusCode).toBe(401);
    const b = await fullGrant();
    await db.delete(apiTokens);
    expect((await mcp(b.body.access_token, listServices)).statusCode).toBe(401);
    expect(JSON.parse((await token({ grant_type: 'refresh_token', refresh_token: b.body.refresh_token, client_id: b.clientId })).body).error).toBe('invalid_grant');
    // Unknown tokens are not an error.
    expect((await app.inject({ method: 'POST', url: '/v1/oauth/revoke', payload: { token: 'nonsense' } })).statusCode).toBe(200);
  });

  it('at the registration cap, the oldest never-used client makes room; clients in use are kept', async () => {
    const used = (await fullGrant()).clientId;
    const filler = Array.from({ length: MAX_CLIENTS - 1 }, (_, i) => ({
      key: `oauth_client:ndc_filler${String(i).padStart(8, '0')}`,
      value: { name: 'x', redirectUris: [REDIRECT], createdAt: 1000 + i, lastUsedAt: null } as never,
    }));
    await db.insert(settings).values(filler);
    expect(await register()).toMatch(/^ndc_/);
    const keys = (await db.select().from(settings).where(like(settings.key, 'oauth_client:%'))).map((r) => r.key);
    expect(keys).toHaveLength(MAX_CLIENTS);
    expect(keys).toContain(`oauth_client:${used}`);
    expect(keys).not.toContain('oauth_client:ndc_filler00000000');
  });

  it('the sweep removes expired refresh tokens with their grants, and clients never used', async () => {
    const used = await fullGrant();
    await register();
    const later = Date.now() + 31 * 24 * 3600_000;
    expect(await sweepMcpOAuth(db, later)).toBe(3); // the refresh row, its expired grant, the unused client
    expect(await db.select().from(apiTokens)).toHaveLength(0);
    const clients = await db.select().from(settings).where(like(settings.key, 'oauth_client:%'));
    expect(clients.map((c) => c.key)).toEqual([`oauth_client:${used.clientId}`]);
  });
});
