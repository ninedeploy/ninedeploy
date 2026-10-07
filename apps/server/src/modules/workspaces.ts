import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  databaseAttachments,
  databases,
  projects,
  services,
  serviceWorkspaces,
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
import { badRequest, conflict, forbidden, HttpError, notFound, parseId } from '../lib/errors.js';
import { iso } from '../lib/serialize.js';
import { slugify, slugifyWithSuffix } from '../lib/slug.js';
import { createOrRefreshInvitation, buildAcceptUrl, renderInviteEmail } from './invitations.js';
import { sendSystemEmail } from '../lib/notifier.js';
import { purgeProjectEnvVars } from './projects.js';

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

/**
 * D6/F1004: a deactivated account (SCIM sets `users.deactivatedAt`) gets no
 * seat and no workspace ownership. Its seats keep nothing (F952), so a seat
 * added later would only decide who inherits a shared service. The account is
 * re-activated first (SCIM PATCH active=true); callers test the state at seat time.
 */
const userDeactivated = (action = 'adding it to a workspace') =>
  new HttpError(409, 'user_deactivated', `This account is deactivated. Reactivate it before ${action}.`);

export async function ensureDefaultWorkspace(
  db: Pick<DB, 'query' | 'select' | 'insert' | 'update' | 'delete'>,
  user: { id: number; name?: string | null; email?: string },
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

  // F146: the workspace is the user's own (ownerId), so the seat is owner.
  await db.insert(workspaceMembers).values({
    workspaceId: ws!.id,
    userId: user.id,
    role: 'owner',
  });

  return ws!;
}

/**
 * Like `ensureDefaultWorkspace` but always grants the given role even when
 * a workspace already exists — except to the workspace's owner (F146): the
 * ownerId's seat is always owner (see the role PATCH route), so a personal
 * workspace never gets a non-owner seat for its own owner.
 */
export async function ensureDefaultWorkspaceWithRole(
  db: Pick<DB, 'query' | 'select' | 'insert' | 'update' | 'delete'>,
  user: { id: number; name?: string | null; email?: string },
  role: WorkspaceRole,
): Promise<Workspace> {
  const ws = await ensureDefaultWorkspace(db, user);
  // ensureDefaultWorkspace is a no-op when a workspace already exists; in
  // that case we still need to align the membership role with the requested
  // value (idempotent UPDATE).
  await db
    .update(workspaceMembers)
    .set({ role: ws.ownerId === user.id ? 'owner' : role })
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

    // r541: the workspace's projects go with it (FK cascade); their shared
    // env vars have no FK and must be deleted explicitly.
    await app.db.transaction(async (tx) => {
      const owned = await tx.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, id));
      await purgeProjectEnvVars(tx, owned.map((p) => p.id));
      await tx.delete(workspaces).where(eq(workspaces.id, id));
    });
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

    // Already a member of THIS workspace: 404. That reveals nothing the
    // caller cannot already read from the member list.
    if (targetUser) {
      const existingMember = await app.db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, targetUser.id)),
      });
      if (existingMember) throw notFound('That email address cannot be added to this workspace');
    }

    // r604: answering "added" for a registered address and "invited" for an
    // unknown one let any workspace admin probe which emails hold an account
    // on the instance. Only an instance operator — who can list every account
    // anyway — still gets the direct add; everyone else always goes through
    // the invitation flow, whose response is the same whether or not an
    // account exists (a registered recipient accepts it from their account).
    if (targetUser && req.user!.isOperator) {
      // F1004: an operator sees account states anyway, so the refusal reveals nothing.
      if (targetUser.deactivatedAt) throw userDeactivated();
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

    // Invitation flow. The frontend uses one button for both outcomes; the
    // response shape carries the invitation row so the UI can render the
    // accept URL inline.
    const { token, invitation } = await createOrRefreshInvitation(app.db, {
      workspaceId: id,
      email: input.email,
      role: input.role,
      invitedByUserId: userId,
    });
    const inviter = await app.db.query.users.findFirst({ where: eq(users.id, userId) });
    void audit(app.db, userId, 'workspace.invitation.create', `${input.email} (${input.role}) to ${ws.name}`);

    const acceptUrl = buildAcceptUrl(token);
    // r610: rendered through the template engine — the workspace's override applies.
    const emailBody = await renderInviteEmail(app.db, id, ws.name, input.role, inviter?.name ?? null, acceptUrl);
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
      // F1005: the owner is the heir of every hand-over (rehomeOwnedResources),
      // so ownership never goes to an account that cannot act.
      const heir = await app.db.query.users.findFirst({ where: eq(users.id, targetMembership.userId) });
      if (heir?.deactivatedAt) throw userDeactivated('transferring workspace ownership to it');
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
    await rehomeOwnedResources(app.db, id, targetMembership.userId, ws.ownerId);
    void audit(app.db, req.user!.id, 'workspace.member.remove', `Removed member #${memberId} from ${ws.name}`);
    return { ok: true };
  });
};

