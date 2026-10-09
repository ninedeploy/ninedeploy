import type { FastifyPluginAsync } from 'fastify';

/**
 * Swarm (multi-node, opt-in per service, sequenced last — owner decision O4).
 *
 * Design: .temp_files/run_0.16/DESIGN.md §7.2, §7.5. Owner: task T7.
 * Contract: `@ninedeploy/schemas` multiNode.ts (`swarmInit`, `swarmSettings`,
 * `swarmStatus`).
 *
 * T1 stubs, registered in `modules/api.ts` (mount point M1) with no routes
 * yet, so every guard stays green until T7 fills them. Each route needs its
 * authzMatrix entry (block `0.16 T7 swarm`), its ROUTE_SPECS entry
 * (`src/openapi/specs/multiNode.ts`, block T7) and an `audit()` call on every
 * mutation.
 */

/**
 * Instance-wide routes under `/v1/swarm` (operator only, no PREFIX_SCOPES
 * entry): `GET /`, `POST /init` (interactive + step-up) and `PUT /settings`.
 */
export const swarmRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T7.
};

/**
 * Per-node routes under `/v1/servers` (operator only):
 * `POST /:id/swarm/join` and `POST /:id/swarm/leave`.
 */
export const serverSwarmRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T7.
};
