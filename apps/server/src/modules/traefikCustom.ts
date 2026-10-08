import type { FastifyPluginAsync } from 'fastify';

/**
 * Proxy management (0.14): the operator's custom Traefik dynamic config
 * (`/v1/traefik/custom-config`) and custom TLS certificates
 * (`/v1/traefik/certificates/custom`). Operator only, no PREFIX_SCOPES entry.
 *
 * Design: .temp_files/run_0.14/DESIGN.md §2.5. Owner: task T2.
 *
 * T1 stub: registered in `modules/api.ts` under `/traefik` (mount point M1)
 * with no routes yet. `traefikRoutes` is mounted with an empty prefix and
 * owns `/traefik`, `/traefik/status`, `/traefik/certificates`, … ; the paths
 * planned here (`/custom-config*`, `/certificates/custom*`) do not collide
 * with any of them. Each route T2 adds needs its authzMatrix entry (block
 * `0.14 T2 proxy management`); `POST /custom-config/validate` also needs its
 * auditCoverage exemption uncommented.
 */
export const traefikCustomRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T2.
};
