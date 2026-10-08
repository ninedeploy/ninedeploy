import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import {
  accessGrants,
  environments,
  projects,
  serviceProjects,
  serviceWorkspaces,
  services,
  users,
  type DB,
} from '@ninedeploy/db';
import { audit } from './audit.js';

/**
 * Project- and environment-level access grants (0.15, DESIGN §4). Owner
 * decision O5: grants are RAISE-ONLY.
 *
 *   effective role on a resource = max(seat role in its workspace(s),
 *                                      max role of the matching grants)
 *
 * With no grant rows that is the seat role, so every 0.14 permission is
 * unchanged by construction (proven by test/accessGrantsEquivalence.test.ts);
 * a grant can only ever add access for its one user, and a rollback to 0.14
 * (which ignores the table) can only ever remove access.
 *
 * What a grant covers:
 *   • project grant (P)            → the project row, databases in P, and
 *                                    services linked to P (`service_projects`);
 *   • environment grant (E)        → services with `environmentId = E` that are
 *                                    tagged into E's workspace;
 *   • project + environment (P, E) → services linked to P AND in E (not the
 *                                    project row, not P's databases).
 * Databases have no environment, so environment grants never cover one.
 *
 * A grant counts only while it is not suspended (SCIM), its user is not
 * deactivated, and its project and environment still belong to the grant's
 * workspace — a project moved to another workspace stops matching its old
 * grants at read time, before the move's cleanup deletes them. Workspace-level
 * rights (members, labels, settings, creating projects) never come from a
 * grant: `assertWorkspaceRole` stays seat-only.
 *
 * Every resolver here reads its grants fresh (one indexed query on
 * `access_grants(user_id, …)`), so a revoked grant stops working on the very
 * next check — no per-request cache can serve a stale "yes".
 */

type DbLike = Pick<DB, 'query' | 'select' | 'insert' | 'update' | 'delete'>;

export type GrantRole = 'viewer' | 'member' | 'admin';

/** A grant that currently counts. */
export interface ActiveGrant {
  id: number;
  workspaceId: number;
  projectId: number | null;
  environmentId: number | null;
  role: GrantRole;
}

const GRANT_RANK: Record<GrantRole, number> = { viewer: 0, member: 1, admin: 2 };

/** The higher of two grant roles (`null` = none). */
export function higherGrantRole(a: GrantRole | null, b: GrantRole | null): GrantRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return GRANT_RANK[a] >= GRANT_RANK[b] ? a : b;
}

function maxOf(grants: ActiveGrant[]): GrantRole | null {
  let best: GrantRole | null = null;
  for (const g of grants) best = higherGrantRole(best, g.role);
  return best;
}

/**
 * The user's grants that count right now: not suspended, the user not
 * deactivated, and the project / environment still in the grant's workspace.
 */
export async function grantsForUser(db: DbLike, userId: number): Promise<ActiveGrant[]> {
  const rows = await db
    .select({
      id: accessGrants.id,
      workspaceId: accessGrants.workspaceId,
      projectId: accessGrants.projectId,
      environmentId: accessGrants.environmentId,
      role: accessGrants.role,
    })
    .from(accessGrants)
    .innerJoin(users, eq(users.id, accessGrants.userId))
    .leftJoin(projects, eq(projects.id, accessGrants.projectId))
    .leftJoin(environments, eq(environments.id, accessGrants.environmentId))
    .where(
      and(
        eq(accessGrants.userId, userId),
        isNull(accessGrants.suspendedAt),
        isNull(users.deactivatedAt),
        or(isNull(accessGrants.projectId), eq(projects.workspaceId, accessGrants.workspaceId)),
        or(isNull(accessGrants.environmentId), eq(environments.workspaceId, accessGrants.workspaceId)),
      ),
    );
  // `owner` is never grantable (the API's enum refuses it); a row written
  // around the API with any other role counts for nothing rather than for
  // more than a grant may give.
  return rows.filter((r): r is typeof r & { role: GrantRole } => Object.hasOwn(GRANT_RANK, r.role));
}

