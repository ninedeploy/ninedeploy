import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { environments, services, workspaceMembers } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { assertWorkspaceRole } from '../lib/resourceAccess.js';
import { badRequest, notFound, parseId } from '../lib/errors.js';

/**
 * Environments — named deployment lanes (production / staging / development)
 * inside a workspace. Services opt in via `services.environment_id`; the
 * promote flow builds on this grouping.
 *
 * RBAC mirrors projects and labels: reads need any seat in the workspace,
 * writes need `member`, deletion needs `admin` (detaching every service in
 * a lane is a structural change).
 */

const environmentCreate = z.object({
  workspaceId: z.number().int().positive(),
  name: z.string().min(1).max(80),
});

const environmentPatch = z.object({
  name: z.string().min(1).max(80).optional(),
});

function serialize(row: typeof environments.$inferSelect, serviceCount: number) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    serviceCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const environmentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // List environments (with live service counts) across the caller's
  // workspaces. Operators see the whole instance.
  app.get('/', async (req) => {
    const user = req.user!;
    const memberships = await app.db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, user.id),
    });
    const wsIds = new Set(memberships.map((m) => m.workspaceId));
    const all = await app.db.query.environments.findMany({ orderBy: [asc(environments.name)] });
    const visible = user.isOperator ? all : all.filter((e) => e.workspaceId != null && wsIds.has(e.workspaceId));
    const counts = new Map<number, number>();
    for (const s of await app.db.select({ id: services.id, environmentId: services.environmentId }).from(services)) {
      if (s.environmentId != null) counts.set(s.environmentId, (counts.get(s.environmentId) ?? 0) + 1);
    }
    return visible.map((e) => serialize(e, counts.get(e.id) ?? 0));
  });

  // Create an environment in a workspace (member floor — a viewer seat
  // stays read-only).
  app.post('/', async (req) => {
    const input = environmentCreate.parse(req.body);
    const user = req.user!;
    await assertWorkspaceRole(app.db, input.workspaceId, user, 'member');
    const slug =
      input.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'env';
    let row: typeof environments.$inferSelect | undefined;
    try {
      [row] = await app.db
        .insert(environments)
        .values({ workspaceId: input.workspaceId, name: input.name.trim(), slug })
        .returning();
    } catch (err) {
      // The (workspace_id, name) unique index is the race backstop for
      // concurrent creates — translate it into the same clean response the
      // pre-check would produce.
      if (err instanceof Error && /UNIQUE.*environments_workspace_name/i.test(err.message)) {
        throw badRequest('An environment with this name already exists in the workspace');
      }
      throw err;
    }
    if (!row) throw badRequest('Could not create environment');
    void audit(app.db, user.id, 'environment.create', `${row.name} (ws ${input.workspaceId})`);
    return serialize(row, 0);
  });

  // Rename an environment (member floor on its workspace).
  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = environmentPatch.parse(req.body);
    const user = req.user!;
    const row = await app.db.query.environments.findFirst({ where: eq(environments.id, id) });
    if (!row) throw notFound('Environment not found');
    await assertWorkspaceRole(app.db, row.workspaceId, user, 'member');
    const [updated] = await app.db
      .update(environments)
      .set({ ...(input.name != null ? { name: input.name.trim() } : {}), updatedAt: new Date() })
      .where(eq(environments.id, id))
      .returning();
    if (!updated) throw badRequest('Could not update environment');
    void audit(app.db, user.id, 'environment.update', updated.name);
    return serialize(updated, 0);
  });

  // Delete an environment. Services in the lane survive, detached
  // (environment_id SET NULL) — deleting a lane must never delete apps.
  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const user = req.user!;
    const row = await app.db.query.environments.findFirst({ where: eq(environments.id, id) });
    if (!row) throw notFound('Environment not found');
    await assertWorkspaceRole(app.db, row.workspaceId, user, 'admin');
    await app.db.delete(environments).where(eq(environments.id, id));
    void audit(app.db, user.id, 'environment.delete', row.name);
    return { ok: true };
  });
};
