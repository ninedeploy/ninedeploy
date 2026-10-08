import type { FastifyPluginAsync } from 'fastify';

/**
 * Project- and environment-level access grants (0.15, raise-only — owner
 * decision O5).
 *
 * Design: .temp_files/run_0.15/DESIGN.md §4.4. Owner: task T5. Contract:
 * `@ninedeploy/schemas` accessGrants.ts.
 *
 * T1 stubs, registered in `modules/api.ts` (mount point M1) with no routes
 * yet, so every guard stays green until T5 fills them. Each route needs its
 * authzMatrix entry (block `0.15 T5 access grants`) and its ROUTE_SPECS entry
 * (`src/openapi/specs/accessGrants.ts`). None gets a PREFIX_SCOPES entry, so
 * fine-grained tokens are refused, as for every other workspace route.
 */

/** `/v1/workspaces/:wid/access-grants` CRUD (workspace admin; operators pass). */
export const accessGrantRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T5.
};

/** `GET /v1/projects/:id/access` (project admin): who reaches the project, and how. */
export const projectAccessRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T5.
};

/** `GET /v1/access/me` (self): the caller's own grants and guest workspaces. */
export const accessMeRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T5.
};
