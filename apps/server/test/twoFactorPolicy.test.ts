/**
 * G1.4 workspace-enforced 2FA against a real migrated SQLite and the real
 * auth plugin. What counts is what the session proved when it signed in
 * (`amr: mfa`), not which credentials the account holds: a password-only
 * session of a member is held to the enrolment routes; an SSO session is
 * exempt only for a provider the workspace lists; API tokens are not held.
 */
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTokens, createDb, runMigrations, users, webauthnCredentials, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { default: authPlugin } = await import('../src/plugins/auth.js');
const { twoFactorRequirementRoutes, workspaceTwoFactorRoutes } = await import('../src/modules/twoFactorPolicy.js');
const { issueSessionTokens } = await import('../src/lib/sessions.js');
const { sha256 } = await import('../src/lib/crypto.js');
const { verifyJwt } = await import('../src/lib/jwt.js');
const { isEnrolmentRoute, resetTwoFactorPolicyCache } = await import('../src/lib/twoFactorPolicy.js');

let db: DB;
let app: FastifyInstance;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function makeUser(email: string, values: Record<string, unknown> = {}) {
  const [row] = await db.insert(users).values({ email, passwordHash: 'hash', ...values } as never).returning();
  return row!;
}

beforeEach(async () => {
  resetTwoFactorPolicyCache();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  app = Fastify({ logger: false });
  app.decorate('db', db);
  await app.register(authPlugin);
  await app.register(twoFactorRequirementRoutes, { prefix: '/v1/auth/2fa' });
  await app.register(workspaceTwoFactorRoutes, { prefix: '/v1/workspaces' });
});
afterEach(async () => {
  await app.close();
});

async function setup() {
  const admin = await makeUser('admin@example.com', { totpEnabled: true });
  const member = await makeUser('member@example.com');
  const [ws] = await db.insert(workspaces).values({ name: 'Acme', slug: 'acme', ownerId: admin.id }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, userId: admin.id, role: 'owner' },
    { workspaceId: ws!.id, userId: member.id, role: 'member' },
  ]);
  const adminToken = (await issueSessionTokens(db, admin, { method: { amr: 'mfa' } })).accessToken;
  return { admin, member, ws: ws!, adminToken };
}

const set = (wsId: number, token: string, body: unknown) =>
  app.inject({ method: 'PUT', url: `/v1/workspaces/${wsId}/two-factor`, headers: bearer(token), payload: body as object });
const probe = (wsId: number, token: string) => app.inject({ method: 'GET', url: `/v1/workspaces/${wsId}/two-factor`, headers: bearer(token) });
const body = (res: { json: () => unknown }) => JSON.stringify(res.json());

