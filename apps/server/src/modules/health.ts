import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { VERSION } from '../version.js';

/** Liveness + readiness. `GET /health` also pings the database; a failed ping
 * answers 503 (not 200-with-"degraded") so probes gate on real readiness —
 * the Docker HEALTHCHECK, the installer's readiness gate and orchestrators
 * (compose/k8s/Portainer) all treat a broken-database panel as not healthy. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_req, reply) => {
    let db: 'ok' | 'error' = 'ok';
    try {
      await app.db.run(sql`SELECT 1`);
    } catch {
      db = 'error';
    }
    if (db === 'error') reply.code(503);
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      version: VERSION,
      time: new Date().toISOString(),
    };
  });
};
