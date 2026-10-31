/**
 * R4 remote MCP over Streamable HTTP (`modules/mcpHttp.ts`), driven end to
 * end: the real auth plugin, real API tokens on a migrated SQLite, JSON-RPC
 * over HTTP. The API routes the tools reach are stand-ins behind the real
 * `authenticate`, so the token's scopes are enforced per tool call exactly as
 * on the real routes.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTokens, users, type DB } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { sha256 } from '../../src/lib/crypto.js';
import authPlugin from '../../src/plugins/auth.js';
import { mcpEndpointRoutes, mcpPolicyRoutes } from '../../src/modules/mcpHttp.js';
import { closeMigratedDb, migratedDb } from '../lib/githubAppKit.js';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

const FULL = 'nd_full_token_value_0001';
const READ = 'nd_read_token_value_0002';
const FINE = 'nd_fine_token_value_0003';
const MEMBER = 'nd_member_token_value_04';

let db: DB;
let app: FastifyInstance;
const deploys: number[] = [];

beforeEach(async () => {
  db = await migratedDb();
  deploys.length = 0;
  await db.insert(users).values([
    { id: 4, email: 'ops@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: 5, email: 'member@example.com', passwordHash: 'x' },
  ] as never);
  await db.insert(apiTokens).values([
    { userId: 4, name: 'full', hash: sha256(FULL), scopes: [] },
    { userId: 4, name: 'read', hash: sha256(READ), scopes: ['read'] },
    { userId: 4, name: 'fine', hash: sha256(FINE), scopes: ['nd://scope/read/services'] },
    { userId: 5, name: 'member', hash: sha256(MEMBER), scopes: [] },
  ]);
  app = Fastify({ logger: false });
  app.decorate('db', db as never);
  await app.register(authPlugin);
  await app.register(
    async (api) => {
      api.get('/services', { preHandler: [api.authenticate] }, async (req) => [{ id: 1, name: 'web', seenBy: req.user!.id, ip: req.ip }]);
      api.post('/services/:id/deploys', { preHandler: [api.authenticate, api.requireOperator] }, async (req) => {
        deploys.push(Number((req.params as { id: string }).id));
        return { deploymentId: 77 };
      });
      await api.register(mcpPolicyRoutes, { prefix: '/mcp/policy' });
      await api.register(mcpEndpointRoutes, { prefix: '/mcp' });
    },
    { prefix: '/v1' },
  );
});
afterEach(async () => {
  await app.close();
  closeMigratedDb(db);
});

const rpc = (token: string | null, body: unknown, extra: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    payload: JSON.stringify(body),
  });
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
const call = (name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
const toolNames = async (token: string) => (JSON.parse((await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body).result.tools as Array<{ name: string }>).map((t) => t.name);
const enable = (patch: Record<string, boolean>) =>
  app.inject({ method: 'PUT', url: '/v1/mcp/policy', headers: { authorization: `Bearer ${FULL}` }, payload: patch });

describe('remote MCP over Streamable HTTP (R4)', () => {
  it('is off by default, and only an operator turns it on', async () => {
    expect((await rpc(FULL, INIT)).statusCode).toBe(404);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/v1/mcp/policy', headers: { authorization: `Bearer ${FULL}` } })).body)).toEqual({
      policy: { enabled: false, readOnly: false },
      path: '/v1/mcp',
    });
    // A read-only token cannot change it (the PUT is a write).
    expect((await app.inject({ method: 'PUT', url: '/v1/mcp/policy', headers: { authorization: `Bearer ${READ}` }, payload: { enabled: true } })).statusCode).toBe(403);
    // A malformed patch is refused (400 behind the app's error handler) and changes nothing.
    expect((await app.inject({ method: 'PUT', url: '/v1/mcp/policy', headers: { authorization: `Bearer ${FULL}` }, payload: { enabled: 'yes' } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await rpc(FULL, INIT)).statusCode).toBe(404);
    expect((await enable({ enabled: true })).statusCode).toBe(200);
    expect((await rpc(FULL, INIT)).statusCode).toBe(200);
  });

  it('initializes, lists tools and runs them as the token, from the caller address', async () => {
    await enable({ enabled: true });
    const init = await rpc(FULL, INIT);
    expect(JSON.parse(init.body).result.serverInfo.name).toBe('ninedeploy');
    // Stateless: no session id handed out.
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect(await toolNames(FULL)).toEqual(expect.arrayContaining(['list_services', 'deploy_service']));
    const listed = JSON.parse((await rpc(FULL, call('list_services'), { 'x-forwarded-for': '' })).body).result;
    expect(listed.isError).toBeUndefined();
    expect(JSON.parse(listed.content[0].text)).toEqual([{ id: 1, name: 'web', seenBy: 4, ip: '127.0.0.1' }]);
    const deployed = JSON.parse((await rpc(FULL, call('deploy_service', { serviceId: 9 }))).body).result;
    expect(JSON.parse(deployed.content[0].text)).toEqual({ deploymentId: 77 });
    expect(deploys).toEqual([9]);
  });

  it('a read-only token reads; write tools are not offered, and calling one does nothing', async () => {
    await enable({ enabled: true });
    expect(JSON.parse((await rpc(READ, call('list_services'))).body).result.isError).toBeUndefined();
    expect(await toolNames(READ)).not.toContain('deploy_service');
    const refused = JSON.parse((await rpc(READ, call('deploy_service', { serviceId: 9 }))).body).result;
    expect(refused.isError).toBe(true);
    expect(deploys).toEqual([]);
  });

  it('each tool call is authorized by the API route it reaches, as the token owner', async () => {
    await enable({ enabled: true });
    // A member's unrestricted token is offered deploy_service; the route (operator-only here) refuses it.
    expect(await toolNames(MEMBER)).toContain('deploy_service');
    const refused = JSON.parse((await rpc(MEMBER, call('deploy_service', { serviceId: 9 }))).body).result;
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('403');
    expect(deploys).toEqual([]);
  });

  it('a resource-scoped token sees only its tools, and the route enforces the scope too', async () => {
    await enable({ enabled: true });
    const names = await toolNames(FINE);
    expect(names).toContain('list_services');
    expect(names).not.toContain('deploy_service');
    // Calling a hidden tool directly is still refused (unknown tool here; the route would 403 anyway).
    expect(JSON.parse((await rpc(FINE, call('deploy_service', { serviceId: 9 }))).body).result?.isError ?? true).toBe(true);
    expect(deploys).toEqual([]);
  });

  it('the operator read-only switch narrows every caller to the read-only allowlist', async () => {
    await enable({ enabled: true, readOnly: true });
    const names = await toolNames(FULL);
    expect(names).toContain('list_services');
    expect(names).not.toContain('deploy_service');
  });

  it('refuses a missing, unknown, expired or revoked token with a Bearer challenge; revocation takes effect on the next request', async () => {
    await enable({ enabled: true });
    for (const token of [null, 'nope']) {
      const res = await rpc(token, INIT);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="ninedeploy-mcp"');
    }
    expect((await rpc(FULL, INIT)).statusCode).toBe(200);
    await db.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiTokens.hash, sha256(READ)));
    expect((await rpc(READ, INIT)).statusCode).toBe(401);
    await db.delete(apiTokens).where(eq(apiTokens.hash, sha256(FULL)));
    expect((await rpc(FULL, call('list_services'))).statusCode).toBe(401);
  });

  it('refuses a browser request from another origin (DNS rebinding), and allows its own', async () => {
    await enable({ enabled: true });
    expect((await rpc(FULL, INIT, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await rpc(FULL, INIT, { origin: 'not a url' })).statusCode).toBe(403);
    expect((await rpc(FULL, INIT, { origin: 'http://localhost:80' })).statusCode).toBe(200);
  });

  it('is stateless: GET and DELETE answer 405 with Allow: POST', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/v1/mcp', headers: { authorization: `Bearer ${FULL}` } });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });
});
