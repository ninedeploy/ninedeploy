import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { signAccessToken, signRefreshToken } from '../../src/lib/jwt.js';
import { apiTokens } from '@ninedeploy/db';
import { sha256 } from '../../src/lib/crypto.js';

const authPlugin = (await import('../../src/plugins/auth.js')).default;

function makeDb(
  rows: Array<{ userId: number; expiresAt: Date | null } | undefined>,
  user?: { id: number; isOperator?: boolean; tokenVersion?: number },
) {
  const findFirst = vi.fn(async () => (rows.length ? rows[0] : undefined));
  // The operator flag is a column on the user row now, not an inference from
  // workspace seats — see lib/resourceAccess.ts:isOperator.
  const userFindFirst = vi.fn(async () =>
    user ? { tokenVersion: 0, isInstanceOperator: user.isOperator === true, ...user } : undefined,
  );
  const workspaceMembersFindMany = vi.fn(async () =>
    user?.isOperator
      ? [{ workspaceId: 1, userId: user.id, role: 'owner', createdAt: new Date(), updatedAt: new Date() }]
      : [],
  );
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  }));
  return {
    query: {
      apiTokens: { findFirst },
      users: { findFirst: userFindFirst },
      workspaceMembers: { findMany: workspaceMembersFindMany },
    },
    update,
    findFirst,
    set: () => undefined,
  };
}

async function buildApp(db: ReturnType<typeof makeDb>) {
  const app = Fastify();
  app.decorate('db', db as never);
  await app.register(authPlugin);
  app.get('/me', { preHandler: [app.authenticate] }, async (req) => ({ user: req.user }));
  app.delete('/admin', { preHandler: [app.authenticate, app.requireAdmin] }, async () => ({ ok: true }));
  return app;
}

