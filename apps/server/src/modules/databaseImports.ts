import type { FastifyPluginAsync } from 'fastify';

/**
 * Database dump import (0.14): chunked, resumable uploads and S3 sources under
 * `/v1/databases/:id/imports`.
 *
 * Design: .temp_files/run_0.14/DESIGN.md §3.3. Owner: task T4.
 *
 * T1 stub: registered in `modules/api.ts` under `/databases` (mount point M1)
 * with no routes yet, so every guard stays green until T4 fills it. Each route
 * T4 adds needs its authzMatrix entry (block `0.14 T4 database import`).
 */
export const databaseImportRoutes: FastifyPluginAsync = async (_app) => {
  // Routes land in T4.
};
