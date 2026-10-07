import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  createDb,
  databaseAttachments,
  databases as databasesTable,
  projects as projectsTable,
  services as servicesTable,
  serviceWorkspaces,
  users as usersTable,
  workspaceMembers,
  workspaces as workspacesTable,
  type DB,
} from '@ninedeploy/db';
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

    it('r604: a non-operator admin gets the SAME invitation answer for a registered and an unknown email', async () => {
      const inviteRow = (email: string) => ({
        id: 99,
        workspaceId: 1,
        email,
        role: 'member',
        token: 'a'.repeat(64),
        invitedByUserId: 2,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const call = async (email: string, registered: boolean) => {
        let memberLookups = 0;
        const db = createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            // 1st lookup: the caller's own seat (admin); 2nd: the target is not a member.
            workspaceMembers: () => (++memberLookups === 1 ? memberRow({ userId: 2, role: 'admin' }) : undefined),
            users: registered ? userRow({ id: 4, email }) : undefined,
            workspaceInvitations: undefined,
          },
          insert: { workspace_invitations: [inviteRow(email)], workspace_members: [memberRow({ id: 10, userId: 4 })] },
        });
        const insert = vi.spyOn(db, 'insert');
        const app = await buildTestApp({ db });
        await app.register(workspaceRoutes, { prefix: '/workspaces' });
        const res = await app.inject({
          method: 'POST',
          url: '/workspaces/1/members',
          headers: { ...asUser({ id: 2, isOperator: false }), 'content-type': 'application/json' },
          payload: { email, role: 'member' },
        });
        const { workspaceMembers } = await import('@ninedeploy/db');
        return { res, addedDirectly: insert.mock.calls.some(([t]) => t === workspaceMembers) };
      };

      const registered = await call('bob@example.com', true);
      const unknown = await call('nobody@example.com', false);
      expect(registered.res.statusCode).toBe(200);
      expect(unknown.res.statusCode).toBe(200);
      expect(registered.res.json().kind).toBe('invitation');
      expect(Object.keys(registered.res.json()).sort()).toEqual(Object.keys(unknown.res.json()).sort());
      expect(registered.addedDirectly).toBe(false);
    });

    it('r604: an instance operator (who can list every account anyway) still adds a registered user directly', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: {
            workspaces: workspaceRow({ id: 1 }),
            workspaceMembers: undefined,
            users: userRow({ id: 4, email: 'bob@example.com' }),
          },
          insert: { workspace_members: [memberRow({ id: 10, workspaceId: 1, userId: 4, role: 'member' })] },
        }),
      });
      await app.register(workspaceRoutes, { prefix: '/workspaces' });
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/1/members',
        headers: { ...asUser({ id: 1, isOperator: true }), 'content-type': 'application/json' },
        payload: { email: 'bob@example.com', role: 'member' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().kind).toBeUndefined();
      expect(res.json().email).toBe('bob@example.com');
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

/**
 * F144/F145 — a member removal (seat loss) follows the r694/r710 hand-over
 * rule that ownershipBackfill.ts applies: an operator's resources are never
 * handed over, and a service also tagged into a workspace where the creator
 * still holds a seat stays theirs. Real migrated SQLite: the rule depends on
 * the other workspaces' tags and seats, which a fake db cannot model.
 */
