import { and, eq, inArray, or } from 'drizzle-orm';
import {
  databases,
  projects,
  serviceProjects,
  serviceWorkspaces,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
  type Database,
  type Project,
  type Service,
  type workspaceRole,
} from '@ninedeploy/db';

/**
 * Any object that exposes the drizzle query / select / insert / update /
 * delete surface — the regular `DB` and a `SQLiteTransaction` are both
 * `DbLike`. The auth/scope helpers use this so the same call works inside
 * or outside a `db.transaction(...)` block.
 */
type DbLike = Pick<DB, 'query' | 'select' | 'insert' | 'update' | 'delete'>;

/** Workspace role union, derived from the runtime enum. */
type WorkspaceRole = (typeof workspaceRole)[number];
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, notFound, parseId } from './errors.js';

/**
 * Central authorization choke-point for every resource-scoped route.
 *
 * Background: services were guarded from the start (`services.ownerUserId`),
 * but projects and databases shipped without an access decision — any
 * authenticated user could read, mutate or delete another tenant's rows. This
 * module exists so that "which subject may touch which row" is answered in ONE
 * place, and so a newly added resource has to opt into a rule here rather than
 * silently defaulting to "everyone".
 *
 * Workspace-only RBAC (post team-overhaul):
 *
 *   service    → caller must be a member of a workspace the service is tagged
 *                into (via `service_workspaces`), or be the service's
 *                `ownerUserId` (creator). Legacy `ownerUserId`-only access is
 *                preserved as a fallback when a service has no workspace tags.
 *   project    → caller must be a member of the project's workspace; a
 *                project with NULL `workspaceId` is owner-of-any-workspace
 *                only.
 *   database   → `ownerUserId` match, OR membership of a workspace the
 *                database's project belongs to; NULL owner + NULL project is
 *                owner-of-any-workspace only.
 *
 * Operator-level actions (manage OIDC, list all users, import/export the
 * instance, host-privileged deploys) are gated by `requireOperator`, which
 * reads the dedicated `users.is_instance_operator` column. It is deliberately
 * NOT derived from workspace roles — see `isOperator` for why. The legacy
 * global `users.role` column is gone.
 *
 * Within a workspace, the four roles form a hierarchy
 * (owner > admin > member > viewer) enforced by `assertWorkspaceRole` and, for
 * service-scoped writes, `assertServiceRole`. `viewer` is read-only.
 *
 * Not-found vs forbidden: loaders throw 404 (never 403) when a member is
 * denied, so resource ids cannot be enumerated by probing for a status-code
 * difference. `assert*` helpers operate on a row the caller already holds and
 * throw 403, because existence is by then already established.
 */

export interface AuthedUser {
  id: number;
  /**
   * True when `users.is_instance_operator` is set — the instance-wide
   * operator flag. The legacy `role: 'admin' | 'member'` field is gone, and
   * this flag is NOT inferred from workspace membership (that inference was
   * self-granting; see `isOperator`).
   *
   * On a REQUEST, this field is authoritative and routes must gate on it (via
   * `app.requireOperator`), never by re-reading the column. `plugins/auth.ts`
   * has already narrowed it for a scope-restricted API token — a `write` token
   * owned by an operator runs as a non-operator — and a fresh DB read would
   * hand that authority straight back. `isOperator(db, user)` exists for the
   * paths with no request behind them (the deploy pipeline, webhook receivers),
   * where there are no scopes to preserve.
   */
  isOperator: boolean;
}

export type ResourceKind = 'service' | 'project' | 'database';

// ── workspace membership ───────────────────────────────────────────────────

/** A single (workspaceId, role) pair. */
export interface WorkspaceMembership {
  workspaceId: number;
  role: WorkspaceRole;
}

/** All workspace memberships the user holds. Empty array when none. */
export async function userWorkspaceMemberships(db: DbLike, userId: number): Promise<WorkspaceMembership[]> {
  const rows = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.userId, userId),
  });
  return rows.map((r) => ({ workspaceId: r.workspaceId, role: r.role as WorkspaceRole }));
}

