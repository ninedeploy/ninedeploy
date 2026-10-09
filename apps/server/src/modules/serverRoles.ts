import type { FastifyPluginAsync } from 'fastify';

/**
 * Server roles: the build-server flag and its concurrency (multi-node).
 *
 * Design: .temp_files/run_0.16/DESIGN.md §6.2, §6.6. Owner: task T4.
 * Contract: `@ninedeploy/schemas` multiNode.ts (`serverRoles`).
 *
 * T1 stub, registered in `modules/api.ts` under `/servers` (mount point M1)
 * with no routes yet. `PATCH /v1/servers/:id` (operator) lands in T4 with its
 * authzMatrix entry (block `0.16 T4 build placement`), its ROUTE_SPECS entry
 * (`src/openapi/specs/multiNode.ts`, block T4) and `audit('server.roles.update')`.
 */
export const serverRolesRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T4.
};