/** Project grants (no environment) on `projectId`: the project row and its databases. */
export function projectGrantRole(grants: ActiveGrant[], projectId: number | null): GrantRole | null {
  if (projectId == null) return null;
  return maxOf(grants.filter((g) => g.projectId === projectId && g.environmentId == null));
}

/** Projects the user reaches through a project grant. */
export function grantedProjectIds(grants: ActiveGrant[]): number[] {
  return [...new Set(grants.filter((g) => g.projectId != null && g.environmentId == null).map((g) => g.projectId!))];
}

/** Environments any grant names (environment, or project + environment). */
export function grantedEnvironmentIds(grants: ActiveGrant[]): number[] {
  return [...new Set(grants.filter((g) => g.environmentId != null).map((g) => g.environmentId!))];
}

/** Workspaces the user reaches through at least one counting grant. */
export function grantedWorkspaceIds(grants: ActiveGrant[]): number[] {
  return [...new Set(grants.map((g) => g.workspaceId))];
}

interface ServiceShape {
  projectIds: Set<number>;
  environmentId: number | null;
  workspaceIds: Set<number>;
}

function covers(g: ActiveGrant, s: ServiceShape): boolean {
  if (g.projectId != null && !s.projectIds.has(g.projectId)) return false;
  if (g.environmentId != null) {
    if (s.environmentId !== g.environmentId) return false;
    // A bare environment grant needs the service to live in E's workspace;
    // with a project too, the project link already ties it to the grant.
    if (g.projectId == null && !s.workspaceIds.has(g.workspaceId)) return false;
  }
  return true;
}

/**
 * The highest grant role covering one service (`null` = none). Pass the
 * service's `environmentId` when the caller holds the row; it is read
 * otherwise (only when an environment grant could match).
 */
export async function grantRoleForService(
  db: DbLike,
  grants: ActiveGrant[],
  service: { id: number; environmentId?: number | null },
): Promise<GrantRole | null> {
  if (grants.length === 0) return null;
  const needsLinks = grants.some((g) => g.projectId != null);
  const needsEnv = grants.some((g) => g.environmentId != null);
  const needsTags = grants.some((g) => g.environmentId != null && g.projectId == null);
  const projectIds = new Set<number>();
  if (needsLinks) {
    const links = await db
      .select({ projectId: serviceProjects.projectId })
      .from(serviceProjects)
      .where(eq(serviceProjects.serviceId, service.id));
    for (const l of links) projectIds.add(l.projectId);
  }
  let environmentId: number | null = null;
  if (needsEnv) {
    if (service.environmentId !== undefined) environmentId = service.environmentId;
    else {
      const [row] = await db.select({ environmentId: services.environmentId }).from(services).where(eq(services.id, service.id));
      environmentId = row?.environmentId ?? null;
    }
  }
  const workspaceIds = new Set<number>();
  if (needsTags) {
    const tags = await db
      .select({ workspaceId: serviceWorkspaces.workspaceId })
      .from(serviceWorkspaces)
      .where(eq(serviceWorkspaces.serviceId, service.id));
    for (const t of tags) workspaceIds.add(t.workspaceId);
  }
  const shape: ServiceShape = { projectIds, environmentId, workspaceIds };
  return maxOf(grants.filter((g) => covers(g, shape)));
}

