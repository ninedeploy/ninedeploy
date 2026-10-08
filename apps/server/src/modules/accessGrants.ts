import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  accessGrants,
  environments,
  projects,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import {
  accessGrantCreate,
  accessGrantListQuery,
  accessGrantTargetKey,
  accessGrantUpdate,
  type AccessGrant,
  type AccessGrantRole,
  type AccessMe,
  type ProjectAccessEntry,
  type ProjectAccessVia,
} from '@ninedeploy/schemas';
import { grantedWorkspaceIds, grantsForUser, higherGrantRole } from '../lib/accessGrants.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, HttpError, isUniqueViolation, notFound, parseId } from '../lib/errors.js';
import { assertProjectRole, loadProjectForUser, roleAtLeast, type AuthedUser } from '../lib/resourceAccess.js';
import { iso } from '../lib/serialize.js';

/**
 * Project- and environment-level access grants (0.15, raise-only — owner
 * decision O5). Design: .temp_files/run_0.15/DESIGN.md §4.4. Resolution lives
 * in `lib/accessGrants.ts`; `lib/resourceAccess.ts` applies it.
 *
 * Registered in `modules/api.ts` (mount point M1). Each route has its
 * authzMatrix entry (block `0.15 T5 access grants`) and its ROUTE_SPECS entry
 * (`src/openapi/specs/accessGrants.ts`). None gets a PREFIX_SCOPES entry for
 * `workspaces` / `access`, so fine-grained tokens are refused there, as for
 * every other workspace route.
 *
 * Who may grant: a workspace `admin` or `owner`, or an instance operator. A
 * granter can grant up to their own role, capped at `admin` (`owner` is never
 * grantable — the contract's enum stops it); the same rule as seat role
 * changes. Every write is audited (`workspace.access_grant.*`).
 */

type GrantRow = typeof accessGrants.$inferSelect;

const GRANT_RANK: Record<AccessGrantRole, number> = { viewer: 0, member: 1, admin: 2 };

/**
 * The workspace-admin floor every grant route shares. Non-members get the 404
 * a missing workspace gets (no id oracle); a seat below `admin` gets 403.
 * Returns the highest role the caller may grant.
 */
async function grantingRights(db: DB, workspaceId: number, user: AuthedUser): Promise<AccessGrantRole> {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!ws) throw notFound('Workspace not found');
  if (user.isOperator) return 'admin';
  const seat = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)),
  });
  if (!seat) throw notFound('Workspace not found');
  if (!roleAtLeast(seat.role, 'admin')) throw forbidden('Admin or Owner role required to manage access grants');
  // Up to the granter's own role, capped at admin: owner seats grant admin.
  return seat.role === 'owner' ? 'admin' : (seat.role as AccessGrantRole);
}

function assertWithinCap(role: AccessGrantRole, cap: AccessGrantRole): void {
  if (GRANT_RANK[role] > GRANT_RANK[cap]) {
    throw new HttpError(403, 'grant_exceeds_role', `You can grant at most the "${cap}" role`);
  }
}

const CANNOT_GRANT = 'That account cannot be granted access in this workspace';

/**
 * The grant subject, as the caller may name it. An operator may name any
 * account. Anyone else only an account they can already see in a member list
 * (a seat in a workspace where the caller holds one) or that already holds a
 * grant here — an unknown address and an unseen account get the same 404, so
 * the route cannot probe which emails hold an account (the r604 rule the
 * member route keeps).
 */
