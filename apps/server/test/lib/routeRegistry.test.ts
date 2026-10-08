import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { attachRouteRegistry, createRouteRegistry } from '../../src/lib/routeRegistry.js';

describe('createRouteRegistry (0.15)', () => {
  it('keys routes as METHOD url and sorts by url, then method', () => {
    const r = createRouteRegistry();
    r.record({ method: 'POST', url: '/v1/b' });
    r.record({ method: ['GET', 'HEAD'], url: '/v1/b' });
    r.record({ method: 'DELETE', url: '/v1/a/:id' });
    expect(r.list().map((x) => x.key)).toEqual(['DELETE /v1/a/:id', 'GET /v1/b', 'POST /v1/b']);
  });

  it('drops HEAD, the CORS preflight and the static wildcard', () => {
    const r = createRouteRegistry();
    r.record({ method: 'HEAD', url: '/v1/x' });
    r.record({ method: 'OPTIONS', url: '*' });
    r.record({ method: ['GET', 'HEAD'], url: '/*' });
    r.record({ method: 'OPTIONS', url: '/v1/y' });
    expect(r.list().map((x) => x.key)).toEqual(['OPTIONS /v1/y']);
  });

  it('collapses a catch-all into one ALL entry and keeps the websocket flag', () => {
    const r = createRouteRegistry();
    r.record({ method: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS'], url: '/v1/proxy/*' });
    r.record({ method: 'GET', url: '/v1/events', websocket: true });
    expect(r.list()).toEqual([
      { key: 'GET /v1/events', method: 'GET', url: '/v1/events', websocket: true },
      { key: 'ALL /v1/proxy/*', method: 'ALL', url: '/v1/proxy/*', websocket: false },
    ]);
  });

  it('records every route registered after it is attached, prefixes included', async () => {
    const app = Fastify();
    const registry = attachRouteRegistry(app);
    expect(app.routeRegistry).toBe(registry);
    await app.register(
      async (scope) => {
        scope.get('/:id', async () => ({}));
        scope.post('/batch', async () => ({}));
      },
      { prefix: '/v1/things' },
    );
    await app.ready();
    expect(registry.list().map((x) => x.key)).toEqual(['GET /v1/things/:id', 'POST /v1/things/batch']);
    await app.close();
  });
});