/** All workspace ids the user belongs to (empty when none). */
export async function userWorkspaceIds(db: DbLike, userId: number): Promise<number[]> {
  const ms = await userWorkspaceMemberships(db, userId);
  return ms.map((m) => m.workspaceId);
}

/** True when the user holds any seat in the workspace. */
export async function isWorkspaceMember(db: DbLike, workspaceId: number, user: { id: number }): Promise<boolean> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)),
  });
  return membership != null;
}

/** Throws 403 unless the user holds any seat in the workspace. */
export async function assertWorkspaceMember(db: DbLike, workspaceId: number, user: AuthedUser): Promise<void> {
  if (!(await isWorkspaceMember(db, workspaceId, user))) {
    throw forbidden('You do not have access to this workspace');
  }
}

/**
 * True when the user holds the given role or higher in the workspace.
 * Owner > admin > member > viewer.
 */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required]!;
}

export async function assertWorkspaceRole(
  db: DbLike,
  workspaceId: number,
  user: AuthedUser,
  required: WorkspaceRole | WorkspaceRole[],
): Promise<void> {
  const requiredList = Array.isArray(required) ? required : [required];
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)),
  });
  if (!membership || !requiredList.some((r) => roleAtLeast(membership.role as WorkspaceRole, r))) {
    throw forbidden('Insufficient role for this workspace');
  }
}

/** Highest role the user holds across all their workspace seats. */
export function maxRole(memberships: WorkspaceMembership[]): WorkspaceRole | null {
  if (memberships.length === 0) return null;
  let best: WorkspaceRole = 'viewer';
  for (const m of memberships) if (ROLE_RANK[m.role]! > ROLE_RANK[best]!) best = m.role;
  return best;
}

/**
 * True when the user can act as a SYSTEM operator: manage OIDC and users,
 * import/export the instance, run the self-updater, reach the container file
 * browser, and — critically — use the host-privileged deploy features gated by
 * `lib/hostPrivilege.ts` (PM2, compose, lifecycle hooks, docker-socket
 * templates).
 *
 * This reads a dedicated `users.is_instance_operator` column and is NOT derived
 * from workspace membership.
 *
 * History (why the column exists): the predecessor of this function returned
 * "holds owner/admin in at least one workspace". Any authenticated user can
 * create a workspace they own (`POST /v1/workspaces` has no role gate), and
 * `GET /v1/workspaces` even auto-creates an owned workspace for a user with no
 * memberships. One request therefore turned any member into a full instance
 * operator — and because the host-privilege boundary hangs off this same flag,
 * that was a path from "member" to arbitrary code execution on the host.
 * Workspace roles are now strictly workspace-scoped; see `assertWorkspaceRole`
 * for the in-workspace hierarchy.
 *
 * Accepts anything with a numeric `id` so the auth resolver can pass the
 * half-built user shape (tokenVersion, no operator flag yet).
 */
export async function isOperator(db: DbLike, user: { id: number }): Promise<boolean> {
  const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  return row?.isInstanceOperator === true;
}

// ── services ───────────────────────────────────────────────────────────────

/** Workspace ids a service is currently tagged into (empty when un-tagged). */
export async function serviceWorkspaceIds(db: DbLike, serviceId: number): Promise<number[]> {
  const rows = await db.query.serviceWorkspaces.findMany({
    where: eq(serviceWorkspaces.serviceId, serviceId),
  });
  return rows.map((r) => r.workspaceId);
}

/**
 * Resolve a service the user may manage, else 404.
 *
 * Access rule (post team overhaul): the caller is allowed if they are a
 * member of any workspace the service is tagged into. `ownerUserId` is
 * consulted as a fallback for un-tagged services so legacy rows keep working.
 *
 * The `isOperator` flag on the user is computed once per request by the
 * auth plugin (it queries `workspace_members` for an owner/admin seat) and
 * is the only operator-level bypass here.
 */