async function resolveSubject(
  db: DB,
  workspaceId: number,
  caller: AuthedUser,
  input: { email?: string; userId?: number },
): Promise<typeof users.$inferSelect> {
  const target =
    input.email !== undefined
      ? await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${input.email.toLowerCase()}` })
      : await db.query.users.findFirst({ where: eq(users.id, input.userId!) });
  if (!target) throw notFound(CANNOT_GRANT);
  if (!caller.isOperator) {
    const callerWs = (
      await db.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, caller.id))
    ).map((r) => r.id);
    const shared =
      callerWs.length > 0 &&
      (await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.userId, target.id), inArray(workspaceMembers.workspaceId, callerWs)),
      })) !== undefined;
    const granted =
      shared ||
      (await db.query.accessGrants.findFirst({
        where: and(eq(accessGrants.userId, target.id), eq(accessGrants.workspaceId, workspaceId)),
      })) !== undefined;
    if (!granted) throw notFound(CANNOT_GRANT);
  }
  if (target.deactivatedAt) {
    throw new HttpError(409, 'user_deactivated', 'This account is deactivated. Reactivate it before granting it access.');
  }
  return target;
}

/** Grants a workspace admin sees, with the names the UI shows. */
async function viewGrants(db: DB, rows: GrantRow[]): Promise<AccessGrant[]> {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.flatMap((r) => [r.userId, ...(r.createdByUserId != null ? [r.createdByUserId] : [])]))];
  const projectIds = [...new Set(rows.flatMap((r) => (r.projectId != null ? [r.projectId] : [])))];
  const envIds = [...new Set(rows.flatMap((r) => (r.environmentId != null ? [r.environmentId] : [])))];
  const userRows = await db.select().from(users).where(inArray(users.id, userIds));
  const projectRows = projectIds.length ? await db.select().from(projects).where(inArray(projects.id, projectIds)) : [];
  const envRows = envIds.length ? await db.select().from(environments).where(inArray(environments.id, envIds)) : [];
  const seats = await db
    .select({ userId: workspaceMembers.userId, workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.userId, [...new Set(rows.map((r) => r.userId))]));
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const envById = new Map(envRows.map((e) => [e.id, e]));
  const seated = new Set(seats.map((s) => `${s.userId}:${s.workspaceId}`));
  return rows.map((r) => {
    const u = userById.get(r.userId);
    const by = r.createdByUserId != null ? userById.get(r.createdByUserId) : undefined;
    const p = r.projectId != null ? projectById.get(r.projectId) : undefined;
    const e = r.environmentId != null ? envById.get(r.environmentId) : undefined;
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      user: { id: r.userId, email: u?.email ?? 'unknown', name: u?.name ?? null },
      project: p ? { id: p.id, name: p.name } : null,
      environment: e ? { id: e.id, name: e.name } : null,
      role: r.role as AccessGrantRole,
      suspended: r.suspendedAt != null,
      createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
      createdBy: by ? { id: by.id, email: by.email } : null,
      isGuest: !seated.has(`${r.userId}:${r.workspaceId}`),
    };
  });
}

async function loadGrant(db: DB, workspaceId: number, grantId: number): Promise<GrantRow> {
  const row = await db.query.accessGrants.findFirst({
    where: and(eq(accessGrants.id, grantId), eq(accessGrants.workspaceId, workspaceId)),
  });
  if (!row) throw notFound('Access grant not found');
  return row;
}

const auditMeta = (row: GrantRow, previousRole?: string) => ({
  grantId: row.id,
  userId: row.userId,
  projectId: row.projectId,
  environmentId: row.environmentId,
  role: row.role,
  ...(previousRole !== undefined && { previousRole }),
});

/** `/v1/workspaces/:wid/access-grants` CRUD (workspace admin; operators pass). */
export const accessGrantRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:wid/access-grants', async (req) => {
    const wid = parseId((req.params as { wid: string }).wid);
    await grantingRights(app.db, wid, req.user!);
    const q = accessGrantListQuery.parse(req.query ?? {});
    const rows = await app.db
      .select()
      .from(accessGrants)
      .where(
        and(
          eq(accessGrants.workspaceId, wid),
          q.userId !== undefined ? eq(accessGrants.userId, q.userId) : undefined,
          q.projectId !== undefined ? eq(accessGrants.projectId, q.projectId) : undefined,
          q.environmentId !== undefined ? eq(accessGrants.environmentId, q.environmentId) : undefined,
        ),
      )
      .orderBy(asc(accessGrants.id));
    return viewGrants(app.db, rows);
  });

  app.post('/:wid/access-grants', async (req, reply) => {
    const wid = parseId((req.params as { wid: string }).wid);
    const cap = await grantingRights(app.db, wid, req.user!);
    const input = accessGrantCreate.parse(req.body);
    assertWithinCap(input.role, cap);
    // A grant's project and environment must sit in the grant's workspace
    // (re-checked at read time, so a later move cannot carry it elsewhere).
    if (input.projectId !== undefined) {
      const project = await app.db.query.projects.findFirst({ where: eq(projects.id, input.projectId) });
      if (!project || project.workspaceId !== wid) throw notFound('Project not found');
    }
    if (input.environmentId !== undefined) {
      const env = await app.db.query.environments.findFirst({ where: eq(environments.id, input.environmentId) });
      if (!env || env.workspaceId !== wid) throw notFound('Environment not found');
    }
    const target = await resolveSubject(app.db, wid, req.user!, input);
    const targetKey = accessGrantTargetKey(input);
    const duplicate = () => conflict('This user already holds a grant on that target; change its role instead');
    const existing = await app.db.query.accessGrants.findFirst({
      where: and(eq(accessGrants.userId, target.id), eq(accessGrants.targetKey, targetKey)),
    });
    if (existing) throw duplicate();
    let row: GrantRow | undefined;
    try {
      [row] = await app.db
        .insert(accessGrants)
        .values({
          workspaceId: wid,
          userId: target.id,
          projectId: input.projectId ?? null,
          environmentId: input.environmentId ?? null,
          targetKey,
          role: input.role,
          createdByUserId: req.user!.id,
        })
        .returning();
    } catch (err) {
      // The (user_id, target_key) unique index is the race backstop.
      if (isUniqueViolation(err)) throw duplicate();
      throw err;
    }
    void audit(app.db, req.user!.id, 'workspace.access_grant.create', `${target.email} → ${targetKey} (${input.role})`, auditMeta(row!));
    const [view] = await viewGrants(app.db, [row!]);
    return reply.code(201).send(view);
  });

  app.patch('/:wid/access-grants/:grantId', async (req) => {
    const { wid: rawWid, grantId: rawGrant } = req.params as { wid: string; grantId: string };
    const wid = parseId(rawWid);
    const cap = await grantingRights(app.db, wid, req.user!);
    const grant = await loadGrant(app.db, wid, parseId(rawGrant));
    const input = accessGrantUpdate.parse(req.body);
    assertWithinCap(input.role, cap);
    // Lowering a grant someone above the caller's cap issued is still a
    // change to a grant they could not have made: same cap on the old role.
    assertWithinCap(grant.role as AccessGrantRole, cap);
    const [updated] = await app.db
      .update(accessGrants)
      .set({ role: input.role, updatedAt: new Date() })
      .where(eq(accessGrants.id, grant.id))
      .returning();
    if (!updated) throw notFound('Access grant not found');
    void audit(app.db, req.user!.id, 'workspace.access_grant.update', `grant #${grant.id}: ${grant.role} → ${input.role}`, auditMeta(updated, grant.role));
    const [view] = await viewGrants(app.db, [updated]);
    return view;
  });

  app.delete('/:wid/access-grants/:grantId', async (req) => {
    const { wid: rawWid, grantId: rawGrant } = req.params as { wid: string; grantId: string };
    const wid = parseId(rawWid);
    const cap = await grantingRights(app.db, wid, req.user!);
    const grant = await loadGrant(app.db, wid, parseId(rawGrant));
    assertWithinCap(grant.role as AccessGrantRole, cap);
    const gone = await app.db.delete(accessGrants).where(eq(accessGrants.id, grant.id)).returning({ id: accessGrants.id });
    if (!gone[0]) throw notFound('Access grant not found');
    void audit(app.db, req.user!.id, 'workspace.access_grant.delete', `grant #${grant.id}`, auditMeta(grant));
    return { ok: true };
  });
};

