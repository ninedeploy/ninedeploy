import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { panelOrigin } from '../lib/panelOrigin.js';
import { buildOpenApiDocument } from '../openapi/build.js';
import { ROUTE_SPECS } from '../openapi/specs/index.js';
import { VERSION } from '../version.js';

/**
 * The OpenAPI 3.1 document (0.15): `GET /v1/openapi.json`, built lazily from
 * the live route table (`app.routeRegistry`) and `ROUTE_SPECS`, memoized per
 * panel origin, with a sha256 ETag (`If-None-Match` answers 304). Behind login
 * (owner decision O4): any session or a coarse or unrestricted token; there is
 * no PREFIX_SCOPES entry for `openapi.json`, so fine-grained tokens are
 * refused. `?download=1` adds a `Content-Disposition`.
 *
 * Design: .temp_files/run_0.15/DESIGN.md §3.1. Owner: task T4. Registered in
 * `modules/api.ts` with no prefix (mount point M1).
 */

interface Built {
  origin: string;
  body: string;
  etag: string;
}

/** `If-None-Match` may list several tags, or `*`; weak tags compare equal here. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const tag = t.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

export const openapiRoutes: FastifyPluginAsync = async (app) => {
  let built: Built | undefined;

  const documentFor = (origin: string): Built => {
    if (built?.origin === origin) return built;
    const doc = buildOpenApiDocument(app.routeRegistry.list(), ROUTE_SPECS, { version: VERSION, serverUrl: origin });
    const body = JSON.stringify(doc);
    built = { origin, body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
    return built;
  };

  app.get('/openapi.json', { onRequest: app.authenticate }, async (req, reply) => {
    const { body, etag } = documentFor(await panelOrigin(app.db));
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=300');
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    if ((req.query as { download?: string }).download === '1') {
      reply.header('Content-Disposition', `attachment; filename="ninedeploy-openapi-${VERSION}.json"`);
    }
    return reply.type('application/json; charset=utf-8').send(body);
  });
};