describe('member removal hand-over follows the seat rule (F144/F145)', () => {
  const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
  let db: DB;
  const user = async (email: string, op = false) =>
    (await db.insert(usersTable).values({ email, passwordHash: 'x', isInstanceOperator: op }).returning())[0]!.id;
  const team = async (slug: string, ownerId: number) => {
    const [ws] = await db.insert(workspacesTable).values({ name: slug, slug, ownerId }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: ownerId, role: 'owner' });
    return ws!.id;
  };
  const seat = async (workspaceId: number, userId: number, role: 'admin' | 'member') =>
    (await db.insert(workspaceMembers).values({ workspaceId, userId, role }).returning())[0]!.id;
  const service = async (slug: string, ownerUserId: number, tags: number[]) => {
    const [s] = await db.insert(servicesTable).values({ name: slug, slug, ownerUserId }).returning();
    await db.insert(serviceWorkspaces).values(tags.map((workspaceId) => ({ serviceId: s!.id, workspaceId })));
    return s!.id;
  };
  const serviceOwner = async (id: number) =>
    (await db.select({ o: servicesTable.ownerUserId }).from(servicesTable).where(eq(servicesTable.id, id)))[0]!.o;

  beforeEach(async () => {
    db = createDb({ url: ':memory:' }).db;
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });

  it('F144: keeps a service with its creator while they still hold a seat in another workspace it lives in', async () => {
    const ownerA = await user('owner-a@example.com');
    const ownerB = await user('owner-b@example.com');
    const ownerC = await user('owner-c@example.com');
    const creator = await user('creator@example.com');
    const wsA = await team('ws-a', ownerA);
    const wsB = await team('ws-b', ownerB);
    const wsC = await team('ws-c', ownerC);
    const seatA = await seat(wsA, creator, 'member');
    await seat(wsB, creator, 'member');
    const shared = await service('shared', creator, [wsA, wsB]);
    const aOnly = await service('a-only', creator, [wsA]);
    const aAndC = await service('a-and-c', creator, [wsA, wsC]);
    const app = await buildTestApp({ db });
    await app.register(workspaceRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/workspaces/${wsA}/members/${seatA}`,
      headers: asUser({ id: ownerA, isOperator: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(await serviceOwner(shared)).toBe(creator);
    expect(await serviceOwner(aOnly)).toBe(ownerA);
    expect(await serviceOwner(aAndC)).toBe(ownerA);
  });

  it("F145: never hands an instance operator's services or databases to the workspace owner", async () => {
    const ownerA = await user('owner-a@example.com');
    const operator = await user('op@example.com', true);
    const member = await user('member@example.com');
    const wsA = await team('ws-a', ownerA);
    const opSeat = await seat(wsA, operator, 'admin');
    const memberSeat = await seat(wsA, member, 'member');
    const [proj] = await db.insert(projectsTable).values({ name: 'p', slug: 'p', workspaceId: wsA }).returning();
    const opSvc = await service('op-svc', operator, [wsA]);
    const memberSvc = await service('member-svc', member, [wsA]);
    const [opDb] = await db
      .insert(databasesTable)
      .values({
        name: 'op-db',
        slug: 'op-db',
        engine: 'postgres',
        version: '16',
        containerName: 'nd-db-op-db',
        volumeName: 'nd-db-op-db-data',
        internalHost: 'h',
        internalPort: 5432,
        username: 'u',
        passwordEncrypted: 'x',
        dbName: 'd',
        ownerUserId: operator,
        projectId: proj!.id,
      })
      .returning();
    const app = await buildTestApp({ db });
    await app.register(workspaceRoutes, { prefix: '/workspaces' });
    const headers = asUser({ id: ownerA, isOperator: false });

    expect((await app.inject({ method: 'DELETE', url: `/workspaces/${wsA}/members/${opSeat}`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/workspaces/${wsA}/members/${memberSeat}`, headers })).statusCode).toBe(200);
    expect(await serviceOwner(opSvc)).toBe(operator);
    const dbOwner = await db.select({ o: databasesTable.ownerUserId }).from(databasesTable).where(eq(databasesTable.id, opDb!.id));
    expect(dbOwner[0]!.o).toBe(operator);
    expect(await serviceOwner(memberSvc)).toBe(ownerA);
  });

  it("F147: moves a template service's unfiled managed database with the service", async () => {
    // reconcileTemplateDependencies refuses an attached template database
    // whose owner differs from the service's ("belongs to another resource"),
    // so a service handed over without its unfiled database failed every
    // later deploy.
    const ownerA = await user('owner-a@example.com');
    const creator = await user('creator@example.com');
    const wsA = await team('ws-a', ownerA);
    const seatA = await seat(wsA, creator, 'member');
    const attachedDb = async (slug: string, serviceId: number) => {
      const [row] = await db
        .insert(databasesTable)
        .values({
          name: slug,
          slug,
          engine: 'postgres',
          version: '16',
          containerName: `nd-db-${slug}`,
          volumeName: `nd-db-${slug}-data`,
          internalHost: 'h',
          internalPort: 5432,
          username: 'u',
          passwordEncrypted: 'x',
          dbName: 'd',
          ownerUserId: creator,
          projectId: null,
        })
        .returning();
      await db.insert(databaseAttachments).values({ serviceId, databaseId: row!.id, envAlias: 'DATABASE_URL' });
      return row!.id;
    };
    const tplSvc = await service('tpl-app', creator, [wsA]);
    await db.update(servicesTable).set({ templateId: 'tpl-pg' }).where(eq(servicesTable.id, tplSvc));
    const tplDb = await attachedDb('tpl-app-db', tplSvc);
    const plainSvc = await service('plain-app', creator, [wsA]);
    const plainDb = await attachedDb('plain-app-db', plainSvc);
    const app = await buildTestApp({ db });
    await app.register(workspaceRoutes, { prefix: '/workspaces' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/workspaces/${wsA}/members/${seatA}`,
      headers: asUser({ id: ownerA, isOperator: false }),
    });
    expect(res.statusCode).toBe(200);
    const dbOwner = async (id: number) =>
      (await db.select({ o: databasesTable.ownerUserId }).from(databasesTable).where(eq(databasesTable.id, id)))[0]!.o;
    expect(await serviceOwner(tplSvc)).toBe(ownerA);
    expect(await dbOwner(tplDb)).toBe(ownerA);
    // A non-template service's unfiled database stays personal (r694).
    expect(await dbOwner(plainDb)).toBe(creator);
  });

  it("F952: a deactivated user's other seats keep nothing — the shared team service goes to the workspace owner", async () => {
    // SCIM PATCH active=false deactivates instance-wide but keeps every seat
    // (scim.ts deactivateUser, leaveWorkspace:false). A later API removal of
    // the team seat used to leave a service shared with the dead account's
    // personal workspace on that account, so the team project's shared env
    // stopped being injected (filterTrustworthyProjectLinks needs a seat).
    const ownerA = await user('owner-a@example.com');
    const ownerB = await user('owner-b@example.com');
    const dead = await user('dead@example.com');
    const active = await user('active@example.com');
    const wsA = await team('ws-a', ownerA);
    const wsB = await team('ws-b', ownerB);
    const personal = await team('dead-personal', dead);
    const deadSeat = await seat(wsA, dead, 'member');
    const activeSeat = await seat(wsA, active, 'member');
    await seat(wsB, active, 'member');
    await db.update(usersTable).set({ deactivatedAt: new Date(0), deactivatedByWorkspaceId: wsA }).where(eq(usersTable.id, dead));
    const deadShared = await service('dead-shared', dead, [wsA, personal]);
    const deadPersonal = await service('dead-personal-only', dead, [personal]);
    const activeShared = await service('active-shared', active, [wsA, wsB]);
    const app = await buildTestApp({ db });
    await app.register(workspaceRoutes, { prefix: '/workspaces' });
    const headers = asUser({ id: ownerA, isOperator: false });

    expect((await app.inject({ method: 'DELETE', url: `/workspaces/${wsA}/members/${deadSeat}`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/workspaces/${wsA}/members/${activeSeat}`, headers })).statusCode).toBe(200);
    expect(await serviceOwner(deadShared)).toBe(ownerA);
    // Untouched: a service that never lived in the team, and F144 for an active user.
    expect(await serviceOwner(deadPersonal)).toBe(dead);
    expect(await serviceOwner(activeShared)).toBe(active);
  });
});
