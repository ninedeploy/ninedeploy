import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ABOUT } from './version.js';
import { apiRoutes } from './modules/api.js';
import { eventRoutes } from './modules/events.js';
import { healthRoutes } from './modules/health.js';
import authPlugin from './plugins/auth.js';
import backupSchedulerPlugin from './plugins/backupScheduler.js';
import autoUpdateSchedulerPlugin from './plugins/autoUpdateScheduler.js';
import collectorPlugin from './plugins/collector.js';
import dbPlugin from './plugins/db.js';
import housekeepingPlugin from './plugins/housekeeping.js';
import jobSchedulerPlugin from './plugins/jobScheduler.js';
import kernelPlugin from './plugins/kernel.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import rawBodyPlugin from './plugins/rawBody.js';
import runtimeStatePlugin from './plugins/runtimeState.js';
import securityHeadersPlugin from './plugins/securityHeaders.js';
import staticFilesPlugin from './plugins/staticFiles.js';
import traefikPlugin from './plugins/traefik.js';
import workerPlugin from './plugins/worker.js';

/** Translate thrown ZodErrors into a consistent 400 envelope. */
function formatZodError(error: ZodError) {
  return {
    error: {
      code: 'validation_error',
      message: 'Request validation failed',
      details: error.flatten(),
    },
  };
}

/** Build a Fastify instance — exported so tests can spin up an isolated app. */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // The panel always sits behind its own Traefik in production; without
    // trusting that single hop, request.ip (and therefore every rate-limit
    // bucket and audit row) collapses onto the proxy's container IP.
    trustProxy: config.trustProxy,
    logger: {
      // Never persist query strings. Current WebSocket clients use an auth
      // subprotocol header, while older clients may still send ?token=.
      serializers: {
        req(req: { method?: string; url: string; remoteAddress?: string; hostname?: string }) {
          const url = req.url.split('?')[0]!;
          return { method: req.method, url, remoteAddress: req.remoteAddress, hostname: req.hostname };
        },
      },
    },
    // Keep the default request budget small. The only legitimate large upload
    // is system import, which declares its own route-level limit below.
    bodyLimit: 1024 * 1024,
  });

  // Restrict CORS to a known allowlist instead of reflecting any origin
  // (`origin: true`). The dashboard is same-origin in production; localhost
  // origins are available only during development, while explicitly configured
  // origins remain available in every environment.
  const extraOrigins = (process.env['NINEDEPLOY_CORS_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = [
    ...new Set([
      config.publicUrl,
      ...(config.isProd ? [] : ['http://localhost:5173', 'http://localhost:3000']),
      ...extraOrigins,
    ]),
  ];
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  await app.register(websocket);
  await app.register(securityHeadersPlugin);
  await app.register(rateLimitPlugin);
  await app.register(rawBodyPlugin);
  await app.register(dbPlugin);
  await app.register(kernelPlugin);
  await app.register(authPlugin);

  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send(formatZodError(err));
    }
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) app.log.error({ err }, 'request error');
    return reply.status(status).send({
      error: {
        code: err.code ?? 'internal_error',
        message: status >= 500 && config.isProd ? 'Internal server error' : err.message,
      },
    });
  });

  // Public
  await app.register(healthRoutes);
  await app.register(eventRoutes);
  // Versioned API
  await app.register(apiRoutes, { prefix: '/v1' });
  // Background deploy worker
  await app.register(workerPlugin);
  // Traefik reverse proxy + dynamic routing
  await app.register(traefikPlugin);
  // Runtime-state reconciliation (panel status vs live containers/processes)
  await app.register(runtimeStatePlugin);
  // Resource metrics collector
  await app.register(collectorPlugin);
  // Scheduled database backups
  await app.register(backupSchedulerPlugin);
  // Image auto-update (watchtower-style digest watch, opt-in per service)
  await app.register(autoUpdateSchedulerPlugin);
  // Periodic log/audit/notification-log retention (disk-fill prevention)
  await app.register(housekeepingPlugin);
  await app.register(jobSchedulerPlugin);

  // Web dashboard (SPA) — registered LAST so every API/WS route wins over the
  // catch-all; unknown API paths still get JSON 404s via the SPA fallback guard.
  await app.register(staticFilesPlugin);

  // About info
  void ABOUT;

  return app;
}