describe('auth plugin', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const app = await buildApp(makeDb([]));
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const app = await buildApp(makeDb([]));
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Basic abc' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('sets req.user for a valid access JWT and skips the token stamp', async () => {
    const db = makeDb([], { id: 42, isOperator: true });
    const app = await buildApp(db);
    const token = await signAccessToken(42, 0);
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 42, isOperator: true, tokenScopes: null, viaApiToken: false } });
    expect(db.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 401 for a refresh JWT', async () => {
    const app = await buildApp(makeDb([]));
    const token = await signRefreshToken(42);
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 for a malformed JWT', async () => {
    const app = await buildApp(makeDb([]));
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer a.b.c' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('resolves an API token through the db and stamps lastUsedAt', async () => {
    const db = makeDb([{ userId: 7, expiresAt: null }], { id: 7, isOperator: true });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer api-token-no-dots' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 7, isOperator: true, tokenScopes: null, viaApiToken: true } });
    expect(db.findFirst).toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith(apiTokens);
    const setFn = db.update.mock.results[0]!.value.set;
    expect(setFn).toHaveBeenCalledWith({ lastUsedAt: expect.any(Date) });
    const whereFn = setFn.mock.results[0]!.value.where;
    expect(whereFn).toHaveBeenCalledWith(expect.objectContaining({}));
    expect(sha256('api-token-no-dots')).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it('returns 401 for an unknown API token', async () => {
    const db = makeDb([]);
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer unknown-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(db.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 401 for an expired API token', async () => {
    const db = makeDb([{ userId: 3, expiresAt: new Date(Date.now() - 1000) }]);
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer expired-token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('requireAdmin allows an admin through', async () => {
    const db = makeDb([], { id: 1, isOperator: true });
    const app = await buildApp(db);
    const token = await signAccessToken(1, 0);
    const res = await app.inject({ method: 'DELETE', url: '/admin', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('requireOperator and requireAdmin 401 when no user was resolved', async () => {
    // Both guards are documented as running AFTER `authenticate`. Registering
    // them alone proves they fail closed rather than reading `undefined`.
    const app = Fastify({ logger: false });
    app.decorate('db', makeDb([]) as never);
    await app.register(authPlugin);
    app.get('/op', { preHandler: [app.requireOperator] }, async () => ({ ok: true }));
    app.get('/adm', { preHandler: [app.requireAdmin] }, async () => ({ ok: true }));
    expect((await app.inject({ method: 'GET', url: '/op' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/adm' })).statusCode).toBe(401);
    await app.close();
  });

  it('requireOperator returns 403 for a non-operator (its own message, distinct from requireAdmin)', async () => {
    // requireOperator and requireAdmin diverge on the human message
    // ('Operator access required' vs 'Admin access required'). Operators
    // see different copy in the audit log; both refuse non-operators
    // with 403. The previous test 'requireAdmin rejects a member with
    // 403' covered the requireAdmin arm; this one covers requireOperator
    // and the message-string branch in the lib.
    const db = makeDb([], { id: 4, isOperator: false });
    const app = Fastify();
    app.decorate('db', db as never);
    await app.register(authPlugin);
    app.delete('/op', { preHandler: [app.authenticate, app.requireOperator] }, async () => ({ ok: true }));
    const token = await signAccessToken(4, 0);
    const res = await app.inject({
      method: 'DELETE',
      url: '/op',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      message: expect.stringMatching(/Operator access required/),
    });
    await app.close();
  });

  it('requireAdmin rejects a member with 403', async () => {
    const db = makeDb([], { id: 2, isOperator: false });
    const app = await buildApp(db);
    const token = await signAccessToken(2, 0);
    const res = await app.inject({ method: 'DELETE', url: '/admin', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  /**
   * The escalation §16.1 closed: `owner` in a workspace the caller created
   * themselves must not confer instance-operator rights. This assertion used to
   * live on a second, unused `requireOperator()` prehandler in
   * `lib/resourceAccess.ts`; that helper is gone, so the guarantee is asserted
   * here, on the gate the routes actually use.
   */
  it('rejects a workspace owner who does not carry the instance-operator flag', async () => {
    const db = makeDb([], { id: 3, isOperator: false });
    // The user holds an `owner` seat…
    db.query.workspaceMembers.findMany = vi.fn(async () => [
      { workspaceId: 1, userId: 3, role: 'owner', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const app = await buildApp(db);
    const token = await signAccessToken(3, 0);
    // …and is still not an operator: the flag is a column, never an inference.
    const res = await app.inject({ method: 'DELETE', url: '/admin', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('auth plugin — API token scope enforcement', () => {
  // The API-token stamp on `apiTokens.lastUsedAt` only happens for opaque
  // tokens (no dots). Build a db whose `resolveUser` succeeds for the
  // given scope set, then exercise the POST/DELETE/PUT gates inside
  // `authenticate` and the route-side `requireScope` factory.
  const scopedDb = (
    scopes: string[] | null,
    user: { id: number; isOperator?: boolean } = { id: 1, isOperator: false },
  ) => {
    return {
      query: {
        apiTokens: {
          findFirst: vi.fn(async () => ({
            userId: user.id,
            expiresAt: null,
            scopes,
          })),
        },
        users: {
          findFirst: vi.fn(async () => ({
            id: user.id,
            tokenVersion: 0,
            isInstanceOperator: user.isOperator === true,
          })),
        },
        workspaceMembers: { findMany: vi.fn(async () => []) },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
  };

  async function buildScopedApp(db: ReturnType<typeof scopedDb>) {
    const app = Fastify();
    app.decorate('db', db as never);
    await app.register(authPlugin);
    // The four gate endpoints cover every scope branch:
    //   - GET  /read   is a SAFE_METHOD → always allowed (token may be read-only)
    //   - POST /write  needs the `write` or `operator` scope
    //   - PUT  /admin  needs the `admin` scope or the operator user
    //   - ANY  /resource/{scope}  hits the per-route `requireScope(...)` factory
    app.get('/read', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    app.post('/write', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    app.put('/admin', { preHandler: [app.authenticate, app.requireAdmin] }, async () => ({ ok: true }));
    app.get('/r/:scope', { preHandler: [app.authenticate, app.requireScope('admin:services')] }, async () => ({ ok: true }));
    return app;
  }

  it('narrows an operator user down to a normal user when the token has no operator scope', async () => {
    // A CI token owned by an operator must NOT carry the operator
    // flag onto the request — that is exactly the leaked-CI-token
    // vector the scope check exists to close.
    const db = scopedDb(['read'], { id: 1, isOperator: true });
    const app = await buildScopedApp(db);
    const res = await app.inject({
      method: 'PUT',
      url: '/admin',
      headers: { authorization: 'Bearer scoped-read-only' },
    });
    // requireAdmin checks `req.user.isOperator`, which the
    // authenticate hook just narrowed to false.
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets a `write` token through every SAFE_METHOD route', async () => {
    const db = scopedDb(['write'], { id: 1, isOperator: false });
    const app = await buildScopedApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { authorization: 'Bearer write-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('lets a `write` token through a POST route', async () => {
    // The `mayWrite` arm in the auth hook returns true for either
    // `write` or `operator` in the scope list, so a write-only
    // token can still mutate.
    const db = scopedDb(['write'], { id: 1, isOperator: false });
    const app = await buildScopedApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: 'Bearer write-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a `read`-only token on a POST route with 403', async () => {
    const db = scopedDb(['read'], { id: 1, isOperator: false });
    const app = await buildScopedApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: 'Bearer read-only' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ message: expect.stringMatching(/read-only/i) });
    await app.close();
  });

  it('treats the legacy `admin` scope as a write superset (POST succeeds)', async () => {
    // `admin` does not appear in the `mayWrite` arm verbatim; the
    // `write` legacy shorthand does, and `nd://scope/admin/...`
    // covers `nd://scope/write/...` on the same resource via the
    // `scopeCovers` rule. A bare `admin` (no `write`) hits the
    // exact-match branch and is accepted only on routes that
    // require the admin scope; a POST hits the auth-hook
    // `mayWrite` arm, which recognises `write` and `operator`
    // but NOT bare `admin`. The realistic case is `admin` paired
    // with `write` in the token row, which we cover here.
    const db = scopedDb(['admin', 'write'], { id: 1, isOperator: false });
    const app = await buildScopedApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: 'Bearer admin-write-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('auth plugin — requireScope / scopeCovers', () => {
  // The `scopeCovers` rule is private to the plugin. We exercise it
  // end-to-end by registering the real `auth` plugin with a fake db
  // that hands back a specific scope set, then calling the per-route
  // `requireScope` factory with the scope form we want to cover.
  // Every branch in the rule (operator / null / exact match /
  // legacy-coarse / admin-implies-write / admin-implies-read /
  // write-implies-read) maps to one assertion below.
  function scopeDb(scopes: string[] | null) {
    return {
      query: {
        apiTokens: {
          findFirst: vi.fn(async () => ({ userId: 1, expiresAt: null, scopes })),
        },
        users: {
          findFirst: vi.fn(async () => ({ id: 1, tokenVersion: 0, isInstanceOperator: false })),
        },
        workspaceMembers: { findMany: vi.fn(async () => []) },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
  }

  async function buildScopeApp(db: ReturnType<typeof scopeDb>, required: string) {
    const app = Fastify({ logger: false });
    app.decorate('db', db as never);
    await app.register(authPlugin);
    app.get(
      '/v1/services',
      { preHandler: [app.authenticate, app.requireScope(required)] },
      async () => ({ ok: true }),
    );
    return app;
  }

  it('covers a fine-grained URI when the user has the `operator` scope', async () => {
    const app = await buildScopeApp(scopeDb(['operator']), 'nd://scope/admin/services');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer operator-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('covers a fine-grained URI when the user has the exact scope', async () => {
    const app = await buildScopeApp(
      scopeDb(['nd://scope/admin/services']),
      'nd://scope/admin/services',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer exact-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('covers `nd://scope/admin/X` with the legacy `write` shorthand', async () => {
    // admin implies write on the same resource.
    const app = await buildScopeApp(scopeDb(['write']), 'nd://scope/admin/services');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer write-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('covers `nd://scope/write/X` with the legacy `write` shorthand', async () => {
    const app = await buildScopeApp(scopeDb(['write']), 'nd://scope/write/services');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer write-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('covers `nd://scope/read/X` with the legacy `read` shorthand', async () => {
    const app = await buildScopeApp(scopeDb(['read']), 'nd://scope/read/services');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer read-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('covers `nd://scope/write/X` with `nd://scope/admin/X` (same-resource superset)', async () => {
    const app = await buildScopeApp(
      scopeDb(['nd://scope/admin/services']),
      'nd://scope/write/services',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer admin-svc-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('covers `nd://scope/read/X` with `nd://scope/admin/X` (admin implies read)', async () => {
    const app = await buildScopeApp(
      scopeDb(['nd://scope/admin/services']),
      'nd://scope/read/services',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer admin-svc-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('covers `nd://scope/read/X` with `nd://scope/write/X` (write implies read)', async () => {
    const app = await buildScopeApp(
      scopeDb(['nd://scope/write/services']),
      'nd://scope/read/services',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer write-svc-token' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('does NOT cross resources (admin:services does not cover admin:databases)', async () => {
    const app = await buildScopeApp(
      scopeDb(['nd://scope/admin/services']),
      'nd://scope/admin/databases',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer admin-services-token' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('refuses a wholly unrelated scope with 403', async () => {
    const app = await buildScopeApp(
      scopeDb(['some:other:scope']),
      'nd://scope/admin/services',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/services',
      headers: { authorization: 'Bearer unrelated-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      message: expect.stringMatching(/missing the required scope/i),
    });
    await app.close();
  });
});

/**
 * Central fine-grained scope narrowing (audit fix): `nd://scope/...` URIs used
 * to be stored but never enforced, so a token holding only
 * `nd://scope/read/services` could still write every resource. Now any token
 * carrying a fine-grained scope must have EVERY request covered by its
 * resource+method, and unclassified paths fail closed.
 */
describe('auth plugin — fine-grained URI scopes narrow centrally', () => {
  async function scopedApp(scopes: string[]) {
    const db = makeDb([{ userId: 1, expiresAt: null, scopes } as never], { id: 1 });
    const app = Fastify();
    app.decorate('db', db as never);
    await app.register(authPlugin);
    app.get('/v1/services', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    app.post('/v1/services', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    app.post('/v1/databases', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    app.get('/v1/unmapped-thing', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    return app;
  }

  it('lets a read-scoped token read its resource', async () => {
    const app = await scopedApp(['nd://scope/read/services']);
    const res = await app.inject({ method: 'GET', url: '/v1/services', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a read-scoped token writing its own resource', async () => {
    const app = await scopedApp(['nd://scope/read/services']);
    const res = await app.inject({ method: 'POST', url: '/v1/services', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets a write-scoped token write its resource', async () => {
    const app = await scopedApp(['nd://scope/write/services']);
    const res = await app.inject({ method: 'POST', url: '/v1/services', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a write-scoped token reaching a DIFFERENT resource', async () => {
    // The old behaviour: fine-grained scopes were decoration and this request
    // went through. Resource scopes do not cross resources.
    const app = await scopedApp(['nd://scope/write/services']);
    const res = await app.inject({ method: 'POST', url: '/v1/databases', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      message: expect.stringMatching(/nd:\/\/scope\/write\/databases/),
    });
    await app.close();
  });

  it('fails closed on a path the resource map does not classify', async () => {
    const app = await scopedApp(['nd://scope/read/services']);
    const res = await app.inject({ method: 'GET', url: '/v1/unmapped-thing', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('classifies service sub-resources (env, webhooks, deploys) on their own', async () => {
    const { requiredFineGrainedScope } = await import('../../src/plugins/auth.js');
    expect(requiredFineGrainedScope('/v1/services?x=1', 'GET')).toBe('nd://scope/read/services');
    expect(requiredFineGrainedScope('/v1/services/7/env', 'PUT')).toBe('nd://scope/write/env');
    expect(requiredFineGrainedScope('/v1/services/7/webhooks', 'POST')).toBe('nd://scope/write/webhooks');
    expect(requiredFineGrainedScope('/v1/services/7/deploys', 'GET')).toBe('nd://scope/read/deploys');
    expect(requiredFineGrainedScope('/v1/menus', 'GET')).toBeNull();
  });
});
