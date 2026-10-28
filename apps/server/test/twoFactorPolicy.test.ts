/**
 * G1.4 workspace-enforced 2FA against a real migrated SQLite and the real
 * auth plugin: a member of a workspace that requires 2FA, signed in without
 * TOTP or a passkey, reaches only the enrolment routes; SSO sessions are
 * exempt when the workspace says so; API tokens are not held.
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
  const adminToken = (await issueSessionTokens(db, admin)).accessToken;
  return { admin, member, ws: ws!, adminToken };
}

const set = (wsId: number, token: string, body: unknown) =>
  app.inject({ method: 'PUT', url: `/v1/workspaces/${wsId}/two-factor`, headers: bearer(token), payload: body as object });

describe('workspace two-factor requirement', () => {
  it('holds a member without 2FA to the enrolment routes until they enrol', async () => {
    const { member, ws, adminToken } = await setup();
    const memberToken = (await issueSessionTokens(db, member)).accessToken;
    // Off: everything answers.
    expect((await app.inject({ method: 'GET', url: `/v1/workspaces/${ws.id}/two-factor`, headers: bearer(memberToken) })).statusCode).toBe(200);

    const on = await set(ws.id, adminToken, { required: true });
    expect(on.json()).toEqual({ required: true, ssoExempt: false, membersWithout: 1 });

    const held = await app.inject({ method: 'GET', url: `/v1/workspaces/${ws.id}/two-factor`, headers: bearer(memberToken) });
    expect(held.statusCode).toBe(403);
    expect(held.json().error?.code ?? held.json().code).toBe('two_factor_required');
    expect((await app.inject({ method: 'GET', url: '/v1/auth/2fa/requirement', headers: bearer(memberToken) })).json()).toEqual({
      required: true,
      enrolled: false,
      workspaces: [{ id: ws.id, name: 'Acme' }],
    });

    // A passkey counts.
    await db.insert(webauthnCredentials).values({ userId: member.id, credentialId: 'cred', publicKey: 'pk', name: 'key' });
    expect((await app.inject({ method: 'GET', url: `/v1/workspaces/${ws.id}/two-factor`, headers: bearer(memberToken) })).statusCode).toBe(200);
  });

  it('exempts SSO sessions only when the workspace says so, and never holds API tokens', async () => {
    const { member, ws, adminToken } = await setup();
    const sso = (await issueSessionTokens(db, member, { amr: 'sso' })).accessToken;
    await set(ws.id, adminToken, { required: true });
    expect((await app.inject({ method: 'GET', url: `/v1/workspaces/${ws.id}/two-factor`, headers: bearer(sso) })).statusCode).toBe(403);
    await set(ws.id, adminToken, { required: true, ssoExempt: true });
    expect((await app.inject({ method: 'GET', url: `/v1/workspaces/${ws.id}/two-factor`, headers: bearer(sso) })).statusCode).toBe(200);

    await db.insert(apiTokens).values({ userId: member.id, name: 'ci', hash: sha256('nd_cli_token_value'), scopes: [] } as never);
    expect((await app.inject({ method: 'GET', url: `/v1/workspaces/${ws.id}/two-factor`, headers: bearer('nd_cli_token_value') })).statusCode).toBe(200);
  });

  it('only admins and owners change it, and only once they have 2FA themselves', async () => {
    const { member, ws } = await setup();
    const memberToken = (await issueSessionTokens(db, member)).accessToken;
    expect((await set(ws.id, memberToken, { required: true })).statusCode).toBe(403);
    await db.update(workspaceMembers).set({ role: 'admin' }).where(eq(workspaceMembers.userId, member.id));
    const refused = await set(ws.id, memberToken, { required: true });
    expect(refused.statusCode).toBe(409);
    expect(JSON.stringify(refused.json())).toContain('enrol_first');
    expect((await set(ws.id, memberToken, { required: false })).json()).toMatchObject({ required: false });
    expect((await set(ws.id, memberToken, { required: true, extra: 1 })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('does not hold members of other workspaces', async () => {
    const { ws, adminToken } = await setup();
    const outsider = await makeUser('out@example.com');
    const [own] = await db.insert(workspaces).values({ name: 'Own', slug: 'own', ownerId: outsider.id }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: own!.id, userId: outsider.id, role: 'owner' });
    await set(ws.id, adminToken, { required: true });
    const token = (await issueSessionTokens(db, outsider)).accessToken;
    expect((await app.inject({ method: 'GET', url: `/v1/workspaces/${own!.id}/two-factor`, headers: bearer(token) })).statusCode).toBe(200);
  });
});

describe('isEnrolmentRoute', () => {
  it('allows who-am-I, the requirement, TOTP and passkey setup and logout, nothing else', () => {
    expect(isEnrolmentRoute('GET', '/v1/auth/me')).toBe(true);
    expect(isEnrolmentRoute('GET', '/v1/auth/2fa/requirement?x=1')).toBe(true);
    expect(isEnrolmentRoute('POST', '/v1/auth/2fa/setup')).toBe(true);
    expect(isEnrolmentRoute('POST', '/v1/auth/passkey/register/verify')).toBe(true);
    expect(isEnrolmentRoute('POST', '/v1/auth/logout')).toBe(true);
    expect(isEnrolmentRoute('POST', '/v1/auth/tokens')).toBe(false);
    expect(isEnrolmentRoute('POST', '/v1/auth/2fa/disable')).toBe(false);
    expect(isEnrolmentRoute('GET', '/v1/services')).toBe(false);
    expect(isEnrolmentRoute('POST', '/v1/auth/me')).toBe(false);
  });
});
