import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceRoutes, ensureDefaultWorkspace } from '../src/modules/workspaces.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

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

describe('workspaces routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires authentication', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(workspaceRoutes, { prefix: '/workspaces' });
    const res = await app.inject({ method: 'GET', url: '/workspaces' });
    expect(res.statusCode).toBe(401);
  });

  describe('GET /workspaces', () => {
    it('auto-provisions default workspace when user has no memberships', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          select: {
            workspace_members: [],
          },
          findFirst: {
            workspace_members: undefined,
            workspaces: undefined,
            users: userRow({ id: 2, name: 'Alice Dev' }),
          },
          insert: {
            workspaces: [workspaceRow({ id: 10, name: "Alice Dev's Workspace", slug: 'alice-dev-s-workspace', ownerId: 2 })],
            workspace_members: [memberRow({ id: 20, workspaceId: 10, userId: 2, role: 'owner' })],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'GET', url: '/workspaces', headers: asUser({ id: 2 }) });
      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("Alice Dev's Workspace");
      expect(list[0].myRole).toBe('owner');
    });

    it('lists all workspaces user belongs to with member and project counts', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          select: {
            workspace_members: [
              memberRow({ workspaceId: 1, userId: 2, role: 'owner' }),
              memberRow({ workspaceId: 2, userId: 2, role: 'member' }),
            ],
            projects: [{ id: 1, workspaceId: 1 }],
          },
          findMany: {
            workspaces: [
              workspaceRow({ id: 1, name: 'First WS' }),
              workspaceRow({ id: 2, name: 'Second WS' }),
            ],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'GET', url: '/workspaces', headers: asUser({ id: 2 }) });
      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list).toHaveLength(2);
      expect(list[0].projectCount).toBe(1);
    });
  });

  describe('POST /workspaces', () => {
    it('creates a workspace with creator as owner', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { workspaces: undefined },
          insert: {
            workspaces: [workspaceRow({ id: 5, name: 'New Team', slug: 'new-team', ownerId: 2 })],
            workspace_members: [memberRow({ id: 15, workspaceId: 5, userId: 2, role: 'owner' })],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { name: 'New Team' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('New Team');
      expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 2, 'workspace.create', 'New Team');
    });

    it('rejects duplicate slug with 409 conflict', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { workspaces: workspaceRow({ slug: 'taken-team' }) },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { name: 'Taken Team', slug: 'taken-team' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('handles insert failure with 400', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { workspaces: undefined },
          insert: { workspaces: [] },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { name: 'Failed Insert' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /workspaces/:id', () => {
    it('returns workspace detail and members for member', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspace_members: memberRow({ workspaceId: 1, userId: 2, role: 'owner' }),
          },
          select: {
            workspace_members: [{ member: memberRow({ id: 1 }), user: { email: 'alice@example.com', name: 'Alice' } }],
            projects: [{ id: 1 }],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'GET', url: '/workspaces/1', headers: asUser({ id: 2 }) });
      expect(res.statusCode).toBe(200);
      const detail = res.json();
      expect(detail.name).toBe('Acme Workspace');
      expect(detail.members).toHaveLength(1);
    });

    it('returns 404 for missing workspace', async () => {
      const app = await buildTestApp({ db: createFakeDb({ findFirst: { workspaces: undefined } }) });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'GET', url: '/workspaces/99', headers: asUser({ id: 2 }) });
      expect(res.statusCode).toBe(404);
    });

    it('allows system admin access even if not in workspace_members', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspaceMembers: undefined,
          },
          select: {
            workspace_members: [],
            projects: [],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'GET', url: '/workspaces/1', headers: asUser({ id: 1, role: 'admin' }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().myRole).toBe('admin');
    });

    it('answers non-members with 404 — no private-workspace id oracle', async () => {
      // 403 on an EXISTING workspace vs 404 on a missing one would let any
      // authenticated user enumerate private workspace ids instance-wide.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspaceMembers: undefined,
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'GET', url: '/workspaces/1', headers: asUser({ id: 9, role: 'member' }) });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe('Workspace not found');
    });
  });

  describe('PATCH /workspaces/:id', () => {
    it('updates workspace info for owner', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspace_members: memberRow({ workspaceId: 1, userId: 2, role: 'owner' }),
          },
          update: {
            workspaces: [workspaceRow({ id: 1, name: 'Renamed Workspace' })],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { name: 'Renamed Workspace' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Renamed Workspace');
      expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 2, 'workspace.update', 'Renamed Workspace');
    });

    it('updates workspace info with description and allows admin without membership', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspaceMembers: undefined,
          },
          update: {
            workspaces: [workspaceRow({ id: 1, name: 'Admin Edited', description: 'New description' })],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1',
        headers: { ...asUser({ id: 99, role: 'admin' }), 'content-type': 'application/json' },
        payload: { name: 'Admin Edited', description: 'New description' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Admin Edited');
    });

    it('forbids viewer or outsider from updating (403)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspace_members: memberRow({ workspaceId: 1, userId: 3, role: 'viewer' }),
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1',
        headers: { ...asUser({ id: 3, role: 'member' }), 'content-type': 'application/json' },
        payload: { name: 'Hacked' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for missing workspace', async () => {
      const app = await buildTestApp({ db: createFakeDb({ findFirst: { workspaces: undefined } }) });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/99',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { name: 'Name' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('handles failed update returning 400', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspace_members: memberRow({ role: 'owner' }),
          },
          update: { workspaces: [] },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { name: 'Name' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /workspaces/:id', () => {
    it('allows owner to delete workspace', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { workspaces: workspaceRow({ id: 1, ownerId: 2 }) },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'DELETE', url: '/workspaces/1', headers: asUser({ id: 2 }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 2, 'workspace.delete', 'Acme Workspace');
    });

    it('forbids non-owner from deleting (403)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            // A rank-and-file MEMBER of the workspace: still not allowed to
            // delete (403), but unlike a non-member they DO learn the
            // workspace exists — they are inside it.
            workspaceMembers: { id: 1, workspaceId: 1, userId: 3, role: 'member' },
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'DELETE', url: '/workspaces/1', headers: asUser({ id: 3, role: 'member' }) });
      expect(res.statusCode).toBe(403);
    });

    it('answers a NON-MEMBER delete with 404 (no id oracle)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { workspaces: workspaceRow({ id: 1, ownerId: 2 }) },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'DELETE', url: '/workspaces/1', headers: asUser({ id: 3, role: 'member' }) });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for missing workspace', async () => {
      const app = await buildTestApp({ db: createFakeDb({ findFirst: { workspaces: undefined } }) });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'DELETE', url: '/workspaces/99', headers: asUser({ id: 2 }) });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Workspace Members Management', () => {
    it('adds a member by email', async () => {
      let memberLookupCount = 0;
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspaceMembers: () => {
              memberLookupCount++;
              return memberLookupCount === 1 ? memberRow({ role: 'owner' }) : undefined;
            },
            users: userRow({ id: 4, email: 'bob@example.com' }),
          },
          insert: {
            workspace_members: [memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'member' })],
          },
        }),
      });

      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/1/members',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { email: 'bob@example.com', role: 'member' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe('bob@example.com');
      expect(auditMocks.audit).toHaveBeenCalled();
    });

    it('handles member insert failure with 400', async () => {
      let memberLookupCount = 0;
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspaceMembers: () => {
              memberLookupCount++;
              return memberLookupCount === 1 ? memberRow({ role: 'owner' }) : undefined;
            },
            users: userRow({ id: 4, email: 'bob@example.com' }),
          },
          insert: {
            workspace_members: [],
          },
        }),
      });

      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/1/members',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { email: 'bob@example.com', role: 'member' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects adding member if caller is viewer (403)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspace_members: memberRow({ role: 'viewer' }),
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/1/members',
        headers: { ...asUser({ id: 3, role: 'member' }), 'content-type': 'application/json' },
        payload: { email: 'test@example.com' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('creates a pending invitation when the address is not yet a user', async () => {
      // The unified POST /workspaces/:id/members endpoint now drops into the
      // invitation flow for unknown addresses (returning the pending row +
      // acceptUrl), instead of refusing with a 404 like the old direct-add
      // route did. The frontend uses one button regardless of which bucket
      // the address is in.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspace_members: memberRow({ role: 'owner' }),
            users: undefined,
            workspaceInvitations: undefined,
          },
          insert: {
            workspace_invitations: [
              {
                id: 99,
                workspaceId: 1,
                email: 'notfound@example.com',
                role: 'member',
                token: 'a'.repeat(64),
                invitedByUserId: 2,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                acceptedAt: null,
                acceptedByUserId: null,
                revokedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/1/members',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { email: 'notfound@example.com' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.kind).toBe('invitation');
      expect(body.email).toBe('notfound@example.com');
      expect(body.acceptUrl).toMatch(/^https?:\/\/.+\/invite\/.+$/);
    });

    it('rejects adding an existing member with the same error as an unknown email (L-12)', async () => {
      let callCount = 0;
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            users: userRow({ id: 4, email: 'bob@example.com' }),
            workspace_members: () => {
              callCount++;
              return memberRow({ role: callCount === 1 ? 'owner' : 'member' });
            },
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/1/members',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { email: 'bob@example.com' },
      });
      // Was 409 "already a member" vs 404 "user not found" — two answers that
      // together told a workspace owner whether any given email had an account
      // on this instance. Both now return the same 404 with the same message.
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe('That email address cannot be added to this workspace');
    });

    it('updates member role and transfers ownership', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspaceMembers: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'admin' }),
            users: userRow({ id: 4, email: 'bob@example.com' }),
          },
          update: {
            workspaces: [workspaceRow({ id: 1, ownerId: 4 })],
            workspace_members: [memberRow({ id: 10, role: 'owner' })],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1/members/10',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { role: 'owner' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('owner');
    });

    it('allows instance admin to transfer ownership without being owner', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspaceMembers: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'admin' }),
            users: userRow({ id: 4, email: 'bob@example.com' }),
          },
          update: {
            workspaces: [workspaceRow({ id: 1, ownerId: 4 })],
            workspace_members: [memberRow({ id: 10, role: 'owner' })],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1/members/10',
        headers: { ...asUser({ id: 99, role: 'admin' }), 'content-type': 'application/json' },
        payload: { role: 'owner' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('forbids workspace admin (non-owner) from transferring ownership (403)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspaceMembers: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'admin' }),
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1/members/10',
        headers: { ...asUser({ id: 5, role: 'member' }), 'content-type': 'application/json' },
        payload: { role: 'owner' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('forbids an admin from demoting the workspace owner (403)', async () => {
      let membershipLookup = 0;
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspaceMembers: () => {
              membershipLookup++;
              return membershipLookup === 1
                ? memberRow({ id: 9, workspaceId: 1, userId: 4, role: 'admin' })
                : memberRow({ id: 10, workspaceId: 1, userId: 2, role: 'owner' });
            },
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1/members/10',
        headers: { ...asUser({ id: 4, role: 'member' }), 'content-type': 'application/json' },
        payload: { role: 'viewer' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('owner role');
    });

    it('forbids viewer from updating member roles (403)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspaceMembers: memberRow({ id: 10, workspaceId: 1, userId: 5, role: 'viewer' }),
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1/members/10',
        headers: { ...asUser({ id: 5, role: 'member' }), 'content-type': 'application/json' },
        payload: { role: 'member' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 404 when target member not found during role update', async () => {
      let callCount = 0;
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspaceMembers: () => {
              callCount++;
              return callCount === 1 ? memberRow({ id: 1, workspaceId: 1, userId: 2, role: 'owner' }) : undefined;
            },
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1/members/999',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { role: 'admin' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when target member not found during removal', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspaceMembers: undefined,
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/workspaces/1/members/999',
        headers: asUser({ id: 2 }),
      });
      expect(res.statusCode).toBe(404);
    });

    it('removes member from workspace', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspace_members: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'member' }),
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/workspaces/1/members/10',
        headers: asUser({ id: 2 }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('hands the removed member\'s workspace resources to the workspace owner (r097)', async () => {
      // ownerUserId short-circuits to `owner` in every access helper; without
      // re-homing, a removed member kept env/deploy/credentials/delete rights
      // on everything they created inside the team.
      const { databases, services } = await import('@ninedeploy/db');
      const db = createFakeDb({
        findFirst: {
          workspaces: workspaceRow({ id: 1, ownerId: 2 }),
          workspace_members: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'member' }),
        },
        select: { service_workspaces: [{ id: 5 }], projects: [{ id: 3 }] },
      });
      const writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
      const origUpdate = db.update.bind(db);
      db.update = ((table: unknown) => {
        const builder = origUpdate(table as never);
        const origSet = builder.set.bind(builder);
        builder.set = ((values: Record<string, unknown>) => {
          writes.push({ table, values });
          return origSet(values as never);
        }) as typeof builder.set;
        return builder;
      }) as typeof db.update;
      const app = await buildTestApp({ db });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({ method: 'DELETE', url: '/workspaces/1/members/10', headers: asUser({ id: 2 }) });
      expect(res.statusCode).toBe(200);
      expect(writes).toContainEqual({ table: services, values: { ownerUserId: 2 } });
      expect(writes).toContainEqual({ table: databases, values: { ownerUserId: 2 } });
    });

    it('forbids removing member without permissions (403)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspace_members: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'member' }),
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/workspaces/1/members/10',
        headers: asUser({ id: 9, role: 'member' }),
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows a member to leave workspace themselves', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspace_members: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'member' }),
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/workspaces/1/members/10',
        headers: asUser({ id: 4, role: 'member' }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('handles failed member role update (400) and missing user fallback', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspace_members: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'admin' }),
            users: undefined,
          },
          update: {
            workspace_members: [],
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const resFail = await app.inject({
        method: 'PATCH',
        url: '/workspaces/1/members/10',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { role: 'admin' },
      });
      expect(resFail.statusCode).toBe(400);

      const app2 = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspace_members: memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'admin' }),
            users: undefined,
          },
          update: {
            workspace_members: [memberRow({ id: 10, role: 'admin' })],
          },
        }),
      });
      await app2.register(workspaceRoutes, { prefix: '/workspaces' });

      const resSuccess = await app2.inject({
        method: 'PATCH',
        url: '/workspaces/1/members/10',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { role: 'admin' },
      });
      expect(resSuccess.statusCode).toBe(200);
    });

    it('forbids removing workspace owner (403)', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1, ownerId: 2 }),
            workspaceMembers: memberRow({ id: 1, workspaceId: 1, userId: 2, role: 'owner' }),
          },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/workspaces/1/members/1',
        headers: asUser({ id: 2 }),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('Cannot remove the workspace owner');
    });

    it('returns 404 for member operations on missing workspace or member', async () => {
      const app = await buildTestApp({ db: createFakeDb({ findFirst: { workspaces: undefined } }) });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });

      const res1 = await app.inject({
        method: 'POST',
        url: '/workspaces/99/members',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { email: 'test@example.com' },
      });
      expect(res1.statusCode).toBe(404);

      const res2 = await app.inject({
        method: 'PATCH',
        url: '/workspaces/99/members/1',
        headers: { ...asUser({ id: 2 }), 'content-type': 'application/json' },
        payload: { role: 'admin' },
      });
      expect(res2.statusCode).toBe(404);

      const res3 = await app.inject({
        method: 'DELETE',
        url: '/workspaces/99/members/1',
        headers: asUser({ id: 2 }),
      });
      expect(res3.statusCode).toBe(404);
    });
  });

  describe('ensureDefaultWorkspace helper', () => {
    it('returns existing workspace when user already has membership', async () => {
      const db = createFakeDb({
        findFirst: {
          workspace_members: memberRow({ workspaceId: 1 }),
          workspaces: workspaceRow({ id: 1, name: 'Existing WS' }),
        },
      });
      const ws = await ensureDefaultWorkspace(db, { id: 2, email: 'alice@example.com' });
      expect(ws.name).toBe('Existing WS');
    });

    it('creates personal workspace with name from db if omitted', async () => {
      let slugConflict = false;
      const db = createFakeDb({
        findFirst: {
          workspace_members: undefined,
          users: userRow({ id: 3, name: null }),
          workspaces: () => (slugConflict ? workspaceRow({ slug: 'personal-workspace' }) : undefined),
        },
        insert: {
          workspaces: [workspaceRow({ id: 8, name: 'Personal Workspace', slug: 'personal-workspace-3' })],
          workspace_members: [memberRow({ id: 18 })],
        },
      });
      slugConflict = true;
      const ws = await ensureDefaultWorkspace(db, { id: 3, email: 'bob@example.com' });
      expect(ws.name).toBe('Personal Workspace');
    });

    it('creates personal workspace when membership points to non-existent workspace', async () => {
      const db = createFakeDb({
        findFirst: {
          workspace_members: memberRow({ workspaceId: 999 }),
          workspaces: undefined,
          users: userRow({ id: 5, name: 'Orphan User' }),
        },
        insert: {
          workspaces: [workspaceRow({ id: 9, name: "Orphan User's Workspace", slug: 'orphan-user-s-workspace' })],
          workspace_members: [memberRow({ id: 19 })],
        },
      });
      const ws = await ensureDefaultWorkspace(db, { id: 5, email: 'orphan@example.com' });
      expect(ws.name).toBe("Orphan User's Workspace");
    });
  });
});