describe('workspace two-factor requirement', () => {
  it('holds a session that did not prove a second factor, until one that did', async () => {
    const { member, ws, adminToken } = await setup();
    const passwordOnly = (await issueSessionTokens(db, member)).accessToken;
    // Off: everything answers.
    expect((await probe(ws.id, passwordOnly)).statusCode).toBe(200);

    const on = await set(ws.id, adminToken, { required: true });
    expect(on.json()).toEqual({ required: true, ssoExemptProviders: [], membersWithout: 1 });

    const held = await probe(ws.id, passwordOnly);
    expect(held.statusCode).toBe(403);
    expect(body(held)).toContain('two_factor_required');
    expect((await app.inject({ method: 'GET', url: '/v1/auth/2fa/requirement', headers: bearer(passwordOnly) })).json()).toEqual({
      required: true,
      enrolled: false,
      verified: false,
      workspaces: [{ id: ws.id, name: 'Acme' }],
    });

    // Holding a passkey is not enough: the password-only session stays held.
    await db.insert(webauthnCredentials).values({ userId: member.id, credentialId: 'cred', publicKey: 'pk', name: 'key' });
    expect((await probe(ws.id, passwordOnly)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/2fa/requirement', headers: bearer(passwordOnly) })).json()).toMatchObject({
      enrolled: true,
      verified: false,
    });

    // A session that signed in with the passkey passes.
    const withPasskey = (await issueSessionTokens(db, member, { method: { amr: 'mfa' } })).accessToken;
    expect((await probe(ws.id, withPasskey)).statusCode).toBe(200);
  });

  it('exempts SSO sessions only from the providers the workspace lists, and never holds API tokens', async () => {
    const { member, ws, adminToken } = await setup();
    const sso = (await issueSessionTokens(db, member, { method: { amr: 'sso', idp: 'oidc:4' } })).accessToken;
    const otherIdp = (await issueSessionTokens(db, member, { method: { amr: 'sso', idp: 'oidc:5' } })).accessToken;
    await set(ws.id, adminToken, { required: true });
    expect((await probe(ws.id, sso)).statusCode).toBe(403);
    expect((await set(ws.id, adminToken, { required: true, ssoExemptProviders: ['oidc:4'] })).json()).toMatchObject({ ssoExemptProviders: ['oidc:4'] });
    expect((await probe(ws.id, sso)).statusCode).toBe(200);
    expect((await probe(ws.id, otherIdp)).statusCode).toBe(403);
    expect((await set(ws.id, adminToken, { required: true, ssoExemptProviders: ['github'] })).statusCode).toBeGreaterThanOrEqual(400);

    await db.insert(apiTokens).values({ userId: member.id, name: 'ci', hash: sha256('nd_cli_token_value'), scopes: [] } as never);
    expect((await probe(ws.id, 'nd_cli_token_value')).statusCode).toBe(200);
  });

  it('only admins and owners change it, and only from a session that passes it', async () => {
    const { member, ws } = await setup();
    const memberToken = (await issueSessionTokens(db, member)).accessToken;
    expect((await set(ws.id, memberToken, { required: true })).statusCode).toBe(403);
    await db.update(workspaceMembers).set({ role: 'admin' }).where(eq(workspaceMembers.userId, member.id));
    const refused = await set(ws.id, memberToken, { required: true });
    expect(refused.statusCode).toBe(409);
    expect(body(refused)).toContain('enrol_first');
    expect((await set(ws.id, memberToken, { required: false })).json()).toMatchObject({ required: false });
    const mfa = (await issueSessionTokens(db, member, { method: { amr: 'mfa' } })).accessToken;
    expect((await set(ws.id, mfa, { required: true, extra: 1 })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await set(ws.id, mfa, { required: true })).statusCode).toBe(200);
  });

  it('does not hold members of other workspaces', async () => {
    const { ws, adminToken } = await setup();
    const outsider = await makeUser('out@example.com');
    const [own] = await db.insert(workspaces).values({ name: 'Own', slug: 'own', ownerId: outsider.id }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: own!.id, userId: outsider.id, role: 'owner' });
    await set(ws.id, adminToken, { required: true });
    const token = (await issueSessionTokens(db, outsider)).accessToken;
    expect((await probe(own!.id, token)).statusCode).toBe(200);
  });

  it('carries the sign-in method in both tokens of the pair', async () => {
    const { member } = await setup();
    const pair = await issueSessionTokens(db, member, { method: { amr: 'sso', idp: 'oidc:4' } });
    expect(await verifyJwt(pair.accessToken)).toMatchObject({ amr: 'sso', idp: 'oidc:4' });
    expect(await verifyJwt(pair.refreshToken)).toMatchObject({ amr: 'sso', idp: 'oidc:4' });
  });
});

describe('isEnrolmentRoute', () => {
  it('allows who-am-I, the requirement and logout; setup only for an account with no second factor', () => {
    expect(isEnrolmentRoute('GET', '/v1/auth/me', true)).toBe(true);
    expect(isEnrolmentRoute('GET', '/v1/auth/2fa/requirement?x=1', true)).toBe(true);
    expect(isEnrolmentRoute('POST', '/v1/auth/logout', true)).toBe(true);
    expect(isEnrolmentRoute('POST', '/v1/auth/2fa/setup', false)).toBe(true);
    expect(isEnrolmentRoute('POST', '/v1/auth/passkey/register/verify', false)).toBe(true);
    expect(isEnrolmentRoute('POST', '/v1/auth/2fa/setup', true)).toBe(false);
    expect(isEnrolmentRoute('POST', '/v1/auth/passkey/register/options', true)).toBe(false);
    expect(isEnrolmentRoute('POST', '/v1/auth/tokens', false)).toBe(false);
    expect(isEnrolmentRoute('POST', '/v1/auth/2fa/disable', false)).toBe(false);
    expect(isEnrolmentRoute('GET', '/v1/services', false)).toBe(false);
    expect(isEnrolmentRoute('POST', '/v1/auth/me', false)).toBe(false);
  });
});
