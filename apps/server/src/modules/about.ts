import { count } from 'drizzle-orm';
import { databases, deployments, installedPlugins, services, users } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { ABOUT } from '../version.js';

/**
 * System info. Version/license/repo are public (useful for support and
 * update-check banners); instance counts are only included for authenticated
 * requests — an unauthenticated caller must not learn how many users or
 * workloads an instance hosts.
 */
export const aboutRoutes: FastifyPluginAsync = async (app) => {
  // Optional auth at ONREQUEST (r479): the rate limiter keys by principal at
  // preHandler, so resolving the user here — instead of in the handler —
  // keeps an authenticated operator out of the anonymous per-IP bucket on
  // this route too (the exact pooling the r478 fix removed everywhere else).
  // Invalid tokens are swallowed: no Authorization header, or a bad one,
  // serves the public subset and never 401s (the login page links here).
  app.addHook('onRequest', async (req, reply) => {
    if (!req.headers.authorization) return;
    try {
      await app.authenticate(req, reply);
    } catch {
      /* invalid token → public subset */
    }
  });

  app.get('/', async (req) => {
    if (!req.user) {
      return { ...ABOUT };
    }

    let stats = { services: 0, databases: 0, deployments: 0, users: 0, plugins: 0 };
    try {
      const [s, d, dep, u, p] = await Promise.all([
        app.db.select({ n: count() }).from(services),
        app.db.select({ n: count() }).from(databases),
        app.db.select({ n: count() }).from(deployments),
        app.db.select({ n: count() }).from(users),
        app.db.select({ n: count() }).from(installedPlugins),
      ]);
      stats = {
        services: s[0]?.n ?? 0,
        databases: d[0]?.n ?? 0,
        deployments: dep[0]?.n ?? 0,
        users: u[0]?.n ?? 0,
        plugins: p[0]?.n ?? 0,
      };
    } catch {
      /* DB not ready */
    }

    return { ...ABOUT, stats };
  });
};
