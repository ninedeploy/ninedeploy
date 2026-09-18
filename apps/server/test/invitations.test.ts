import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptInvitationRoutes,
  acceptInvitationsForUser,
  createOrRefreshInvitation,
  findPendingInvitationByToken,
  generateInvitationToken,
  invitationRoutes,
  publicInvitationRoutes,
  tokensMatch,
} from '../src/modules/invitations.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';
import { sha256 } from '../src/lib/crypto.js';

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);
const notifierMocks = vi.hoisted(() => ({ sendSystemEmail: vi.fn(async () => true) }));
vi.mock('../src/lib/notifier.js', () => notifierMocks);

const workspaceRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Acme Workspace',
  slug: 'acme-workspace',
  description: 'Primary workspace',
  ownerId: 2,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const memberRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  workspaceId: 1,
  userId: 2,
  role: 'owner',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const userRow = (over: Record<string, unknown> = {}) => ({
  id: 2,
  email: 'alice@example.com',
  name: 'Alice Dev',
  role: 'member',
  ...over,
});

const invitationRow = (over: Record<string, unknown> = {}) => ({
  id: 50,
  workspaceId: 1,
  email: 'bob@example.com',
  role: 'member',
  token: 'a'.repeat(64),
  invitedByUserId: 2,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  acceptedAt: null,
  acceptedByUserId: null,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('invitation helpers', () => {
  describe('generateInvitationToken', () => {
    it('returns a 64-character hex string', () => {
      const token = generateInvitationToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns unique tokens on each call', () => {
      const a = generateInvitationToken();
      const b = generateInvitationToken();
      expect(a).not.toBe(b);
    });
  });

  describe('tokensMatch', () => {
    it('returns true for matching tokens', () => {
      const t = generateInvitationToken();
      expect(tokensMatch(t, t)).toBe(true);
    });

    it('returns false for mismatched tokens', () => {
      const a = generateInvitationToken();
      const b = generateInvitationToken();
      expect(tokensMatch(a, b)).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(tokensMatch('aa', 'aaaa')).toBe(false);
    });
  });

  describe('findPendingInvitationByToken', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null for unknown tokens', async () => {
      const db = createFakeDb({ findFirst: { workspace_invitations: undefined } });
      const inv = await findPendingInvitationByToken(db, 'a'.repeat(64));
      expect(inv).toBeNull();
    });

    it('returns null for short / malformed tokens', async () => {
      const db = createFakeDb();
      expect(await findPendingInvitationByToken(db, '')).toBeNull();
      expect(await findPendingInvitationByToken(db, 'short')).toBeNull();
    });

    it('returns null when the invitation is revoked', async () => {
      const db = createFakeDb({
        findFirst: { workspace_invitations: invitationRow({ revokedAt: new Date() }) },
      });
      expect(await findPendingInvitationByToken(db, 'a'.repeat(64))).toBeNull();
    });

    it('returns null when the invitation was already accepted', async () => {
      const db = createFakeDb({
        findFirst: { workspace_invitations: invitationRow({ acceptedAt: new Date() }) },
      });
      expect(await findPendingInvitationByToken(db, 'a'.repeat(64))).toBeNull();
    });

    it('returns null when the invitation has expired', async () => {
      const db = createFakeDb({
        findFirst: { workspace_invitations: invitationRow({ expiresAt: new Date(Date.now() - 1000) }) },
      });
      expect(await findPendingInvitationByToken(db, 'a'.repeat(64))).toBeNull();
    });

    it('returns the row when the invitation is valid', async () => {
      const row = invitationRow();
      const db = createFakeDb({ findFirst: { workspace_invitations: row } });
      const inv = await findPendingInvitationByToken(db, row.token);
      expect(inv).toEqual(row);
    });
  });

  describe('createOrRefreshInvitation', () => {
    beforeEach(() => vi.clearAllMocks());

    it('inserts a new invitation when none exists', async () => {
      const row = invitationRow({ id: 100 });
      const db = createFakeDb({
        findFirst: { workspace_invitations: undefined },
        insert: { workspace_invitations: [row] },
      });
      const { token, invitation } = await createOrRefreshInvitation(db, {
        workspaceId: 1,
        email: 'bob@example.com',
        role: 'member',
        invitedByUserId: 2,
      });
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(invitation.id).toBe(100);
    });

    it('refreshes an existing pending invitation instead of inserting', async () => {
      const existing = invitationRow({ id: 50, token: 'old'.repeat(16) });
      const refreshed = invitationRow({ id: 50, token: 'new'.repeat(16) });
      const db = createFakeDb({
        findFirst: { workspace_invitations: existing },
        update: { workspace_invitations: [refreshed] },
      });
      const { token } = await createOrRefreshInvitation(db, {
        workspaceId: 1,
        email: 'bob@example.com',
        role: 'admin',
        invitedByUserId: 2,
      });
      expect(token).not.toBe(existing.token);
    });

    it('throws when the database returns no row', async () => {
      const db = createFakeDb({
        findFirst: { workspace_invitations: undefined },
        insert: { workspace_invitations: [] },
      });
      await expect(
        createOrRefreshInvitation(db, {
          workspaceId: 1,
          email: 'bob@example.com',
          role: 'member',
          invitedByUserId: 2,
        }),
      ).rejects.toThrow(/Could not create invitation/);
    });

    it('stores only the sha256 hash of the token, never the cleartext', async () => {
      // A leaked DB file/backup must not expose live membership-granting
      // tokens — same scheme as API and password-reset tokens.
      const inserted: Array<Record<string, unknown>> = [];
      const db = createFakeDb({
        findFirst: { workspace_invitations: undefined },
        insert: {
          workspace_invitations: (v: Record<string, unknown>) => {
            inserted.push(v);
            return [invitationRow({ id: 101 })];
          },
        },
      });
      const { token } = await createOrRefreshInvitation(db, {
        workspaceId: 1,
        email: 'bob@example.com',
        role: 'member',
        invitedByUserId: 2,
      });
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.token).toBe(sha256(token));
      expect(inserted[0]!.token).not.toBe(token);
    });
  });

  describe('token hashing round-trip', () => {
    beforeEach(() => vi.clearAllMocks());

    it('upgrades a legacy plaintext token row to its hash on first use', async () => {
      // Invitations emailed before hashing shipped still hold the cleartext
      // token; accepting one must rewrite the row so the fallback retires.
      const legacy = invitationRow({ token: 'f'.repeat(64) });
      const updates: Array<Record<string, unknown>> = [];
      const db = createFakeDb({
        findFirst: { workspace_invitations: legacy },
        update: {
          workspace_invitations: (s: Record<string, unknown>) => {
            updates.push(s);
            return [legacy];
          },
        },
      });
      const inv = await findPendingInvitationByToken(db, 'f'.repeat(64));
      expect(inv).toEqual(legacy);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.token).toBe(sha256('f'.repeat(64)));
    });

    it('returns the row without rewriting when it already stores the hash', async () => {
      const hashed = invitationRow({ token: sha256('b'.repeat(64)) });
      const updates: Array<Record<string, unknown>> = [];
      const db = createFakeDb({
        findFirst: { workspace_invitations: hashed },
        update: {
          workspace_invitations: (s: Record<string, unknown>) => {
            updates.push(s);
            return [hashed];
          },
        },
      });
      const inv = await findPendingInvitationByToken(db, 'b'.repeat(64));
      expect(inv).toEqual(hashed);
      expect(updates).toHaveLength(0);
    });
  });

  describe('acceptInvitationsForUser', () => {
    beforeEach(() => vi.clearAllMocks());

    it.each([undefined, false])('does not grant invitations for an unverified email (%s)', async (emailVerified) => {
      const grant = vi.fn(() => []);
      const consume = vi.fn(() => []);
      const db = createFakeDb({
        select: { workspace_invitations: [invitationRow({ role: 'admin' })] },
        insert: { workspace_members: grant },
        update: { workspace_invitations: consume },
      });
      expect(await acceptInvitationsForUser(db, { id: 99, email: 'bob@example.com', emailVerified })).toEqual([]);
      expect(grant).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    });

    it('joins pending workspaces for matching email', async () => {
      const inv = invitationRow({ workspaceId: 1, role: 'admin' });
      const db = createFakeDb({
        select: { workspace_invitations: [inv] },
        findFirst: { workspace_members: undefined },
        update: { workspace_invitations: [invitationRow({ id: inv.id, acceptedAt: new Date() })] },
      });
      const joined = await acceptInvitationsForUser(db, { id: 99, email: 'bob@example.com', emailVerified: true });
      expect(joined).toEqual([{ workspaceId: 1, role: 'admin', email: 'bob@example.com' }]);
    });

    it('skips rows where the user is already a member but still marks the invite consumed', async () => {
      const inv = invitationRow({ workspaceId: 1 });
      const db = createFakeDb({
        select: { workspace_invitations: [inv] },
        findFirst: { workspace_members: memberRow({ workspaceId: 1, userId: 99, role: 'member' }) },
        update: { workspace_invitations: [inv] },
      });
      const joined = await acceptInvitationsForUser(db, { id: 99, email: 'bob@example.com', emailVerified: true });
      expect(joined).toEqual([]);
    });

    it('skips expired / revoked / accepted invitations', async () => {
      // Empty select result simulates the WHERE clause already filtering out
      // rows that are no longer pending.
      const db = createFakeDb({ select: { workspace_invitations: [] } });
      const joined = await acceptInvitationsForUser(db, { id: 99, email: 'bob@example.com', emailVerified: true });
      expect(joined).toEqual([]);
    });
  });
});

