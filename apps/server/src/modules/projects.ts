import { and, asc, eq, inArray } from 'drizzle-orm';
import { databases, projects, serviceProjects, type Project, workspaces, type Workspace } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createProject, projectPatch } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { assertWorkspaceMember, assertWorkspaceRole, loadProjectForUser, projectScopeFilter } from '../lib/resourceAccess.js';
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
    void audit(app.db, req.user!.id, 'project.update', updated.name);
    return serialize(updated);
  });

  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const row = await loadProjectForUser(app.db, id, req.user!);
    if (!req.user!.isOperator && row.workspaceId != null) {
      await assertWorkspaceRole(app.db, row.workspaceId, req.user!, 'admin');
    }
    await app.db.delete(projects).where(eq(projects.id, id));
    void audit(app.db, req.user!.id, 'project.delete', row.name);
    return { ok: true };
  });
};

/**
 * For a service-tag write: return the subset of `ids` the caller is allowed
 * to assign (i.e. projects they can see). Operators see every requested id
 * (we still verify the rows exist). Returns an empty array when none match.
 */
export async function visibleProjectIds(
  db: import('@ninedeploy/db').DB,
  user: { id: number; isOperator: boolean },
  ids: number[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.query.projects.findMany({
    where: (p, { inArray: inOp }) => inOp(p.id, ids),
  });
  if (user.isOperator) return rows.map((r) => r.id);
  const ms = await db.query.workspaceMembers.findMany({
    where: (m, { eq: eqOp }) => eqOp(m.userId, user.id),
  });
  const wsIds = new Set(ms.map((m) => m.workspaceId));
  return rows
    .filter((r) => r.workspaceId != null && wsIds.has(r.workspaceId))
    .map((r) => r.id);
}