export async function loadServiceForUser(db: DbLike, id: number, user: AuthedUser): Promise<Service> {
  const svc = await db.query.services.findFirst({ where: eq(services.id, id) });
  if (!svc) throw notFound('Service not found');
  if (svc.ownerUserId === user.id) return svc;
  if (user.isOperator) return svc;
  const tagWsIds = await serviceWorkspaceIds(db, svc.id);
  if (tagWsIds.length > 0) {
    const hits = await db.query.workspaceMembers.findMany({
      where: and(
        eq(workspaceMembers.userId, user.id),
        inArray(workspaceMembers.workspaceId, tagWsIds),
      ),
    });
    if (hits.length > 0) return svc;
  }
  // 404 on miss so members cannot probe for the existence of services they
  // can't see by id.
  throw notFound('Service not found');
}

/**
 * The ONE answer to "which services may this user see?".
 *
 * Three call sites used to compute this independently and disagree:
 * `GET /v1/services` filtered on `ownerUserId` alone, while `/dashboard` and
 * `/domains` also honoured workspace tags and `loadServiceForUser` honoured
 * both plus the operator flag. The visible symptom was a teammate who could
 * open and deploy a shared service by id but never saw it in their own list,
 * while the dashboard counted it. Everything now routes through here.
 *
 * `null` means "unrestricted" (instance operator) — callers should skip
 * filtering entirely rather than materialising every id.
 */
export async function visibleServiceIdSet(db: DbLike, user: AuthedUser): Promise<Set<number> | null> {
  if (user.isOperator) return null;
  const set = new Set<number>();
  const owned = await db.select({ id: services.id }).from(services).where(eq(services.ownerUserId, user.id));
  for (const r of owned) set.add(r.id);
  const wsIds = await userWorkspaceIds(db, user.id);
  if (wsIds.length > 0) {
    const tagged = await db
      .select({ id: serviceWorkspaces.serviceId })
      .from(serviceWorkspaces)
      .where(inArray(serviceWorkspaces.workspaceId, wsIds));
    for (const r of tagged) set.add(r.id);
  }
  return set;
}

/**
 * The caller's effective role ON a service: the highest role they hold across
 * the workspaces the service is tagged into.
 *
 * Two fallbacks keep pre-workspace data working:
 *   • the service's `ownerUserId` always counts as `owner` (a personal service
 *     that was never tagged into a workspace stays fully manageable), and
 *   • instance operators are `owner` everywhere.
 *
 * `null` means the caller has no relationship to the service at all — callers
 * that reach this after `loadServiceForUser` can treat it as `viewer`.
 */
export async function serviceRole(
  db: DbLike,
  service: Pick<Service, 'id' | 'ownerUserId'>,
  user: AuthedUser,
): Promise<WorkspaceRole | null> {
  if (user.isOperator) return 'owner';
  if (service.ownerUserId === user.id) return 'owner';
  const tagWsIds = await serviceWorkspaceIds(db, service.id);
  if (tagWsIds.length === 0) return null;
  const seats = await db.query.workspaceMembers.findMany({
    where: and(eq(workspaceMembers.userId, user.id), inArray(workspaceMembers.workspaceId, tagWsIds)),
  });
  if (seats.length === 0) return null;
  return maxRole(seats.map((m) => ({ workspaceId: m.workspaceId, role: m.role as WorkspaceRole })));
}

/**
 * Throws 403 unless the caller holds `required` or higher on the service.
 *
 * This is the enforcement point for the role hierarchy that
 * `docs/WORKSPACES_RBAC.md` publishes. Before it existed, `assertWorkspaceRole`
 * and `roleAtLeast` had no call sites anywhere in the route layer, so a
 * `viewer` could create services, edit environment variables and trigger
 * deploys exactly like an `owner`.
 *
 * Convention used by the routes:
 *   • read      → `loadServiceForUser` alone (any seat, including viewer)
 *   • write     → `assertServiceRole(..., 'member')` — deploys, env, domains
 *   • destroy / → `assertServiceRole(..., 'admin')` — delete, transfer,
 *     re-tag                                          host-privileged edits
 */