describe('invitationRoutes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires authentication for the workspace-scoped endpoints', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(invitationRoutes, { prefix: '/workspaces' });
    const res = await app.inject({ method: 'GET', url: '/workspaces/1/invitations' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a new pending invitation and returns the row + token header', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspace_members: memberRow({ role: 'owner' }),
          users: undefined,
          workspace_invitations: undefined,
        },
        insert: {
          workspace_invitations: [
            invitationRow({ id: 100, workspaceId: 1, email: 'newbie@example.com', role: 'member' }),
          ],
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/1/invitations',
      headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
      payload: { email: 'newbie@example.com', role: 'member' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-invitation-token']).toMatch(/^[0-9a-f]{64}$/);
    const body = res.json();
    expect(body.email).toBe('newbie@example.com');
    expect(auditMocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      2,
      'workspace.invitation.create',
      expect.stringContaining('newbie@example.com'),
    );
  });

  it('forbids non-owner/admin callers from creating invitations (403)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspace_members: memberRow({ role: 'viewer' }),
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/1/invitations',
      headers: { ...asUser({ id: 3, role: 'member' }), 'content-type': 'application/json' },
      payload: { email: 'someone@example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to invite an already-registered email (404 — L-12)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspace_members: memberRow({ role: 'owner' }),
          users: userRow({ id: 4, email: 'existing@example.com' }),
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/1/invitations',
      headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
      payload: { email: 'existing@example.com' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a missing workspace', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { workspaces: undefined } }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/99/invitations',
      headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
      payload: { email: 'anyone@example.com' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists pending and historical invitations for a workspace', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspace_members: memberRow({ role: 'owner' }),
        },
        findMany: {
          workspace_invitations: [
            invitationRow({ id: 10, email: 'a@example.com' }),
            invitationRow({ id: 11, email: 'b@example.com', role: 'admin' }),
          ],
          users: [userRow({ id: 2, name: 'Alice' })],
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({ method: 'GET', url: '/workspaces/1/invitations', headers: asUser({ id: 2 }) });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(2);
    expect(list[0].invitedByName).toBe('Alice');
  });

  it('answers non-members with 404, not 403 — no workspace-id oracle', async () => {
    // A 403 on an EXISTING workspace vs a 404 on a missing one lets any
    // authenticated user enumerate private workspace ids instance-wide.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspaceMembers: undefined,
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({ method: 'GET', url: '/workspaces/1/invitations', headers: asUser({ id: 9, role: 'member' }) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Workspace not found');
  });

  it('answers non-members with 404 on invitation create, too', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspaceMembers: undefined,
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/1/invitations',
      headers: { ...asUser({ id: 9, role: 'member' }), 'content-type': 'application/json' },
      payload: { email: 'someone@example.com' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('revokes a pending invitation', async () => {
    const inv = invitationRow({ id: 33 });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspace_members: memberRow({ role: 'owner' }),
          workspace_invitations: inv,
        },
        update: { workspace_invitations: [inv] },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/workspaces/1/invitations/33',
      headers: asUser({ id: 2 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(auditMocks.audit).toHaveBeenCalled();
  });

  it('refuses to revoke an already-revoked invitation (409)', async () => {
    const inv = invitationRow({ id: 33, revokedAt: new Date() });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspace_members: memberRow({ role: 'owner' }),
          workspace_invitations: inv,
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/workspaces/1/invitations/33',
      headers: asUser({ id: 2 }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses to revoke an already-accepted invitation (409)', async () => {
    const inv = invitationRow({ id: 33, acceptedAt: new Date() });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspace_members: memberRow({ role: 'owner' }),
          workspace_invitations: inv,
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/workspaces/1/invitations/33',
      headers: asUser({ id: 2 }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 when revoking a non-existent invitation', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1 }),
          workspace_members: memberRow({ role: 'owner' }),
          workspace_invitations: undefined,
        },
      }),
    });
    await app.register(invitationRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/workspaces/1/invitations/99',
      headers: asUser({ id: 2 }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('publicInvitationRoutes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a public preview of the invitation', async () => {
    const inv = invitationRow({ token: 'a'.repeat(64) });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspace_invitations: inv,
          workspaces: workspaceRow({ id: 1, name: 'Acme' }),
          users: userRow({ id: 2, name: 'Alice' }),
        },
      }),
    });
    await app.register(publicInvitationRoutes);

    const res = await app.inject({ method: 'GET', url: `/invitations/${inv.token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspaceName).toBe('Acme');
    expect(body.email).toBe('bob@example.com');
    expect(body.role).toBe('member');
    expect(body.invitedByName).toBe('Alice');
  });

  it('returns 404 for an unknown token', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { workspace_invitations: undefined } }),
    });
    await app.register(publicInvitationRoutes);

    const res = await app.inject({ method: 'GET', url: `/invitations/${'a'.repeat(64)}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an expired or consumed invitation', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { workspace_invitations: invitationRow({ expiresAt: new Date(Date.now() - 1000) }) },
      }),
    });
    await app.register(publicInvitationRoutes);

    const res = await app.inject({ method: 'GET', url: `/invitations/${'a'.repeat(64)}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when accept is called without a session', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(acceptInvitationRoutes);

    const res = await app.inject({ method: 'POST', url: `/invitations/${'a'.repeat(64)}/accept` });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid invitation as the matching user', async () => {
    const inv = invitationRow({ workspaceId: 1, email: 'bob@example.com' });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspace_invitations: inv,
          workspace_members: undefined,
          users: userRow({ id: 99, email: 'bob@example.com', emailVerified: true }),
        },
      }),
    });
    await app.register(acceptInvitationRoutes);

    const res = await app.inject({
      method: 'POST',
      url: `/invitations/${inv.token}/accept`,
      headers: asUser({ id: 99 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().role).toBe('member');
    expect(auditMocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      99,
      'workspace.invitation.accept',
      expect.stringContaining('bob@example.com'),
    );
  });

  it('refuses accept when the caller email does not match (403)', async () => {
    const inv = invitationRow({ email: 'bob@example.com' });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          workspace_invitations: inv,
          users: userRow({ id: 99, email: 'eve@example.com' }),
        },
      }),
    });
    await app.register(acceptInvitationRoutes);

    const res = await app.inject({
      method: 'POST',
      url: `/invitations/${inv.token}/accept`,
      headers: asUser({ id: 99 }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses accept when the token is invalid (404)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { workspace_invitations: undefined } }),
    });
    await app.register(acceptInvitationRoutes);

    const res = await app.inject({
      method: 'POST',
      url: `/invitations/${'a'.repeat(64)}/accept`,
      headers: asUser({ id: 99 }),
    });
    expect(res.statusCode).toBe(404);
  });
});
