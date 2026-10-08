import type { FastifyPluginAsync } from 'fastify';

/**
 * Secret managers (0.14): HashiCorp Vault / OpenBao (KV v2) and AWS Secrets
 * Manager under `/v1/settings/secret-providers`. Operator only; the existing
 * `settings` token scope applies to the prefix.
 *
 * Design: .temp_files/run_0.14/DESIGN.md §4.2. Owner: task T5.
 *
 * T1 stub: registered in `modules/api.ts` under `/settings/secret-providers`
 * (mount point M1) with no routes yet. Each route T5 adds needs its
 * authzMatrix entry (block `0.14 T5 secret providers`);
 * `POST /:kind/test` also needs its auditCoverage exemption uncommented.
 */
export const secretProviderRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T5.
};