export async function assertServiceRole(
  db: DbLike,
  service: Pick<Service, 'id' | 'ownerUserId'>,
  user: AuthedUser,
  required: WorkspaceRole,
): Promise<void> {
  const actual = await serviceRole(db, service, user);
  if (actual === null || !roleAtLeast(actual, required)) {
    throw forbidden(`This action requires the "${required}" role or higher on this service`);
  }
}

/** Throws 403 unless the user may manage a service row already in memory. */
export function assertCanManageService(
  svc: Pick<Service, 'ownerUserId' | 'id'>,
  user: AuthedUser,
): void {
  // Operators (owner/admin in any workspace) can manage every service. The
  // operator flag is computed once per request by the auth plugin, so this
  // check is a pure read.
  if (user.isOperator) return;
  if (svc.ownerUserId === user.id) return;
  // The cheap check is enough: the route already loaded the row through
  // `loadServiceForUser`, so the caller has proven access. This is for the
  // edge case where a row is passed in directly without going through the
  // loader (e.g. service-creation duplication check).
  if (svc.ownerUserId == null) return; // un-owned service — defer to the loader
  throw forbidden('You do not have access to this service');
}

// ── projects ───────────────────────────────────────────────────────────────

/**
 * Resolve a project the user may manage, else 404.
 *
 * Projects carry no owner column; the workspace they belong to is the unit of
 * access. An unscoped project (NULL `workspaceId`) is operator-only rather
 * than world-readable — the permissive reading is what allowed cross-tenant
 * env injection.
 */
export async function loadProjectForUser(db: DbLike, id: number, user: AuthedUser): Promise<Project> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!project) throw notFound('Project not found');
  // Use the flag already resolved for this request rather than re-reading the
  // column: `plugins/auth.ts` narrows it for scope-restricted API tokens, and a
  // fresh DB read here would silently undo that narrowing.
  if (user.isOperator) return project;
  if (project.workspaceId == null) throw notFound('Project not found');
  if (!(await isWorkspaceMember(db, project.workspaceId, user))) throw notFound('Project not found');
  return project;
}

/**
 * Drizzle predicate limiting a `projects` query to what the user may see, or
 * `null` when they may see nothing. Operators get `undefined` (no restriction).
 */
export async function projectScopeFilter(db: DbLike, user: AuthedUser) {
  if (user.isOperator) return undefined;
  const ids = await userWorkspaceIds(db, user.id);
  if (ids.length === 0) return null;
  return inArray(projects.workspaceId, ids);
}

// ── databases ──────────────────────────────────────────────────────────────

/**
 * Resolve a managed database the user may manage, else 404.
 *
 * `ownerUserId` is stamped at creation (see the runtime migration in
 * plugins/db.ts). Rows created before that column existed have a NULL owner
 * and fall back to the owning project's workspace; with neither, they are
 * operator-only.
 */
export async function loadDatabaseForUser(db: DbLike, id: number, user: AuthedUser): Promise<Database> {
  const row = await db.query.databases.findFirst({ where: eq(databases.id, id) });
  if (!row) throw notFound('Database not found');
  if (user.isOperator) return row;
  if (row.ownerUserId === user.id) return row;
  if (row.projectId != null) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, row.projectId) });
    if (project?.workspaceId != null && (await isWorkspaceMember(db, project.workspaceId, user))) {
      return row;
    }
  }
  throw notFound('Database not found');
}

