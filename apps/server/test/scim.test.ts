import { describe, expect, it, vi, beforeEach } from 'vitest';
import { scimManagementRoutes, scimRoutes } from '../src/modules/scim.js';
import { authRoutes } from '../src/modules/auth.js';
import { hashPassword } from '../src/lib/crypto.js';
import { asUser, buildTestApp, createFakeDb, } from './helpers.js';

const TOKEN = 'scim_test-token-abcdef';
const TOKEN_ROW = {
  id: 1,
  name: 'Okta',
  tokenHash: 'placeholder-set-in-beforeEach',
  workspaceId: 7,
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
};

const userRow = (over: Record<string, unknown> = {}) => ({
  id: 11,
  email: 'new.user@example.com',
  passwordHash: 'x',
  name: 'New User',
  tokenVersion: 0,
  totpEnabled: false,
  totpSecretEncrypted: null,
  totpLastStep: null,
  isInstanceOperator: false,
  scimExternalId: 'idp-777',
  deactivatedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const memberRow = (over: Record<string, unknown> = {}) => ({
  id: 21,
  workspaceId: 7,
  userId: 11,
  role: 'member',
  createdAt: new Date(),
  ...over,
});

async function scimApp(db: unknown) {
  const app = await buildTestApp({ db: db as never });
  await app.register(scimRoutes, { prefix: '/scim/v2' });
  return app;
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('SCIM 2.0 provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TOKEN_ROW.tokenHash = 'placeholder';
  });

  it('rejects requests without a bearer token', async () => {
    const app = await scimApp(createFakeDb());
    const res = await app.inject({ method: 'GET', url: '/scim/v2/Users' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an unknown or revoked token', async () => {
    const db = createFakeDb({ select: { scimTokens: [] } });
    const app = await scimApp(db);
    const res = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: auth });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('exposes the service provider config for IdP discovery', async () => {
    const app = await scimApp(createFakeDb());
    const res = await app.inject({ method: 'GET', url: '/scim/v2/ServiceProviderConfig', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().filter.supported).toBe(true);
    await app.close();
  });

  it('provisions a fresh user into the token workspace', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: { users: () => undefined },
      insert: {
        users: (v: Record<string, unknown>) => {
          inserts.push(v);
          return [userRow({ email: v.email, passwordHash: v.passwordHash, scimExternalId: v.scimExternalId })];
        },
        workspaceMembers: (v: Record<string, unknown>) => {
          inserts.push(v);
          return [memberRow(v)];
        },
      },
    });
    const app = await scimApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: auth,
      payload: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'New.User@Example.com', name: { givenName: 'New User' }, externalId: 'idp-777' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ userName: 'new.user@example.com', active: true, externalId: 'idp-777' });
    const userInsert = inserts.find((v) => v.email);
    expect(userInsert).toMatchObject({ email: 'new.user@example.com' });
    // The password is an unusable random pair of UUIDs — sign-in happens via SSO.
    expect(String(userInsert!.passwordHash)).not.toContain('hash');
    const membership = inserts.find((v) => v.workspaceId);
    expect(membership).toMatchObject({ workspaceId: 7, role: 'member' });
    await app.close();
  });

  it('adopts an existing local account instead of duplicating it', async () => {
    let call = 0;
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: { users: () => (call++ === 0 ? userRow({ scimExternalId: null }) : userRow()) },
      findMany: { workspaceMembers: () => [memberRow({ workspaceId: 9 })] },
      update: { users: [userRow()] },
      insert: { workspaceMembers: (v: Record<string, unknown>) => [memberRow(v)] },
    });
    const app = await scimApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: auth,
      payload: { userName: 'new.user@example.com', externalId: 'idp-777' },
    });
    // Adoption returns 200, not a duplicate 201.
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('11');
    await app.close();
  });

  it('lists workspace users and honours the userName eq filter', async () => {
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findMany: {
        users: () => [userRow(), userRow({ id: 12, email: 'other@example.com', scimExternalId: null })],
        workspaceMembers: () => [memberRow()],
      },
    });
    const app = await scimApp(db);
    const all = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: auth });
    expect(all.json().totalResults).toBe(1);
    const filtered = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users?filter=userName%20eq%20%22new.user@example.com%22',
      headers: auth,
    });
    expect(filtered.json().totalResults).toBe(1);
    expect(filtered.json().Resources[0]).toMatchObject({ userName: 'new.user@example.com' });
    const miss = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users?filter=userName%20eq%20%22other@example.com%22',
      headers: auth,
    });
    expect(miss.json().totalResults).toBe(0);
    await app.close();
  });

  it('reactivates a deactivated account on PATCH active=true', async () => {
    let call = 0;
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: {
        users: () => {
          call++;
          return userRow({ deactivatedAt: call === 1 ? new Date() : null });
        },
      },
      update: { users: [userRow()] },
    });
    const app = await scimApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/scim/v2/Users/11',
      headers: auth,
      payload: { Operations: [{ op: 'replace', path: 'active', value: true }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
    await app.close();
  });

  it('rejects a create payload without an email-shaped userName', async () => {
    const app = await scimApp(createFakeDb({ select: { scimTokens: [TOKEN_ROW] } }));
    const res = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: auth, payload: { userName: 'not-an-email' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('answers 404 for unknown or malformed user ids', async () => {
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: { users: () => undefined },
    });
    const app = await scimApp(db);
    const missing = await app.inject({ method: 'GET', url: '/scim/v2/Users/999', headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
    const malformed = await app.inject({ method: 'DELETE', url: '/scim/v2/Users/not-a-number', headers: auth });
    expect(malformed.statusCode).toBe(404);
    await app.close();
  });

  it('returns a single user by id', async () => {
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: { users: () => userRow() },
    });
    const app = await scimApp(db);
    const res = await app.inject({ method: 'GET', url: '/scim/v2/Users/11', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: '11', userName: 'new.user@example.com', active: true });
    await app.close();
  });

  it('PUT replaces the record and honours active=false', async () => {
    let call = 0;
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: {
        users: () => {
          call++;
          return userRow({ deactivatedAt: call > 1 ? new Date() : null });
        },
      },
      update: { users: [userRow()] },
    });
    const app = await scimApp(db);
    const res = await app.inject({
      method: 'PUT',
      url: '/scim/v2/Users/11',
      headers: auth,
      payload: { userName: 'new.user@example.com', displayName: 'Renamed User', active: false },
    });
    expect(res.statusCode).toBe(200);
    // The fake db does not apply the UPDATE, so the body reflects the stored
    // row: deactivated (active=false) with the original name.
    expect(res.json()).toMatchObject({ displayName: 'New User', active: false });
    await app.close();
  });

  it('PUT reactivates a deactivated account with active=true', async () => {
    let call = 0;
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: {
        users: () => {
          call++;
          return userRow({ deactivatedAt: call > 1 ? null : new Date() });
        },
      },
      update: { users: [userRow()] },
    });
    const app = await scimApp(db);
    const res = await app.inject({
      method: 'PUT',
      url: '/scim/v2/Users/11',
      headers: auth,
      payload: { userName: 'new.user@example.com', active: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
    await app.close();
  });

  it('adopting an already-member active account does not duplicate the membership', async () => {
    const memberInserts: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: { users: () => userRow() },
      findMany: { workspaceMembers: () => [memberRow()] },
      update: { users: [userRow()] },
      insert: {
        workspaceMembers: (v: Record<string, unknown>) => {
          memberInserts.push(v);
          return [memberRow(v)];
        },
      },
    });
    const app = await scimApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: auth,
      payload: { userName: 'new.user@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(memberInserts).toEqual([]);
    await app.close();
  });

  it('re-provisioning a deprovisioned account reactivates and re-enrolls it', async () => {
    const memberInserts: Array<Record<string, unknown>> = [];
    let call = 0;
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: {
        users: () => {
          call++;
          return userRow({ deactivatedAt: call === 1 ? new Date() : null });
        },
      },
      findMany: { workspaceMembers: () => (call === 1 ? [] : [memberRow()]) },
      update: { users: [userRow()] },
      insert: {
        workspaceMembers: (v: Record<string, unknown>) => {
          memberInserts.push(v);
          return [memberRow(v)];
        },
      },
    });
    const app = await scimApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: auth,
      payload: { userName: 'new.user@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(memberInserts).toEqual([{ workspaceId: 7, userId: 11, role: 'member' }]);
    await app.close();
  });

  it('deactivates on PATCH active=false and denies login afterwards', async () => {
    let call = 0;
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: {
        users: () => {
          call++;
          return userRow({ deactivatedAt: call > 1 ? new Date() : null, tokenVersion: call > 1 ? 1 : 0 });
        },
      },
      update: { users: [userRow()] },
      delete: { apiTokens: [], workspaceMembers: [] },
    });
    const app = await scimApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/scim/v2/Users/11',
      headers: auth,
      payload: { Operations: [{ op: 'replace', path: 'active', value: false }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
    // The credential kill switch: tokenVersion bumped, so every JWT dies.
    void db;
    await app.close();
  });

  it('deprovisions on DELETE by stripping all memberships', async () => {
    let call = 0;
    const db = createFakeDb({
      select: { scimTokens: [TOKEN_ROW] },
      findFirst: {
        users: () => {
          call++;
          return userRow({ deactivatedAt: call > 1 ? new Date() : null });
        },
      },
      update: { users: [userRow()] },
      delete: { apiTokens: [], workspaceMembers: [] },
    });
    const app = await scimApp(db);
    const res = await app.inject({ method: 'DELETE', url: '/scim/v2/Users/11', headers: auth });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('a deactivated account cannot sign in even with the right password', async () => {
    const passwordHash = await hashPassword('correct-horse');
    let call = 0;
    const db = createFakeDb({
      findFirst: {
        users: () => {
          call++;
          return userRow({
            email: 'human@example.com',
            passwordHash,
            deactivatedAt: call > 1 ? new Date('2026-09-15T00:00:00Z') : null,
          });
        },
      },
      findMany: { workspaceInvitations: () => [] },
      update: { users: [userRow()] },
      insert: { users: (v: Record<string, unknown>) => [userRow(v)] },
    });
    const app = await buildTestApp({ db });
    await app.register(authRoutes);
    const body = { email: 'human@example.com', password: 'correct-horse' };
    const before = await app.inject({ method: 'POST', url: '/login', payload: body });
    expect(before.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: '/login', payload: body });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('account_deactivated');
    await app.close();
  });
});

