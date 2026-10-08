import type { FastifyPluginAsync } from 'fastify';

/**
 * The OpenAPI 3.1 document (0.15): `GET /v1/openapi.json`, built lazily from
 * the live route table (`app.routeRegistry`) and `ROUTE_SPECS`, memoized, with
 * an ETag. Behind login (owner decision O4): any session or a coarse or
 * unrestricted token; no PREFIX_SCOPES entry, so fine-grained tokens are
 * refused.
 *
 * Design: .temp_files/run_0.15/DESIGN.md §3.1. Owner: task T4.
 *
 * T1 stub: registered in `modules/api.ts` with no prefix (mount point M1), so
 * its one route lands at `/v1/openapi.json`. No route yet, so every guard
 * stays green until T4 fills it (authzMatrix block `0.15 T4 openapi`).
 */
export const openapiRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T4.
};
