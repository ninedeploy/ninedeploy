import type { FastifyPluginAsync } from 'fastify';

/**
 * Image transfer history: one `image_transfers` row per image shipped to a
 * host (multi-node). Read-only.
 *
 * Design: .temp_files/run_0.16/DESIGN.md §6.6. Owner: task T4.
 * Contract: `@ninedeploy/schemas` multiNode.ts (`imageTransfer`,
 * `imageTransfersQuery`).
 *
 * T1 stubs, registered in `modules/api.ts` (mount point M1) with no routes
 * yet. Each route needs its authzMatrix entry (block `0.16 T4 build
 * placement`) and its ROUTE_SPECS entry (`src/openapi/specs/multiNode.ts`).
 */

/** `GET /v1/services/:id/image-transfers` (viewer), under `/services`. */
export const imageTransferRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T4.
};

/** `GET /v1/deployments/:id/image-transfers` (viewer), under `/deployments`. */
export const deploymentTransferRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T4.
};
