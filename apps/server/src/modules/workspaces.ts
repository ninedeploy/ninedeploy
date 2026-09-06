import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  projects,
  users,
  workspaceMembers,
  workspaces,
  type DB,
  type User,
  type Workspace,
  type WorkspaceMember,
} from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import {
  workspaceCreate,
  workspaceMemberAdd,
  workspaceMemberRoleUpdate,
  workspaceUpdate,
  type WorkspaceDetail,
  type WorkspaceEntry,
  type WorkspaceMemberEntry,
  type WorkspaceRole,
} from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound, parseId } from '../lib/errors.js';
import { iso } from '../lib/serialize.js';
import { slugify, slugifyWithSuffix } from '../lib/slug.js';
import { createOrRefreshInvitation, buildAcceptUrl, buildInviteEmail } from './invitations.js';
import { sendSystemEmail } from '../lib/notifier.js';

function serializeMember(m: WorkspaceMember, u: Pick<User, 'email' | 'name'>): WorkspaceMemberEntry {
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    userId: m.userId,
    email: u.email,
    name: u.name,
    role: m.role as WorkspaceRole,
    createdAt: iso(m.createdAt) as string,
  };
}

function serializeWorkspace(
  w: Workspace,
  myRole: WorkspaceRole,
  counts: { members: number; projects: number },
): WorkspaceEntry {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    description: w.description,
    ownerId: w.ownerId,
    myRole,
    memberCount: counts.members,
    projectCount: counts.projects,
    createdAt: iso(w.createdAt) as string,
    updatedAt: iso(w.updatedAt) as string,
  };
}

export async function ensureDefaultWorkspace(
  db: Pick<DB, 'query' | 'select' | 'insert' | 'update' | 'delete'>,
  user: { id: number; name?: string | null; email?: string },
  role: WorkspaceRole = 'owner',
): Promise<Workspace> {
  const existingMembership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, user.id),
  });
  if (existingMembership) {
    const existing = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, existingMembership.workspaceId),
    });
    if (existing) return existing;
  }

  let name = user.name;
  if (!name) {
    const dbUser = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    name = dbUser?.name;
  }

  const baseName = name ? `${name}'s Workspace` : 'Personal Workspace';
  let slug = slugify(baseName);
  const conflictCheck = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, slug) });
  if (conflictCheck) {
    slug = slugifyWithSuffix(baseName, String(user.id));
  }

  const [ws] = await db
    .insert(workspaces)
    .values({
      name: baseName,
      slug,
      description: 'Default personal workspace',
      ownerId: user.id,
    })
    .returning();

  await db.insert(workspaceMembers).values({
    workspaceId: ws!.id,
    userId: user.id,
    role,
  });

  return ws!;
}

/**
 * Like `ensureDefaultWorkspace` but always grants the given role even when
 * a personal workspace already exists. Used by SSO auto-enroll where the
 * provider's `defaultRole` is a workspace role.
 */