/** `GET /v1/projects/:id/access` (project admin): who reaches the project, and how. */
export const projectAccessRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/access', async (req): Promise<ProjectAccessEntry[]> => {
    const id = parseId((req.params as { id: string }).id);
    const project = await loadProjectForUser(app.db, id, req.user!);
    await assertProjectRole(app.db, project, req.user!, 'admin');
    type Entry = { user: typeof users.$inferSelect; seat: string | null; grant: AccessGrantRole | null; via: Set<ProjectAccessVia> };
    const byUser = new Map<number, Entry>();
    const entry = (u: typeof users.$inferSelect) => {
      let e = byUser.get(u.id);
      if (!e) {
        e = { user: u, seat: null, grant: null, via: new Set() };
        byUser.set(u.id, e);
      }
      return e;
    };
    // A deactivated account reaches nothing (the auth resolver refuses it).
    for (const u of await app.db.select().from(users).where(and(eq(users.isInstanceOperator, true), isNull(users.deactivatedAt)))) {
      entry(u).via.add('operator');
    }
    if (project.workspaceId != null) {
      const seats = await app.db
        .select({ user: users, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(and(eq(workspaceMembers.workspaceId, project.workspaceId), isNull(users.deactivatedAt)));
      for (const s of seats) {
        const e = entry(s.user);
        e.seat = s.role;
        e.via.add('seat');
      }
      // Project grants (no environment) — the ones that open the project row.
      const grants = await app.db
        .select({ user: users, role: accessGrants.role })
        .from(accessGrants)
        .innerJoin(users, eq(users.id, accessGrants.userId))
        .where(
          and(
            eq(accessGrants.projectId, project.id),
            isNull(accessGrants.environmentId),
            eq(accessGrants.workspaceId, project.workspaceId),
            isNull(accessGrants.suspendedAt),
            isNull(users.deactivatedAt),
          ),
        );
      for (const g of grants) {
        const e = entry(g.user);
        e.grant = higherGrantRole(e.grant, g.role as AccessGrantRole);
        e.via.add('grant');
      }
    }
    const RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
    return [...byUser.values()]
      .map((e) => {
        const role = e.via.has('operator')
          ? 'owner'
          : [e.seat, e.grant].reduce<string>((best, r) => (r !== null && RANK[r]! > RANK[best]! ? r : best), 'viewer');
        return {
          user: { id: e.user.id, email: e.user.email, name: e.user.name ?? null },
          role: role as ProjectAccessEntry['role'],
          via: (['operator', 'seat', 'grant', 'creator'] as const).filter((v) => e.via.has(v)),
        };
      })
      .sort((a, b) => a.user.email.localeCompare(b.user.email));
  });
};

/** `GET /v1/access/me` (self): the caller's own grants and guest workspaces. */
export const accessMeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/me', async (req): Promise<AccessMe> => {
    const userId = req.user!.id;
    const rows = await app.db.select().from(accessGrants).where(eq(accessGrants.userId, userId)).orderBy(asc(accessGrants.id));
    // Guest workspaces: reached through a grant that counts, with no seat.
    const seatWs = new Set(
      (await app.db.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId))).map(
        (r) => r.id,
      ),
    );
    const guestIds = grantedWorkspaceIds(await grantsForUser(app.db, userId)).filter((w) => !seatWs.has(w));
    const guestWorkspaces = guestIds.length
      ? (await app.db.select().from(workspaces).where(inArray(workspaces.id, guestIds)).orderBy(asc(workspaces.name))).map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
        }))
      : [];
    return { grants: await viewGrants(app.db, rows), guestWorkspaces };
  });
};
