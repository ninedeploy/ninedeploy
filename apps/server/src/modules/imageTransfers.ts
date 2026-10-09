import { desc, eq } from 'drizzle-orm';
import { deployments, imageTransfers } from '@ninedeploy/db';
import { type ImageTransfer, imageTransfersQuery, IMAGE_TRANSFERS_LIMIT_MAX } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { notFound, parseId } from '../lib/errors.js';
import { loadServiceForUser } from '../lib/resourceAccess.js';

/**
 * Image transfer history: one `image_transfers` row per image shipped to a
 * host (multi-node, design §6.3, §6.6). Read-only, visible to anyone who can
 * see the service (`viewer`, design §6.4). A NULL server is the panel host.
 * Rows are swept by the `image-transfers` housekeeping step.
 */

type Row = typeof imageTransfers.$inferSelect;

export function serializeImageTransfer(r: Row): ImageTransfer {
  return {
    id: r.id,
    deploymentId: r.deploymentId ?? null,
    serviceId: r.serviceId,
    sourceServerId: r.sourceServerId ?? null,
    targetServerId: r.targetServerId ?? null,
    method: r.method,
    imageRef: r.imageRef,
    imageId: r.imageId ?? null,
    bytes: r.bytes,
    sha256: r.sha256 ?? null,
    status: r.status,
    error: r.error ?? null,
    startedAt: (r.startedAt ?? new Date(0)).toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    durationMs: r.durationMs ?? null,
  };
}

/** `GET /v1/services/:id/image-transfers` (viewer), under `/services`. */
export const imageTransferRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/image-transfers', { onRequest: [app.authenticate] }, async (req): Promise<ImageTransfer[]> => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    const { limit } = imageTransfersQuery.parse(req.query ?? {});
    const rows = await app.db.query.imageTransfers.findMany({
      where: eq(imageTransfers.serviceId, svc.id),
      orderBy: [desc(imageTransfers.id)],
      limit,
    });
    return rows.map(serializeImageTransfer);
  });
};

/** `GET /v1/deployments/:id/image-transfers` (viewer), under `/deployments`. */
export const deploymentTransferRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/image-transfers', { onRequest: [app.authenticate] }, async (req): Promise<ImageTransfer[]> => {
    const id = parseId((req.params as { id: string }).id);
    const dep = await app.db.query.deployments.findFirst({ where: eq(deployments.id, id) });
    if (!dep) throw notFound('Deployment not found');
    // 404 (not 403) for a deployment of a service the caller cannot see.
    await loadServiceForUser(app.db, dep.serviceId, req.user!).catch(() => {
      throw notFound('Deployment not found');
    });
    const rows = await app.db.query.imageTransfers.findMany({
      where: eq(imageTransfers.deploymentId, dep.id),
      orderBy: [desc(imageTransfers.id)],
      limit: IMAGE_TRANSFERS_LIMIT_MAX,
    });
    return rows.map(serializeImageTransfer);
  });
};