/** Every service id some grant covers (for `visibleServiceIdSet`). */
export async function servicesCoveredByGrants(db: DbLike, grants: ActiveGrant[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (grants.length === 0) return out;
  const pIds = [...new Set(grants.filter((g) => g.projectId != null).map((g) => g.projectId!))];
  const eIds = grantedEnvironmentIds(grants);
  const shapes = new Map<number, ServiceShape>();
  const shapeOf = (id: number) => {
    let s = shapes.get(id);
    if (!s) {
      s = { projectIds: new Set(), environmentId: null, workspaceIds: new Set() };
      shapes.set(id, s);
    }
    return s;
  };
  if (pIds.length > 0) {
    const links = await db
      .select({ serviceId: serviceProjects.serviceId, projectId: serviceProjects.projectId })
      .from(serviceProjects)
      .where(inArray(serviceProjects.projectId, pIds));
    for (const l of links) shapeOf(l.serviceId).projectIds.add(l.projectId);
  }
  if (eIds.length > 0) {
    const inEnv = await db
      .select({ id: services.id, environmentId: services.environmentId })
      .from(services)
      .where(inArray(services.environmentId, eIds));
    for (const s of inEnv) shapeOf(s.id).environmentId = s.environmentId;
    if (inEnv.length > 0 && grants.some((g) => g.environmentId != null && g.projectId == null)) {
      const tags = await db
        .select({ serviceId: serviceWorkspaces.serviceId, workspaceId: serviceWorkspaces.workspaceId })
        .from(serviceWorkspaces)
        .where(inArray(serviceWorkspaces.serviceId, inEnv.map((s) => s.id)));
      for (const t of tags) shapeOf(t.serviceId).workspaceIds.add(t.workspaceId);
    }
  }
  for (const [id, shape] of shapes) if (grants.some((g) => covers(g, shape))) out.add(id);
  return out;
}

// ── lifecycle (DESIGN §4.3): a grant never outlives what justified it ──────

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

/**
 * Member removed from workspace W (API removal, SCIM DELETE): their grants in
 * W go too — a removed member must not stay behind as a guest.
 */
export async function deleteGrantsForMember(
  db: DbLike,
  workspaceId: number,
  userId: number,
  actorUserId: number | null,
): Promise<number> {
  const gone = await db
    .delete(accessGrants)
    .where(and(eq(accessGrants.workspaceId, workspaceId), eq(accessGrants.userId, userId)))
    .returning({ id: accessGrants.id });
  if (gone.length > 0) {
    void audit(db as DB, actorUserId, 'workspace.access_grant.delete', `user #${userId} in workspace #${workspaceId}`, {
      grantIds: ids(gone),
      userId,
      workspaceId,
      reason: 'member_removed',
    });
  }
  return gone.length;
}

/** SCIM deactivation in W: the user's grants in W stop counting until reinstated. */
export async function suspendGrantsForMember(db: DbLike, workspaceId: number, userId: number): Promise<number> {
  const rows = await db
    .update(accessGrants)
    .set({ suspendedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(accessGrants.workspaceId, workspaceId), eq(accessGrants.userId, userId), isNull(accessGrants.suspendedAt)))
    .returning({ id: accessGrants.id });
  if (rows.length > 0) {
    void audit(db as DB, null, 'workspace.access_grant.suspend', `user #${userId} in workspace #${workspaceId}`, {
      grantIds: ids(rows),
      userId,
      workspaceId,
    });
  }
  return rows.length;
}

/** SCIM re-activation in W: grants suspended there count again. */
export async function reinstateGrantsForMember(db: DbLike, workspaceId: number, userId: number): Promise<number> {
  const rows = await db
    .update(accessGrants)
    .set({ suspendedAt: null, updatedAt: new Date() })
    .where(and(eq(accessGrants.workspaceId, workspaceId), eq(accessGrants.userId, userId), isNotNull(accessGrants.suspendedAt)))
    .returning({ id: accessGrants.id });
  if (rows.length > 0) {
    void audit(db as DB, null, 'workspace.access_grant.reinstate', `user #${userId} in workspace #${workspaceId}`, {
      grantIds: ids(rows),
      userId,
      workspaceId,
    });
  }
  return rows.length;
}

/** A project moved to another workspace (M23): its grants belonged to the old one. */
export async function deleteGrantsForProject(db: DbLike, projectId: number, actorUserId: number | null): Promise<number> {
  const gone = await db
    .delete(accessGrants)
    .where(eq(accessGrants.projectId, projectId))
    .returning({ id: accessGrants.id });
  if (gone.length > 0) {
    void audit(db as DB, actorUserId, 'workspace.access_grant.delete', `project #${projectId}`, {
      grantIds: ids(gone),
      projectId,
      reason: 'project_moved',
    });
  }
  return gone.length;
}
