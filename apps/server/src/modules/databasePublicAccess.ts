import type { FastifyPluginAsync } from 'fastify';

/**
 * Public database access (0.14): `GET|PUT|DELETE /v1/databases/:id/public-access`.
 * A per-database Traefik TCP sidecar (`nd-dbpub-<slug>`) publishing one host
 * port behind a required IP allow-list.
 *
 * Design: .temp_files/run_0.14/DESIGN.md §1.2. Owner: task T3.
 *
 * T1 stub: registered in `modules/api.ts` under `/databases` (mount point M1)
 * with no routes yet, so every guard stays green until T3 fills it. Each route
 * T3 adds needs its authzMatrix entry (block `0.14 T3 public access`).
 */
export const databasePublicAccessRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T3.
};
