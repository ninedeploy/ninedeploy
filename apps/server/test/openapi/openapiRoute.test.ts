/**
 * `GET /v1/openapi.json` (0.15, DESIGN §3.1, owner decision O4): served only
 * behind `authenticate`, built lazily from the live route registry and
 * memoized, with a sha256 ETag, `Cache-Control: private, max-age=300`, a 304
 * on a matching `If-None-Match` and `?download=1` for a Content-Disposition.
 * The mount in `modules/api.ts` is pinned by test/operations015Wiring.test.ts
 * and the authz matrix (anonymous 401, any signed-in user 200).
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouteRegistry } from '../../src/lib/routeRegistry.js';
import { etagMatches, openapiRoutes } from '../../src/modules/openapi.js';
import { requiredFineGrainedScope } from '../../src/plugins/auth.js';
import { VERSION } from '../../src/version.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function mount(authed = true) {
  app = Fastify();
  const registry = createRouteRegistry();
  app.addHook('onRoute', (r) => registry.record(r as never));
  app.decorate('routeRegistry', registry);
  // panelOrigin reads settings through this; a failing read falls back to the configured public URL.
  app.decorate('db', {} as never);
  app.decorate('authenticate', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!authed) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing bearer token' } });
  });
  const list = vi.spyOn(registry, 'list');
  await app.register(openapiRoutes, { prefix: '/v1' });
  app.get('/v1/services/:id', async () => ({}));
  await app.ready();
  return { app, list };
}

describe('GET /v1/openapi.json', () => {
  it('refuses an unauthenticated caller', async () => {
    const { app } = await mount(false);
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['etag']).toBeUndefined();
  });

  it('is not reachable with a fine-grained token: no route-map entry', () => {
    expect(requiredFineGrainedScope('/v1/openapi.json', 'GET')).toBeNull();
  });

  it('serves the document for the live routes, memoized, with an ETag and private caching', async () => {
    const { app, list } = await mount();
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers['content-disposition']).toBeUndefined();
    const doc = res.json() as { openapi: string; info: { version: string }; servers: Array<{ url: string }>; paths: Record<string, Record<string, Record<string, unknown>>> };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(VERSION);
    expect(doc.servers[0]!.url).toMatch(/^https?:\/\//);
    expect(Object.keys(doc.paths).sort()).toEqual(['/v1/openapi.json', '/v1/services/{id}']);
    expect(doc.paths['/v1/openapi.json']!['get']).toMatchObject({ 'x-ninedeploy-floor': 'authed', 'x-ninedeploy-scope': null });

    const again = await app.inject({ method: 'GET', url: '/v1/openapi.json?download=1' });
    expect(again.body).toBe(res.body);
    expect(again.headers['etag']).toBe(res.headers['etag']);
    expect(again.headers['content-disposition']).toBe(`attachment; filename="ninedeploy-openapi-${VERSION}.json"`);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const { app } = await mount();
    const first = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const etag = first.headers['etag'] as string;
    const hit = await app.inject({ method: 'GET', url: '/v1/openapi.json', headers: { 'if-none-match': `"x", W/${etag}` } });
    expect(hit.statusCode).toBe(304);
    expect(hit.body).toBe('');
    expect(hit.headers['etag']).toBe(etag);
    const miss = await app.inject({ method: 'GET', url: '/v1/openapi.json', headers: { 'if-none-match': '"other"' } });
    expect(miss.statusCode).toBe(200);
  });
});

describe('etagMatches', () => {
  it('compares strong and weak tags, lists and *', () => {
    expect(etagMatches(undefined, '"a"')).toBe(false);
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches('"b", "a"', '"a"')).toBe(true);
    expect(etagMatches('*', '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
  });
});
