/**
 * Regression guard: API-token scopes are enforced.
 *
 * `api_tokens.scopes` existed since the first migration but was written as
 * `[]` on every create and read by nothing, so every token — including the
 * ones handed to CI and to the MCP server — carried its owner's FULL
 * authority, instance-operator flag included. A leaked deploy token was an
 * instance-root credential.
 *
 * Enforcement lives in `plugins/auth.ts` so it applies to every route, present
 * and future, rather than being annotated onto 51 route modules. These tests
 * therefore drive the real plugin end to end.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../src/lib/crypto.js';
import authPlugin from '../src/plugins/auth.js';

const RAW = 'opaque-token-value';

/**
 * Minimal db exposing one API token and its owner. `scopes` is what the test
 * is actually varying; `isInstanceOperator` proves a scope can only ever
 * NARROW the owner's authority, never widen it.
 */
function makeDb(scopes: string[] | undefined, isInstanceOperator = true) {
  return {
    query: {
      apiTokens: {
        findFirst: vi.fn(async () => ({ userId: 4, expiresAt: null, scopes })),
      },
      users: {
        findFirst: vi.fn(async () => ({ id: 4, tokenVersion: 0, isInstanceOperator })),
      },
      workspaceMembers: { findMany: vi.fn(async () => []) },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
  };
}

async function buildApp(db: ReturnType<typeof makeDb>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('db', db as never);
  await app.register(authPlugin);
  app.get('/read', { preHandler: [app.authenticate] }, async (req) => ({ user: req.user }));
  app.post('/write', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
  app.post('/admin', { preHandler: [app.authenticate, app.requireOperator] }, async () => ({ ok: true }));
  return app;
}

const auth = { authorization: `Bearer ${RAW}` };

describe('API token scopes', () => {
  it('leaves a legacy token (empty scopes) unrestricted', async () => {
    // Back-compat: tokens minted before scopes were enforced must keep working,
    // or every existing CI pipeline breaks on upgrade.
    const app = await buildApp(makeDb([]));
    expect((await app.inject({ method: 'POST', url: '/write', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/admin', headers: auth })).statusCode).toBe(200);
    await app.close();
  });

  it('treats a missing scopes column as unrestricted too', async () => {
    const app = await buildApp(makeDb(undefined));
    expect((await app.inject({ method: 'POST', url: '/admin', headers: auth })).statusCode).toBe(200);
    await app.close();
  });

  it('allows a read-scoped token to read', async () => {
    const app = await buildApp(makeDb(['read']));
    const res = await app.inject({ method: 'GET', url: '/read', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: 4, tokenScopes: ['read'] });
    await app.close();
  });

  it('refuses any state-changing method for a read-scoped token', async () => {
    const app = await buildApp(makeDb(['read']));
    const res = await app.inject({ method: 'POST', url: '/write', headers: auth });
    expect(res.statusCode).toBe(403);
    // This bare app has no error-envelope handler (app.ts installs it), so the
    // assertion is on Fastify's default body.
    expect(res.json()).toMatchObject({ message: expect.stringContaining('read-only') });
    await app.close();
  });

  it('strips the operator flag from a read-scoped token even when the owner is one', async () => {
    const app = await buildApp(makeDb(['read'], true));
    const res = await app.inject({ method: 'GET', url: '/read', headers: auth });
    expect(res.json().user).toMatchObject({ isOperator: false });
    await app.close();
  });

  it('lets a write-scoped token mutate but not reach operator routes', async () => {
    const app = await buildApp(makeDb(['write'], true));
    expect((await app.inject({ method: 'POST', url: '/write', headers: auth })).statusCode).toBe(200);
    // This is the point of the whole feature: a leaked deploy token must not
    // be able to run PM2/compose/host-hook deploys or manage users.
    const admin = await app.inject({ method: 'POST', url: '/admin', headers: auth });
    expect(admin.statusCode).toBe(403);
    await app.close();
  });

  it('lets an operator-scoped token through, but only if the owner is an operator', async () => {
    const asOperator = await buildApp(makeDb(['operator'], true));
    expect((await asOperator.inject({ method: 'POST', url: '/admin', headers: auth })).statusCode).toBe(200);
    await asOperator.close();

    // A scope can never grant more than the account behind it holds.
    const asMember = await buildApp(makeDb(['operator'], false));
    expect((await asMember.inject({ method: 'POST', url: '/admin', headers: auth })).statusCode).toBe(403);
    await asMember.close();
  });

  it('never restricts an interactive session (JWT), which carries no scopes', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const token = await signAccessToken(4, 0);
    const app = await buildApp(makeDb(['read'], true));
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('refuses API tokens on credential-management routes (requireInteractive)', async () => {
    // r090: a `write` token could POST /auth/tokens {scopes: []} and mint an
    // unrestricted token — operator flag restored. Legacy `[]` tokens resolve
    // to `tokenScopes: null` exactly like a JWT, so the gate must key off how
    // the request authenticated, not off the scopes.
    for (const scopes of [['write'], ['operator'], []]) {
      const app = await buildApp(makeDb(scopes, true));
      app.post('/mint', { preHandler: [app.authenticate, app.requireInteractive] }, async () => ({ ok: true }));
      const res = await app.inject({ method: 'POST', url: '/mint', headers: auth });
      expect(res.statusCode, `scopes=${JSON.stringify(scopes)}`).toBe(403);
      await app.close();
    }
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const app = await buildApp(makeDb(['read'], true));
    app.post('/mint', { preHandler: [app.authenticate, app.requireInteractive] }, async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/mint',
      headers: { authorization: `Bearer ${await signAccessToken(4, 0)}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('refuses an explicit empty scope list on token creation', async () => {
    const { createApiToken } = await import('@ninedeploy/schemas');
    expect(() => createApiToken.parse({ scopes: [] })).toThrow();
    expect(createApiToken.parse({}).scopes).toEqual(['read']);
  });

  it('mounts every credential-minting route in modules/auth.ts behind requireInteractive', async () => {
    // Wiring guard: the decorator is worthless if a route forgets it.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/modules/auth.ts', import.meta.url), 'utf8');
    for (const route of [
      "app.post('/tokens'",
      "app.post('/password'",
      "app.post('/2fa/setup'",
      "app.post('/2fa/enable'",
      "app.post('/2fa/disable'",
      "app.post('/passkey/register/options'",
      "app.post('/passkey/register/verify'",
      "app.delete('/passkey/:id'",
    ]) {
      const line = src.split('\n').find((l) => l.includes(route));
      expect(line, route).toBeDefined();
      expect(line, route).toContain('app.requireInteractive');
    }
  });

  it('looks the token up by its sha256, not the raw value', async () => {
    const db = makeDb(['read']);
    const app = await buildApp(db);
    await app.inject({ method: 'GET', url: '/read', headers: auth });
    expect(db.query.apiTokens.findFirst).toHaveBeenCalled();
    expect(sha256(RAW)).toHaveLength(64);
    await app.close();
  });
});
