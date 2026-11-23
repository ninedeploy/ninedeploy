import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Pick the first candidate folder that carries a built dashboard (index.html).
 * Pure and injectable so the selection logic is testable without moving real
 * directories around.
 */
export function pickWebDist(candidates: Array<string | undefined>): string | null {
  for (const c of candidates) {
    if (c && existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

/**
 * Resolve the built web dashboard folder at runtime. The server serves the
 * dashboard itself (no separate static server needed):
 *   1. NINEDEPLOY_WEB_DIST env override
 *   2. compiled layout: packages/.../apps/server/dist/plugins -> ../../../web/dist
 *   3. source layout:   apps/server/src/plugins                 -> ../../../web/dist
 *   4. cwd at a monorepo root (dev shell / container)
 */
export function resolveWebDistFolder(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return pickWebDist([
    process.env['NINEDEPLOY_WEB_DIST'],
    path.resolve(here, '../../../web/dist'),
    path.resolve('apps/web/dist'),
  ]);
}

/** Paths that belong to the API surface and must never receive the SPA fallback. */
function isApiPath(url: string): boolean {
  return url.startsWith('/v1') || url.startsWith('/health') || url.startsWith('/hooks') || url.startsWith('/events');
}

/**
 * A build output file whose name carries Vite's content hash. Nothing else
 * about the file is stable, so nothing else may be kept by a browser: the
 * hash is what makes the name a promise.
 */
const HASHED_ASSET = /^assets[\\/](?:[^\\/]+[\\/])*[^\\/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

/**
 * Serve the built web dashboard (apps/web/dist) from the API and fall back to
 * index.html for client-side routes. Registered LAST so every /v1 route wins;
 * unknown API paths still get JSON 404s, only browser HTML navigations get the
 * SPA entry. Without a dist, retain JSON 404s without Fastify's raw-URL log.
 */
export async function registerStaticFiles(fastify: FastifyInstance, root: string | null): Promise<void> {
  if (!root) {
    fastify.log.info('web dashboard dist not found — API-only mode (build apps/web or set NINEDEPLOY_WEB_DIST)');
  } else {
    await fastify.register(fastifyStatic, {
      root,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      // N10: a hashed file is fetched once and kept. index.html names those
      // files and stays `max-age=0`, so an upgrade is seen on the next load.
      // Before this, every page load asked the panel again for all ~29 of
      // them — and each ask counted against the panel's request limit.
      setHeaders(reply, filename) {
        if (HASHED_ASSET.test(path.relative(root, filename))) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  fastify.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (root && !isApiPath(req.url) && req.method === 'GET') {
      // R4: the OAuth consent page is never shown inside another site's frame (clickjacking).
      if (req.url.startsWith('/oauth/authorize')) reply.header('X-Frame-Options', 'DENY').header('Content-Security-Policy', "frame-ancestors 'none'");
      return reply.sendFile('index.html');
    }
    // Preserve Fastify's default not-found body for API paths and non-GET
    // requests — the dashboard must not change the API 404 contract.
    return reply.code(404).send({
      message: `Route ${req.method}:${req.url} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  });
}

export default fp(
  async (fastify) => {
    await registerStaticFiles(fastify, resolveWebDistFolder());
  },
  { name: 'ninedeploy-static' },
);
