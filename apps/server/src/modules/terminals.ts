import type { FastifyPluginAsync } from 'fastify';

/**
 * Terminals (0.15): interactive shells into a service replica, a managed
 * database, any managed container or (off by default, owner decision O1) a
 * server host, under `/v1/terminals`: create a session (single-use ticket),
 * attach over a WebSocket (protocol v1), list, inspect, terminate, settings.
 *
 * Design: .temp_files/run_0.15/DESIGN.md §1.6. Owner: task T2a (node targets:
 * T2b). Contract: `@ninedeploy/schemas` terminals.ts.
 *
 * T1 stub: registered in `modules/api.ts` under `/terminals` (mount point M1)
 * with no routes yet, so every guard stays green until T2a fills it. Each
 * route needs its authzMatrix entry (block `0.15 T2a terminals`) and its
 * ROUTE_SPECS entry (`src/openapi/specs/terminals.ts`). Every route is
 * operator-only (`onRequest: authenticate`, `preHandler: requireOperator`) and
 * gets no PREFIX_SCOPES entry, so fine-grained tokens are refused.
 */
export const terminalRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T2a.
};