export async function ensureDefaultWorkspaceWithRole(
  db: Pick<DB, 'query' | 'select' | 'insert' | 'update' | 'delete'>,
  user: { id: number; name?: string | null; email?: string },
  role: WorkspaceRole,
): Promise<Workspace> {
  const ws = await ensureDefaultWorkspace(db, user, role);
  // ensureDefaultWorkspace is a no-op when a workspace already exists; in
  // that case we still need to align the membership role with the requested
  // value (idempotent UPDATE).
  await db
    .update(workspaceMembers)
    .set({ role })
    .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, user.id)));
  return ws;
}

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // List all workspaces current user has access to
  app.get('/', async (req): Promise<WorkspaceEntry[]> => {
    const userId = req.user!.id;
    const memberships = await app.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));

    if (memberships.length === 0) {
      const defaultWs = await ensureDefaultWorkspace(app.db, req.user!);
      return [serializeWorkspace(defaultWs, 'owner', { members: 1, projects: 0 })];
    }

    const wsIds = memberships.map((m) => m.workspaceId);
    const wsRows = await app.db.query.workspaces.findMany({
      where: inArray(workspaces.id, wsIds),
      orderBy: [asc(workspaces.name)],
    });

    const allMembers = await app.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(inArray(workspaceMembers.workspaceId, wsIds));

    const allProjects = await app.db
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(inArray(projects.workspaceId, wsIds));

    const memberCounts = new Map<number, number>();
    for (const m of allMembers) {
      memberCounts.set(m.workspaceId, (memberCounts.get(m.workspaceId) ?? 0) + 1);
    }
    const projectCounts = new Map<number, number>();
    for (const p of allProjects) {
      const wid = p.workspaceId as number;
      projectCounts.set(wid, (projectCounts.get(wid) ?? 0) + 1);
    }

    const roleMap = new Map<number, WorkspaceRole>();
    for (const m of memberships) {
      roleMap.set(m.workspaceId, m.role as WorkspaceRole);
    }

    return wsRows.map((w) => {
      const myRole = roleMap.get(w.id)!;
      const members = memberCounts.get(w.id)!;
      const projects = projectCounts.get(w.id) ?? 0;
      return serializeWorkspace(w, myRole, { members, projects });
    });
  });

  // Create a new workspace
  app.post('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const input = workspaceCreate.parse(req.body);
    const slug = input.slug ?? slugify(input.name);
    const existing = await app.db.query.workspaces.findFirst({ where: eq(workspaces.slug, slug) });
    if (existing) throw conflict(`Workspace slug "${slug}" is already taken`);

    const [ws] = await app.db
      .insert(workspaces)
      .values({
        name: input.name,
        slug,
        description: input.description,
        ownerId: req.user!.id,
      })
      .returning();

    if (!ws) throw badRequest('Could not create workspace');

    await app.db.insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: req.user!.id,
      role: 'owner',
    });

    void audit(app.db, req.user!.id, 'workspace.create', ws.name);
    return serializeWorkspace(ws, 'owner', { members: 1, projects: 0 });
  });

  // Get workspace detail with members
  app.get('/:id', async (req): Promise<WorkspaceDetail> => {
    const id = parseId((req.params as { id: string }).id);
    const userId = req.user!.id;

    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (!ws) throw notFound('Workspace not found');

    const membership = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)),
    });

    const isInstanceAdmin = req.user!.isOperator;
    if (!membership && !isInstanceAdmin) {
      // 404, not 403: "exists but you are not a member" vs "does not exist"
      // would let any authenticated user enumerate private workspace ids
      // (resourceAccess.ts convention / L-12).
      throw notFound('Workspace not found');
    }

    const membersWithUser = await app.db
      .select({
        member: workspaceMembers,
        user: { email: users.email, name: users.name },
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, id))
      .orderBy(asc(workspaceMembers.createdAt));

    const projectRows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspaceId, id));

    const myRole = (membership?.role as WorkspaceRole) ?? 'admin';

    return {
      ...serializeWorkspace(ws, myRole, {
        members: membersWithUser.length,
        projects: projectRows.length,
      }),
      members: membersWithUser.map((row) => serializeMember(row.member, row.user)),
    };
  });

  // Update workspace info
  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const userId = req.user!.id;
    const input = workspaceUpdate.parse(req.body);

    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (!ws) throw notFound('Workspace not found');

    const membership = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)),
    });
    // Non-members get the same 404 a missing row gets — no id oracle.
    if (!membership && !req.user!.isOperator) throw notFound('Workspace not found');

    const canEdit = req.user!.isOperator || membership?.role === 'owner' || membership?.role === 'admin';
    if (!canEdit) throw forbidden('Admin or Owner role required to update workspace settings');

    const [updated] = await app.db
      .update(workspaces)
      .set({
        ...(input.name != null && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
      })
      .where(eq(workspaces.id, id))
      .returning();

    if (!updated) throw badRequest('Could not update workspace');
    void audit(app.db, req.user!.id, 'workspace.update', updated.name);

    const myRole = (membership?.role as WorkspaceRole) ?? 'admin';
    return serializeWorkspace(updated, myRole, { members: 1, projects: 0 });
  });

  // Delete workspace
  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const userId = req.user!.id;

    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (!ws) throw notFound('Workspace not found');

    // Non-members get the same 404 a missing row gets — no id oracle.
    const callerMembership = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)),
    });
    if (!callerMembership && !req.user!.isOperator) throw notFound('Workspace not found');

    const isOwner = ws.ownerId === userId || req.user!.isOperator;
    if (!isOwner) throw forbidden('Only the workspace owner or system admin can delete a workspace');

    await app.db.delete(workspaces).where(eq(workspaces.id, id));
    void audit(app.db, req.user!.id, 'workspace.delete', ws.name);
    return { ok: true };
  });

  // Add a member to the workspace, or create a pending invitation if the
  // address does not belong to a registered user yet. Single UX entry point
  // that the frontend calls without knowing whether the address is onboarded.
  app.post('/:id/members', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const userId = req.user!.id;
    const input = workspaceMemberAdd.parse(req.body);

    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (!ws) throw notFound('Workspace not found');

    const callerMembership = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)),
    });
    // Non-members get the same 404 a missing row gets — no id oracle.
    if (!callerMembership && !req.user!.isOperator) throw notFound('Workspace not found');

    const canInvite = req.user!.isOperator || callerMembership?.role === 'owner' || callerMembership?.role === 'admin';
    if (!canInvite) throw forbidden('Admin or Owner role required to invite workspace members');

    const targetUser = await app.db.query.users.findFirst({ where: sql`lower(${users.email}) = ${input.email.toLowerCase()}` });

    // Already a member: collapse the L-12 error the same way the unknown-user
    // case does so an outsider cannot enumerate which addresses are
    // registered on this instance.
    if (targetUser) {
      const existingMember = await app.db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, targetUser.id)),
      });
      if (existingMember) throw notFound('That email address cannot be added to this workspace');

      const [created] = await app.db
        .insert(workspaceMembers)
        .values({
          workspaceId: id,
          userId: targetUser.id,
          role: input.role,
        })
        .returning();

      if (!created) throw badRequest('Could not add member');
      void audit(app.db, req.user!.id, 'workspace.member.add', `${targetUser.email} (${input.role}) to ${ws.name}`);

      return serializeMember(created, targetUser);
    }

    // Not a registered user — drop into the invitation flow so the address
    // can onboard when they next sign in. The frontend uses one button for
    // both outcomes; the response shape carries the invitation row so the
    // UI can render the accept URL inline.
    const { token, invitation } = await createOrRefreshInvitation(app.db, {
      workspaceId: id,
      email: input.email,
      role: input.role,
      invitedByUserId: userId,
    });
    const inviter = await app.db.query.users.findFirst({ where: eq(users.id, userId) });
    void audit(app.db, userId, 'workspace.invitation.create', `${input.email} (${input.role}) to ${ws.name}`);

    const acceptUrl = buildAcceptUrl(token);
    const emailBody = buildInviteEmail(ws.name, input.role, inviter?.name ?? null, acceptUrl);
    void sendSystemEmail(app.db, input.email, emailBody.subject, emailBody.text).catch(() => undefined);

    reply.header('x-invitation-token', token);
    return {
      kind: 'invitation' as const,
      id: invitation.id,
      workspaceId: invitation.workspaceId,
      email: invitation.email,
      role: invitation.role as WorkspaceRole,
      acceptUrl,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  });

  // Update member role (or transfer ownership)
  app.patch('/:id/members/:memberId', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const memberId = parseId((req.params as { memberId: string }).memberId);
    const userId = req.user!.id;
    const input = workspaceMemberRoleUpdate.parse(req.body);

    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (!ws) throw notFound('Workspace not found');

    const callerMembership = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)),
    });
    // Non-members get the same 404 a missing row gets — no id oracle.
    if (!callerMembership && !req.user!.isOperator) throw notFound('Workspace not found');

    const canManage = req.user!.isOperator || callerMembership?.role === 'owner' || callerMembership?.role === 'admin';
    if (!canManage) throw forbidden('Admin or Owner role required to update member roles');

    const targetMembership = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, id)),
    });
    if (!targetMembership) throw notFound('Member not found in this workspace');

    // Keep the ownership row internally consistent. Changing the owner's
    // membership role without transferring `workspaces.ownerId` would either
    // let an admin lock out the owner or leave an owner without owner access.
    if (targetMembership.userId === ws.ownerId && input.role !== 'owner') {
      throw forbidden('The workspace owner role can only change through ownership transfer');
    }

    if (input.role === 'owner') {
      if (ws.ownerId !== userId && !req.user!.isOperator) {
        throw forbidden('Only the workspace owner can transfer ownership');
      }
      // Demote current owner to admin in members table and update workspace ownerId
      await app.db
        .update(workspaceMembers)
        .set({ role: 'admin' })
        .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, ws.ownerId)));

      await app.db.update(workspaces).set({ ownerId: targetMembership.userId }).where(eq(workspaces.id, id));
    }

    const [updated] = await app.db
      .update(workspaceMembers)
      .set({ role: input.role })
      .where(eq(workspaceMembers.id, memberId))
      .returning();

    if (!updated) throw badRequest('Could not update member role');
    const targetUser = await app.db.query.users.findFirst({ where: eq(users.id, targetMembership.userId) });

    void audit(app.db, req.user!.id, 'workspace.member.role_update', `${targetUser?.email ?? memberId} → ${input.role}`);
    return serializeMember(updated, targetUser ?? { email: 'unknown', name: null });
  });

  // Remove a member from the workspace (or leave)
  app.delete('/:id/members/:memberId', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const memberId = parseId((req.params as { memberId: string }).memberId);
    const userId = req.user!.id;

    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    if (!ws) throw notFound('Workspace not found');

    const targetMembership = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, id)),
    });
    if (!targetMembership) throw notFound('Member not found in this workspace');

    const callerMembership = await app.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)),
    });
    // Non-members get the same 404 a missing row gets — no id oracle.
    if (!callerMembership && !req.user!.isOperator) throw notFound('Workspace not found');

    const isSelf = targetMembership.userId === userId;
    const canRemove = req.user!.isOperator || callerMembership?.role === 'owner' || callerMembership?.role === 'admin' || isSelf;
    if (!canRemove) throw forbidden('Permission denied to remove member');

    if (targetMembership.userId === ws.ownerId) {
      throw forbidden('Cannot remove the workspace owner. Transfer ownership or delete the workspace.');
    }

    await app.db.delete(workspaceMembers).where(eq(workspaceMembers.id, memberId));
    void audit(app.db, req.user!.id, 'workspace.member.remove', `Removed member #${memberId} from ${ws.name}`);
    return { ok: true };
  });
};

/**
 * For a service-tag write: return the subset of `ids` the caller is allowed
 * to assign (i.e. workspaces they belong to). Operators see every requested
 * id (we still verify the rows exist). Returns an empty array when none
 * match.
 */
export async function visibleWorkspaceIds(
  db: import('@ninedeploy/db').DB,
  user: { id: number; isOperator: boolean },
  ids: number[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.query.workspaces.findMany({
    where: (w, { inArray: inOp }) => inOp(w.id, ids),
  });
  if (user.isOperator) return rows.map((w) => w.id);
  const ms = await db.query.workspaceMembers.findMany({
    where: (m, { eq: eqOp, and: andOp, inArray: inOp }) =>
      andOp(eqOp(m.userId, user.id), inOp(m.workspaceId, ids)),
  });
  return ms.map((m) => m.workspaceId);
}
