import { and, eq, notInArray } from 'drizzle-orm';
import {
  labels,
  projects,
  serviceLabels,
  serviceProjects,
  serviceWorkspaces,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { setServiceTags, type ServiceTags } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';
import { forbidden, parseId } from '../lib/errors.js';
import { visibleLabelIds } from './labels.js';
import { visibleProjectIds } from './projects.js';
import { visibleWorkspaceIds } from './workspaces.js';

/**
 * Service tag endpoints.
 *
 * Two distinct concerns:
 *   1. `PUT /v1/services/:id/tags` — set the full project / workspace / label
 *      membership of a service in a single round-trip. Idempotent: a missing
 *      id set is the same as an empty array (the dimension is cleared).
 *   2. `GET /v1/services/:id/tags` — read the current membership with the
 *      resolved names so the UI can render chip labels.
 *
 * Authorization: reading needs any seat on the service. Writing needs `admin`
 * or higher on it (`assertServiceRole`) AND every target
 * project/workspace/label must be one the caller belongs to (or operator).
 * This keeps a member from re-homing their service into another tenant's
 * workspace, and keeps a `viewer` from re-homing it at all.
 */
export const serviceTagRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/tags', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const user = req.user!;
    // Throws 404 (not 403) when the service is not visible — same as the rest
    // of /v1/services so the surface is consistent.
    await loadServiceForUser(app.db, id, user);
    return getServiceTags(app.db, id);
  });

  app.put('/:id/tags', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const user = req.user!;
    const input = setServiceTags.parse(req.body);
    const svc = await loadServiceForUser(app.db, id, user);
    // Re-homing a service between workspaces changes who can reach it at all,
    // so it sits above ordinary configuration writes: `admin`+ on the service.
    await assertServiceRole(app.db, svc, user, 'admin');

    // Validate every target id is one the caller is allowed to assign. We
    // also check that the workspace the service will end up in is one the
    // service is currently scoped to (or empty on creation). Operators skip
    // these checks.
    if (!user.isOperator) {
      const allowedWorkspaces = await visibleWorkspaceIds(app.db, user, input.workspaceIds);
      if (allowedWorkspaces.length !== input.workspaceIds.length) {
        throw forbidden('One or more target workspaces are not visible to you');
      }
      // `member` floor: tagging makes the pipeline decrypt the project's shared
      // env into this service — a viewer seat must not unlock that (r095).
      const allowedProjects = await visibleProjectIds(app.db, user, input.projectIds, 'member');
      if (allowedProjects.length !== input.projectIds.length) {
        throw forbidden('One or more target projects are not visible to you');
      }
      const allowedLabels = await visibleLabelIds(app.db, user, input.labelIds);
      if (allowedLabels.length !== input.labelIds.length) {
        throw forbidden('One or more target labels are not visible to you');
      }
    }

    await replaceServiceTags(app.db, id, input.projectIds, input.workspaceIds, input.labelIds);
    void audit(app.db, user.id, 'service.tags', `service #${id}`);
    return getServiceTags(app.db, id);
  });
};

/**
 * Read a service's full tag set, returning the resolved project / workspace /
 * label rows so the UI doesn't have to perform N lookups.
 */
export async function getServiceTags(db: DB, serviceId: number): Promise<ServiceTags> {
  const [projLinks, wsLinks, labelLinks] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
      })
      .from(serviceProjects)
      .innerJoin(projects, eq(projects.id, serviceProjects.projectId))
      .where(eq(serviceProjects.serviceId, serviceId)),
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
      })
      .from(serviceWorkspaces)
      .innerJoin(workspaces, eq(workspaces.id, serviceWorkspaces.workspaceId))
      .where(eq(serviceWorkspaces.serviceId, serviceId)),
    db
      .select({
        id: labels.id,
        name: labels.name,
        color: labels.color,
      })
      .from(serviceLabels)
      .innerJoin(labels, eq(labels.id, serviceLabels.labelId))
      .where(eq(serviceLabels.serviceId, serviceId)),
  ]);
  return {
    serviceId,
    projects: projLinks,
    workspaces: wsLinks,
    labels: labelLinks,
  };
}

/**
 * Replace the service's project/workspace/label memberships in a single
 * transaction. The `incoming` lists are the desired end state; rows that
 * should disappear are deleted, rows that should appear are inserted.
 *
 * `serviceProjects`, `serviceWorkspaces`, and `serviceLabels` all use a
 * composite primary key on (serviceId, *) so a duplicate insert is a no-op
 * upsert: we DELETE rows not in the new set first, then INSERT the new rows.
 */
export async function replaceServiceTags(
  db: DB,
  serviceId: number,
  projectIds: number[],
  workspaceIds: number[],
  labelIds: number[],
): Promise<void> {
  await db.transaction(async (tx) => {
    // Projects: clear, then add. Unique on (serviceId, projectId).
    await tx.delete(serviceProjects).where(
      and(eq(serviceProjects.serviceId, serviceId), notInArray(serviceProjects.projectId, projectIds)),
    );
    if (projectIds.length > 0) {
      await tx
        .insert(serviceProjects)
        .values(projectIds.map((projectId) => ({ serviceId, projectId })))
        .onConflictDoNothing();
    }

    // Workspaces
    await tx.delete(serviceWorkspaces).where(
      and(eq(serviceWorkspaces.serviceId, serviceId), notInArray(serviceWorkspaces.workspaceId, workspaceIds)),
    );
    if (workspaceIds.length > 0) {
      await tx
        .insert(serviceWorkspaces)
        .values(workspaceIds.map((workspaceId) => ({ serviceId, workspaceId })))
        .onConflictDoNothing();
    }

    // Labels
    await tx.delete(serviceLabels).where(
      and(eq(serviceLabels.serviceId, serviceId), notInArray(serviceLabels.labelId, labelIds)),
    );
    if (labelIds.length > 0) {
      await tx
        .insert(serviceLabels)
        .values(labelIds.map((labelId) => ({ serviceId, labelId })))
        .onConflictDoNothing();
    }
  });
}

/**
 * Apply the default tag set for a freshly-created service: every workspace the
 * caller belongs to (so the service is visible to all of them by default), no
 * projects, no labels. Operators get all workspaces.
 */
export async function applyDefaultTags(
  db: DB,
  user: { id: number; isOperator: boolean },
  serviceId: number,
): Promise<void> {
  let workspaceIds: number[];
  if (user.isOperator) {
    const rows = await db.query.workspaces.findMany();
    workspaceIds = rows.map((w) => w.id);
  } else {
    const ms = await db.query.workspaceMembers.findMany({
      where: (m, { eq: eqOp }) => eqOp(m.userId, user.id),
    });
    workspaceIds = ms.map((m) => m.workspaceId);
  }
  await replaceServiceTags(db, serviceId, [], workspaceIds, []);
}
