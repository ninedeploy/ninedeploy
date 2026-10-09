import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ABOUT } from './version.js';
import { apiRoutes } from './modules/api.js';
import { scimRoutes } from './modules/scim.js';
import { eventRoutes } from './modules/events.js';
import { healthRoutes } from './modules/health.js';
import { panelAllowedOrigins } from './lib/allowedOrigins.js';
import { attachRouteRegistry } from './lib/routeRegistry.js';
import { websocketServerOptions } from './lib/websocketOptions.js';
import authPlugin from './plugins/auth.js';
import backupSchedulerPlugin from './plugins/backupScheduler.js';
import autoUpdateSchedulerPlugin from './plugins/autoUpdateScheduler.js';
import collectorPlugin from './plugins/collector.js';
import dbPlugin from './plugins/db.js';
import housekeepingPlugin from './plugins/housekeeping.js';
import logShipperPlugin from './plugins/logShipper.js';
import jobSchedulerPlugin from './plugins/jobScheduler.js';
import panelBackupSchedulerPlugin from './plugins/panelBackupScheduler.js';
import kernelPlugin from './plugins/kernel.js';
import githubFeedbackPlugin from './plugins/githubFeedback.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import rawBodyPlugin from './plugins/rawBody.js';
import runtimeStatePlugin from './plugins/runtimeState.js';
import securityHeadersPlugin from './plugins/securityHeaders.js';
import staticFilesPlugin from './plugins/staticFiles.js';
import traefikPlugin from './plugins/traefik.js';
import publicDatabaseAccessPlugin from './plugins/publicDatabaseAccess.js';
import databaseImportsPlugin from './plugins/databaseImports.js';
import terminalsPlugin from './plugins/terminals.js';
import trafficAnalyticsPlugin from './plugins/trafficAnalytics.js';
import nodeDatabasesPlugin from './plugins/nodeDatabases.js';
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
    // onReady wires the whole plugin graph — including self-migration over a
    // possibly cold disk (restart overlap, container start). The 10s default
    // has flaked under load; startup legitimately takes as long as it takes.
    pluginTimeout: 30_000,
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

  // The live route table for the OpenAPI document (0.15, DESIGN §3.1). The
  // onRoute hook must exist before ANY plugin or module registers a route.
  attachRouteRegistry(app);

  // Restrict CORS to a known allowlist instead of reflecting any origin
  // (`origin: true`); see lib/allowedOrigins.ts.
  const allowedOrigins = panelAllowedOrigins();
  // F1016: a dashboard on another origin (VITE_API_URL) must be able to read
  // the repo-list diagnostic; browsers hide non-safelisted headers otherwise.
  await app.register(cors, { origin: allowedOrigins, credentials: true, exposedHeaders: ['x-nd-source-error'] });
  // D6 (0.15, owner decision O6): 1 MiB frame cap, and a non-credential
  // subprotocol is preferred over `ninedeploy.bearer.*` in the 101 echo.
  await app.register(websocket, { options: websocketServerOptions });
  await app.register(securityHeadersPlugin);
  await app.register(rateLimitPlugin);
  await app.register(rawBodyPlugin);
  await app.register(dbPlugin);
  await app.register(kernelPlugin);
  // Commit statuses / PR comments for opted-in GitHub links (0.13); listens on
  // the kernel bus, so it comes after the kernel.
  await app.register(githubFeedbackPlugin);
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
  // SCIM 2.0 lives OUTSIDE /v1: IdPs hardcode the RFC path `${base}/scim/v2`.
  await app.register(scimRoutes, { prefix: '/scim/v2' });
  // Background deploy worker
  await app.register(workerPlugin);
  // Traefik reverse proxy + dynamic routing
  await app.register(traefikPlugin);
  // Public database access sidecars: boot reconcile + watchdog (0.14)
  await app.register(publicDatabaseAccessPlugin);
  // Database dump imports: boot recovery + hourly expiry sweep (0.14)
  await app.register(databaseImportsPlugin);
  // Terminal sessions: boot recovery + 60s reaper (0.15)
  await app.register(terminalsPlugin);
  // Traffic analytics access-log tailer, idle unless enabled (0.15)
  await app.register(trafficAnalyticsPlugin);
  // Node database status loop (multi-node, mount point M2); after kernelPlugin
  await app.register(nodeDatabasesPlugin);
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
  // Container output → configured log drains (r231: drains had no sender)
  await app.register(logShipperPlugin);
  await app.register(jobSchedulerPlugin);
  // Panel self-backup (off until an operator enables it in settings)
  await app.register(panelBackupSchedulerPlugin);

  // Web dashboard (SPA) — registered LAST so every API/WS route wins over the
  // catch-all; unknown API paths still get JSON 404s via the SPA fallback guard.
  await app.register(staticFilesPlugin);

  // About info
  void ABOUT;

  return app;
}
