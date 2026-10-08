import type { FastifyPluginAsync } from 'fastify';

/**
 * Traffic analytics (0.15, opt-in everywhere — owner decision O3).
 *
 * Design: .temp_files/run_0.15/DESIGN.md §2.4. Owner: task T3. Contract:
 * `@ninedeploy/schemas` traffic.ts.
 *
 * T1 stubs, registered in `modules/api.ts` (mount point M1) with no routes
 * yet, so every guard stays green until T3 fills them. Each route needs its
 * authzMatrix entry (block `0.15 T3 traffic`) and its ROUTE_SPECS entry
 * (`src/openapi/specs/traffic.ts`).
 */

/**
 * Instance-wide routes under `/v1/traffic` (operator only, no PREFIX_SCOPES
 * entry): `GET/PUT /settings` and `GET /summary`.
 */
export const trafficRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T3.
};

/**
 * Per-service route `GET /v1/services/:id/traffic` (any seat on the service),
 * registered under `/services` so it inherits the `services` read scope.
 */
export const serviceTrafficRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T3.
};
