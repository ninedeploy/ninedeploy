import type { FastifyPluginAsync } from 'fastify';

/**
 * Service placement: where a service's image is built, how it travels, and
 * which orchestrator runs it (multi-node).
 *
 * Design: .temp_files/run_0.16/DESIGN.md §6.6, §7.5. Owner: task T4 (the
 * `orchestrator` field is validated with T7's Swarm rules).
 * Contract: `@ninedeploy/schemas` multiNode.ts (`servicePlacement`,
 * `servicePlacementView`).
 *
 * T1 stub, registered in `modules/api.ts` under `/services` (mount point M1)
 * with no routes yet, so it inherits the `services` scope. `GET` (viewer) and
 * `PUT` (operator) `/v1/services/:id/placement` land in T4, each with its
 * authzMatrix and ROUTE_SPECS entry; the PUT audits `service.placement.update`.
 */
export const servicePlacementRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T4.
};
