import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  databases,
  type DB,
  envVars,
  projects,
  serviceProjects,
  type Project,
  workspaces,
  type Workspace,
} from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createProject, projectPatch, type WorkspaceRole } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { deleteGrantsForProject, grantsForUser, projectGrantRole } from '../lib/accessGrants.js';
import {
  assertWorkspaceMember,
  assertWorkspaceRole,
  loadProjectForUser,
  projectScopeFilter,
  roleAtLeast,
} from '../lib/resourceAccess.js';
import { badRequest, conflict, parseId } from '../lib/errors.js';
import { iso } from '../lib/serialize.js';
import { slugify } from '../lib/slug.js';

function serialize(
  p: Project,
  counts?: { services: number; databases: number },
  workspaceName?: string | null,
) {
  return {
    id: p.id,
    workspaceId: p.workspaceId ?? null,
    workspaceName: workspaceName ?? null,
    name: p.name,
    slug: p.slug,
    description: p.description,
    serviceCount: counts?.services ?? 0,
    databaseCount: counts?.databases ?? 0,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

/**
 * Project CRUD. Deleting a project only detaches its resources (FK is
 * ON DELETE SET NULL) — services and databases survive, ungrouped.
 */
export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const query = req.query as { workspaceId?: string };
    const workspaceId = query?.workspaceId;
    const numWorkspaceId = workspaceId ? parseInt(workspaceId, 10) : undefined;
    // The caller-supplied ?workspaceId= narrows the view; it must never widen
    // it, so the membership filter is ANDed on top rather than replaced.
    // `null` means the member belongs to no workspace and can see nothing.
    const scope = await projectScopeFilter(app.db, req.user!);
    if (scope === null) return [];
    const filters = [
      ...(numWorkspaceId ? [eq(projects.workspaceId, numWorkspaceId)] : []),
      ...(scope ? [scope] : []),
    ];
    const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
    const rows = await app.db.query.projects.findMany({ where, orderBy: [asc(projects.name)] });
    // Resolve workspace display names in one shot.
    const wsIds = Array.from(new Set(rows.map((r) => r.workspaceId).filter((id): id is number => id != null)));
    const wsRows: Workspace[] = wsIds.length > 0
      ? await app.db.query.workspaces.findMany({ where: inArray(workspaces.id, wsIds) })
      : [];
    const wsNameById = new Map(wsRows.map((w) => [w.id, w.name]));
    // Count resource membership in JS: projects are few, and a GROUP BY here
    // would still scan the same rows on SQLite at self-hosted scale.
    const svcRows = await app.db.select({ projectId: serviceProjects.projectId }).from(serviceProjects);
    const dbRows = await app.db.select({ projectId: databases.projectId }).from(databases);
    const count = (list: Array<{ projectId: number | null }>) => {
      const m = new Map<number, number>();
      for (const r of list) if (r.projectId != null) m.set(r.projectId, (m.get(r.projectId) ?? 0) + 1);
      return m;
    };
    const svcMap = count(svcRows);
    const dbMap = count(dbRows);
    return rows.map((p) =>
      serialize(
        p,
        { services: svcMap.get(p.id) ?? 0, databases: dbMap.get(p.id) ?? 0 },
        p.workspaceId == null ? null : wsNameById.get(p.workspaceId) ?? null,
      ),
    );
  });

  app.post('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const input = createProject.parse(req.body);
    // A project may only be created inside a workspace the caller belongs to —
    // otherwise a member could plant a project (and its shared env) in someone
    // else's workspace. Any seat is NOT enough: creating is a write, so the
    // floor is `member` and a viewer seat stays read-only.
    if (input.workspaceId != null) await assertWorkspaceRole(app.db, input.workspaceId, req.user!, 'member');
    // F608: a project outside every workspace is operator-only (see the detach
    // rule in PATCH): any other caller could not even see it, yet it would
    // squat its globally unique slug for every tenant.
    else if (!req.user!.isOperator) throw badRequest('Only an operator can create a project outside a workspace');
    const slug = input.slug ?? slugify(input.name);
    const exists = await app.db.query.projects.findFirst({ where: eq(projects.slug, slug) });
    if (exists) throw conflict(`Project slug "${slug}" is already taken`);
    const [row] = await app.db
      .insert(projects)
      .values({ name: input.name, slug, description: input.description, workspaceId: input.workspaceId ?? null })
      .returning();
    if (!row) throw badRequest('Could not create project');
    void audit(app.db, req.user!.id, 'project.create', row.name);
    return serialize(row);
  });

  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = projectPatch.parse(req.body);
    const project = await loadProjectForUser(app.db, id, req.user!);
    // Project names, membership, and deletion affect every linked service;
    // viewers remain read-only even though they can discover the project.
    if (!req.user!.isOperator && project.workspaceId != null) {
      await assertWorkspaceRole(app.db, project.workspaceId, req.user!, 'admin');
    }
    // Re-homing a project is a membership change on both ends: the caller must
    // belong to the destination too, or they could move a project they can see
    // into a workspace only they control.
    if (input.workspaceId != null) {
      if (req.user!.isOperator) {
        await assertWorkspaceMember(app.db, input.workspaceId, req.user!);
      } else {
        await assertWorkspaceRole(app.db, input.workspaceId, req.user!, 'admin');
      }
    }
    // Detaching a project (workspaceId: null) makes it admin-only under the
    // access rules, so only an admin may do it.
    if (input.workspaceId === null && !req.user!.isOperator) {
      throw badRequest('Only an operator can detach a project from its workspace');
    }
    const [updated] = await app.db
      .update(projects)
      .set({
        ...(input.name != null && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.workspaceId !== undefined && { workspaceId: input.workspaceId }),
      })
      .where(eq(projects.id, id))
      .returning();
    if (!updated) throw badRequest('Could not update project');
    // 0.15 (M23): access grants on a project belong to the workspace that
    // issued them. A moved project already stops matching them (the grant
    // resolver joins on the project's current workspace); drop them too.
    if (input.workspaceId !== undefined && input.workspaceId !== project.workspaceId) {
      await deleteGrantsForProject(app.db, id, req.user!.id);
    }
    void audit(app.db, req.user!.id, 'project.update', updated.name);
    return serialize(updated);
  });

  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const row = await loadProjectForUser(app.db, id, req.user!);
    if (!req.user!.isOperator && row.workspaceId != null) {
      await assertWorkspaceRole(app.db, row.workspaceId, req.user!, 'admin');
    }
    // F609: a database belongs to a workspace only through its project. The
    // FK's SET NULL would take it out of the workspace and leave it to its
    // creator alone (r694 personal fallback), beyond the reach of the team
    // and of seat-loss hand-over, so refuse while any is still filed here.
    await app.db.transaction(async (tx) => {
      if (row.workspaceId != null) {
        const filed = await tx.query.databases.findFirst({ where: eq(databases.projectId, id) });
        if (filed) throw conflict(`Project "${row.name}" still holds databases; delete them before deleting the project`);
      }
      await purgeProjectEnvVars(tx, [id]);
      await tx.delete(projects).where(eq(projects.id, id));
    });
    void audit(app.db, req.user!.id, 'project.delete', row.name);
    return { ok: true };
  });
};