/**
 * Hand the workspace's resources that `removedUserId` owns over to the
 * workspace owner (r097).
 *
 * `ownerUserId` is an access grant on its own — `loadServiceForUser`,
 * `serviceRole` and `databaseRole` all short-circuit to `owner` on it. So a
 * member removed from a team kept owner-level control (env, deploys, DB
 * credentials, backups, delete) over everything they had created inside it.
 * Services tagged into this workspace and databases in its projects now
 * change hands; resources the user owns elsewhere are untouched.
 *
 * `mode` (F144/F145): a `seat-loss` (member removal, SCIM) applies the
 * r694/r710 rule ownershipBackfill.ts applies — an operator's resources are
 * never handed over, and a service also tagged into a workspace where the
 * user still holds a seat stays theirs. `account-deletion` (the user row is
 * about to go, all seats still present) hands everything over so nothing is
 * detached by `ON DELETE SET NULL`.
 */
export async function rehomeOwnedResources(
  db: Pick<DB, 'query' | 'select' | 'update'>,
  workspaceId: number,
  removedUserId: number,
  newOwnerId: number,
  mode: 'seat-loss' | 'account-deletion' = 'seat-loss',
): Promise<void> {
  const seatLoss = mode === 'seat-loss';
  // F952: another seat keeps a service only for an account that can still act,
  // the same test the operator exemption applies. A deactivated user keeps
  // their seats (SCIM PATCH), but those seats no longer keep anything.
  let otherSeatsKeep = seatLoss;
  if (seatLoss) {
    const removed = await db.query.users.findFirst({ where: eq(users.id, removedUserId) });
    if (removed?.isInstanceOperator === true && !removed.deactivatedAt) return;
    if (removed?.deactivatedAt) otherSeatsKeep = false;
  }
  const tagged = await db
    .select({ id: serviceWorkspaces.serviceId })
    .from(serviceWorkspaces)
    .where(eq(serviceWorkspaces.workspaceId, workspaceId));
  let serviceIds = tagged.map((r) => r.id);
  if (otherSeatsKeep && serviceIds.length > 0) {
    const otherSeats = (
      await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, removedUserId))
    )
      .map((s) => s.workspaceId)
      .filter((w) => w !== workspaceId);
    if (otherSeats.length > 0) {
      const kept = await db
        .select({ id: serviceWorkspaces.serviceId })
        .from(serviceWorkspaces)
        .where(and(inArray(serviceWorkspaces.serviceId, serviceIds), inArray(serviceWorkspaces.workspaceId, otherSeats)));
      const keep = new Set(kept.map((r) => r.id));
      serviceIds = serviceIds.filter((id) => !keep.has(id));
    }
  }
  if (serviceIds.length > 0) {
    // F147: a template service's managed database moves with it. An unfiled
    // one (no project) is outside the project rule below, and left with the
    // previous owner it fails the next deploy's same-owner check in
    // reconcileTemplateDependencies ("belongs to another resource").
    const templateServices = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.ownerUserId, removedUserId), inArray(services.id, serviceIds), isNotNull(services.templateId)));
    await db
      .update(services)
      .set({ ownerUserId: newOwnerId })
      .where(and(eq(services.ownerUserId, removedUserId), inArray(services.id, serviceIds)));
    if (templateServices.length > 0) {
      const attached = await db
        .select({ id: databaseAttachments.databaseId })
        .from(databaseAttachments)
        .where(inArray(databaseAttachments.serviceId, templateServices.map((s) => s.id)));
      if (attached.length > 0) {
        await db
          .update(databases)
          .set({ ownerUserId: newOwnerId })
          .where(
            and(
              eq(databases.ownerUserId, removedUserId),
              isNull(databases.projectId),
              inArray(databases.id, attached.map((a) => a.id)),
            ),
          );
      }
    }
  }
  const wsProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, workspaceId));
  const projectIds = wsProjects.map((p) => p.id);
  if (projectIds.length > 0) {
    await db
      .update(databases)
      .set({ ownerUserId: newOwnerId })
      .where(and(eq(databases.ownerUserId, removedUserId), inArray(databases.projectId, projectIds)));
  }
}

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