/** Ids of every database the user may see. Operators are unrestricted (`null`). */
export async function visibleDatabaseIds(db: DbLike, user: AuthedUser): Promise<number[] | null> {
  if (user.isOperator) return null;
  const set = new Set<number>();

  // Direct ownership: db.select (not db.query) — SQL-only, no row materialisation.
  const owned = await db.select({ id: databases.id }).from(databases).where(eq(databases.ownerUserId, user.id));
  for (const r of owned) set.add(r.id);

  // Workspace path — must agree with `loadDatabaseForUser`, which resolves a
  // database through its PROJECT's workspace membership alone. (An earlier
  // revision joined via service→project tags instead, which HID a database
  // whose project simply had no service tagged yet while loadDatabaseForUser
  // still opened it by id — list and detail disagreed.)
  const wsIds = await userWorkspaceIds(db, user.id);
  if (wsIds.length > 0) {
    const tagged = await db
      .select({ id: databases.id })
      .from(databases)
      .innerJoin(projects, eq(databases.projectId, projects.id))
      .where(inArray(projects.workspaceId, wsIds));
    for (const r of tagged) if (r.id != null) set.add(r.id);
  }

  return Array.from(set);
}

/**
 * The caller's effective role ON a managed database.
 *
 * A database has no tag table of its own: its workspace is the one its PROJECT
 * belongs to. As with services, the row's `ownerUserId` and the instance
 * operator flag both count as `owner`, so a personal database created before
 * projects existed stays fully manageable by its creator.
 *
 * `null` = no relationship at all.
 */
export async function databaseRole(
  db: DbLike,
  row: Pick<Database, 'ownerUserId' | 'projectId'>,
  user: AuthedUser,
): Promise<WorkspaceRole | null> {
  if (user.isOperator) return 'owner';
  if (row.ownerUserId === user.id) return 'owner';
  if (row.projectId == null) return null;
  const project = await db.query.projects.findFirst({ where: eq(projects.id, row.projectId) });
  if (project?.workspaceId == null) return null;
  const seat = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, project.workspaceId),
      eq(workspaceMembers.userId, user.id),
    ),
  });
  return seat ? (seat.role as WorkspaceRole) : null;
}

/**
 * Throws 403 unless the caller holds `required` or higher on the database.
 *
 * Same convention as `assertServiceRole`:
 *   • read (list, detail, logs)          → `loadDatabaseForUser` alone
 *   • write (limits, start/stop/restart) → `member`
 *   • destroy / data (delete, backup,    → `admin`
 *     restore, credentials)
 *
 * Backups and credentials sit at `admin` deliberately: a backup is a full copy
 * of the data and the credentials reveal the password, so neither belongs to
 * the same tier as "restart the container".
 */
export async function assertDatabaseRole(
  db: DbLike,
  row: Pick<Database, 'ownerUserId' | 'projectId'>,
  user: AuthedUser,
  required: WorkspaceRole,
): Promise<void> {
  const actual = await databaseRole(db, row, user);
  if (actual === null || !roleAtLeast(actual, required)) {
    throw forbidden(`This action requires the "${required}" role or higher on this database`);
  }
}

// ── generic dispatcher ─────────────────────────────────────────────────────

/**
 * Kind-dispatched loader. Prefer the concrete `load*ForUser` functions where
 * the row type matters; this exists for the `requireAccess` prehandler and for
 * call sites that only need the authorization decision.
 */
export async function requireResourceAccess(
  db: DbLike,
  kind: ResourceKind,
  id: number,
  user: AuthedUser,
): Promise<Service | Project | Database> {
  switch (kind) {
    case 'service':
      return loadServiceForUser(db, id, user);
    case 'project':
      return loadProjectForUser(db, id, user);
    case 'database':
      return loadDatabaseForUser(db, id, user);
  }
}

/**
 * Route-level prehandler factory: declares the access decision next to the
 * route instead of relying on each handler to remember it.
 *
 *   app.delete('/:id', { preHandler: [requireAccess('database')] }, handler)
 *
 * Runs after `authenticate` (which populates `req.user`).
 */
export function requireAccess(kind: ResourceKind, param = 'id') {
  return async function accessPreHandler(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const raw = (req.params as Record<string, string>)[param];
    if (raw === undefined) throw notFound('Resource not found');
    const db = (req.server as unknown as { db: DB }).db;
    await requireResourceAccess(db, kind, parseId(raw), req.user!);
  };
}

// Re-exported so call sites can compose without importing drizzle directly.
export { or };
export const _internal = { workspaces, workspaceMembers, serviceProjects, serviceWorkspaces };