/**
 * r541: delete the shared env vars (secrets included) of projects that are
 * about to go. `env_vars` rows with scope='project' name their project only
 * through `scope_key` — there is no foreign key to cascade them — so every
 * path that deletes a project (directly, or through its workspace's cascade)
 * must call this first, or the encrypted values outlive the project forever.
 */
export async function purgeProjectEnvVars(db: Pick<DB, 'delete'>, projectIds: number[]): Promise<void> {
  if (projectIds.length === 0) return;
  await db.delete(envVars).where(and(eq(envVars.scope, 'project'), inArray(envVars.scopeKey, projectIds)));
}

/**
 * Return the subset of `ids` the caller holds at least `minRole` on (via the
 * project's workspace). Operators get every requested id (we still verify the
 * rows exist). Returns an empty array when none match.
 *
 * Tag WRITES must pass `member` (r095): tagging a service into a project makes
 * the pipeline decrypt that project's shared env — secrets included — into the
 * service's container, so a read-only `viewer` seat must not be enough.
 */
export async function visibleProjectIds(
  db: import('@ninedeploy/db').DB,
  user: { id: number; isOperator: boolean },
  ids: number[],
  minRole: WorkspaceRole = 'viewer',
): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.query.projects.findMany({
    where: (p, { inArray: inOp }) => inOp(p.id, ids),
  });
  if (user.isOperator) return rows.map((r) => r.id);
  const ms = await db.query.workspaceMembers.findMany({
    where: (m, { eq: eqOp }) => eqOp(m.userId, user.id),
  });
  const wsIds = new Set(ms.filter((m) => roleAtLeast(m.role, minRole)).map((m) => m.workspaceId));
  // 0.15: max(seat, project grant) ≥ minRole — a project grant of that role
  // counts like a seat of it (grants only raise; DESIGN §4.2).
  const grants = await grantsForUser(db, user.id);
  const grantOk = (projectId: number) => {
    const role = projectGrantRole(grants, projectId);
    return role !== null && roleAtLeast(role, minRole);
  };
  return rows
    .filter((r) => r.workspaceId != null && (wsIds.has(r.workspaceId) || grantOk(r.id)))
    .map((r) => r.id);
}