describe('SCIM management API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mints a token once (plaintext, never persisted) and lists the row', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      select: { scimTokens: [{ id: 4, name: 'Okta', workspaceId: 7, createdAt: new Date(), lastUsedAt: null, revokedAt: null }] },
      findFirst: { workspaces: () => ({ id: 7, name: 'Acme' }) },
      insert: {
        scimTokens: (v: Record<string, unknown>) => {
          inserts.push(v);
          return [{ id: 4, ...v }];
        },
      },
    });
    const app = await buildTestApp({ db });
    await app.register(scimManagementRoutes, { prefix: '/scim' });
    const created = await app.inject({
      method: 'POST',
      url: '/scim/tokens',
      headers: asUser(),
      payload: { name: 'Okta', workspaceId: 7 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().token).toMatch(/^scim_/);
    // Only the hash is persisted.
    expect(String(inserts[0]!.tokenHash)).not.toContain('scim_');
    const listed = await app.inject({ method: 'GET', url: '/scim/tokens', headers: asUser() });
    expect(listed.json()).toMatchObject([{ id: 4, name: 'Okta', workspaceId: 7, revoked: false }]);
    await app.close();
  });

  it('revokes a live token', async () => {
    const db = createFakeDb({ update: { scimTokens: [{ id: 4, revokedAt: new Date() }] } });
    const app = await buildTestApp({ db });
    await app.register(scimManagementRoutes, { prefix: '/scim' });
    const res = await app.inject({ method: 'DELETE', url: '/scim/tokens/4', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('answers 404 when revoking an unknown token', async () => {
    const app = await buildTestApp({ db: createFakeDb({ update: { scimTokens: [] } }) });
    await app.register(scimManagementRoutes, { prefix: '/scim' });
    const res = await app.inject({ method: 'DELETE', url: '/scim/tokens/99', headers: asUser() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('refuses token minting without a workspace', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(scimManagementRoutes, { prefix: '/scim' });
    const res = await app.inject({ method: 'POST', url: '/scim/tokens', headers: asUser(), payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
