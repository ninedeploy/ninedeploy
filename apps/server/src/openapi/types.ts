import type { z } from 'zod';

/**
 * One route's OpenAPI description (0.15, DESIGN §3.1). `ROUTE_SPECS` maps the
 * route key — `METHOD /v1/path/:param`, the same format as the authorization
 * matrix — to one of these. Handlers keep parsing exactly as before: a spec
 * DOCUMENTS a route, it never changes what the route accepts.
 */

/** The minimum a caller needs; must equal the route's `MATRIX` floor (openapiFloor test). */
export type RouteFloor =
  | 'public'
  | 'token'
  | 'self'
  | 'authed'
  | 'viewer'
  | 'member'
  | 'admin'
  | 'owner'
  | 'operator'
  | 'scim';

export interface RouteSpec {
  summary: string;
  tag: string;
  description?: string;
  floor: RouteFloor;
  /** zod only — exported from `@ninedeploy/schemas` or the module. */
  body?: z.ZodType;
  query?: z.ZodType;
  response?: z.ZodType;
  /** TS type name when no zod response exists (documented as x-ninedeploy-response-type). */
  responseType?: string;
  /**
   * A module-local zod schema the handler parses, as `<module>.ts#<name>`
   * (documented as x-ninedeploy-body-schema / x-ninedeploy-query-schema). It
   * is not exported, so the document names it instead of rendering it.
   */
  localBody?: string;
  localQuery?: string;
  /**
   * The TypeScript shape a handler casts an unvalidated body or query to
   * (`validation: 'handler'`; documented as x-ninedeploy-body-type /
   * x-ninedeploy-query-type).
   */
  bodyType?: string;
  queryType?: string;
  /** 'handler' marks the `req.body as` sites: documented shape, not enforced. */
  validation?: 'zod' | 'handler';
  /** Returns secrets (credentials, env values): never becomes an MCP tool. */
  sensitive?: true;
  /** A generated read-only MCP tool. GET only (enforced by the generator and the document test). */
  mcp?: { name: string; description: string; readOnly: true };
  websocket?: true;
  deprecated?: true;
}

export type RouteSpecMap = Record<string, RouteSpec>;
