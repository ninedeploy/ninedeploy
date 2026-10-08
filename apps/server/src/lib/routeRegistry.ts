import type { FastifyInstance, RouteOptions } from 'fastify';

/**
 * The live route table (0.15, DESIGN §3.1): every route the app registers,
 * recorded through an `onRoute` hook that `buildApp()` adds before any module
 * registers (mount point M2). The OpenAPI builder (`src/openapi/build.ts`)
 * documents exactly these routes, so the spec can never list a route that is
 * not mounted, nor silently miss one that is.
 *
 * Keys use the authorization matrix's format (`test/authzMatrix.test.ts`):
 * `METHOD /full/path/:param`, with `ALL` for a catch-all that registers every
 * verb. HEAD (it mirrors GET), the CORS preflight `OPTIONS *` and the SPA's
 * static wildcard `/*` are dropped: none is an API operation.
 */
export interface RegisteredRoute {
  /** `METHOD url`, the ROUTE_SPECS / MATRIX key. */
  key: string;
  method: string;
  url: string;
  websocket: boolean;
}

export interface RouteRegistry {
  /** The `onRoute` handler; exposed so tests can feed it directly. */
  record(route: Pick<RouteOptions, 'method' | 'url'> & { websocket?: boolean }): void;
  /** Every recorded route, de-duplicated and sorted by url, then method. */
  list(): RegisteredRoute[];
}

/** A catch-all registers every verb; more than this many methods is `ALL`. */
const CATCH_ALL_METHODS = 3;
/** `@fastify/static`'s wildcard (the SPA), not an API operation. */
const STATIC_WILDCARD = '/*';

export function createRouteRegistry(): RouteRegistry {
  const routes = new Map<string, RegisteredRoute>();
  return {
    record(route) {
      const url = route.url;
      if (url === STATIC_WILDCARD) return;
      const websocket = route.websocket === true;
      const methods = [route.method].flat().map((m) => String(m).toUpperCase());
      if (methods.length > CATCH_ALL_METHODS) {
        const key = `ALL ${url}`;
        routes.set(key, { key, method: 'ALL', url, websocket });
        return;
      }
      for (const method of methods) {
        if (method === 'HEAD' || (method === 'OPTIONS' && url === '*')) continue;
        const key = `${method} ${url}`;
        routes.set(key, { key, method, url, websocket });
      }
    },
    list() {
      return [...routes.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The live route table (0.15); filled by an `onRoute` hook from `buildApp()`. */
    routeRegistry: RouteRegistry;
  }
}

/**
 * Add the recording hook and decorate `app.routeRegistry`. Must run before any
 * plugin or module registers a route: a hook added later misses the routes
 * registered before it.
 */
export function attachRouteRegistry(app: FastifyInstance): RouteRegistry {
  const registry = createRouteRegistry();
  app.decorate('routeRegistry', registry);
  app.addHook('onRoute', (route) => {
    registry.record(route as RouteOptions & { websocket?: boolean });
  });
  return registry;
}
