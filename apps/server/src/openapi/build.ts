import { z } from 'zod';
import type { RegisteredRoute } from '../lib/routeRegistry.js';
import { requiredFineGrainedScope } from '../plugins/auth.js';
import type { RouteFloor, RouteSpec, RouteSpecMap } from './types.js';

/**
 * OpenAPI 3.1 document builder (0.15, DESIGN §3.1). Owner: task T4.
 *
 * T1 skeleton: documents every LIVE route (from `app.routeRegistry`) — routes
 * with a `ROUTE_SPECS` entry get its summary, floor, security and extensions;
 * routes without one still appear, marked `x-ninedeploy-undocumented`. Bodies,
 * queries and responses are rendered inline with `z.toJSONSchema`; T4 moves
 * them into `components.schemas` behind `$ref`s, keyed by export name.
 */

type JsonSchema = Record<string, unknown>;

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  tags: string[];
  description?: string;
  deprecated?: boolean;
  security: Array<Record<string, string[]>>;
  parameters: Array<{ name: string; in: 'path' | 'query'; required: boolean; schema: JsonSchema }>;
  requestBody?: { required: boolean; content: { 'application/json': { schema: JsonSchema } } };
  responses: Record<string, { description: string; content?: { 'application/json': { schema: JsonSchema } } }>;
  [extension: `x-${string}`]: unknown;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, JsonSchema>;
    schemas: Record<string, JsonSchema>;
  };
}

export interface BuildOptions {
  /** `info.version`: the panel version. */
  version: string;
  /** The panel origin; omitted = relative to wherever the spec was fetched. */
  serverUrl?: string;
  /** Fine-grained scope a route requires (`null` = coarse tokens / sessions only). */
  scopeFor?: (url: string, method: string) => string | null;
}

/** `/v1/services/:id/deploys/:depId` → `/v1/services/{id}/deploys/{depId}`; a trailing `*` → `{wildcard}`. */
export function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*$/, '{wildcard}');
}

/** Path parameter names in order (`*` is `wildcard`). */
export function pathParams(url: string): string[] {
  const names = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
  return url.endsWith('*') ? [...names, 'wildcard'] : names;
}

/** `id`, `*Id` and `bid` are integers; every other path parameter is a string. */
export function paramSchema(name: string): JsonSchema {
  return name === 'id' || name === 'bid' || /[a-z]Id$/.test(name) ? { type: 'integer', minimum: 1 } : { type: 'string' };
}

/** Security requirement for a floor: public/token need none, SCIM its own bearer, the rest the panel bearer. */
export function securityFor(floor: RouteFloor | undefined): Array<Record<string, string[]>> {
  if (floor === 'public' || floor === 'token') return [];
  if (floor === 'scim') return [{ scimBearer: [] }];
  return [{ bearerAuth: [] }];
}

/** `GET /v1/services/:id/deploys` → `getV1ServicesIdDeploys`. */
export function operationIdFor(method: string, url: string): string {
  const words = url
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1));
  return `${method.toLowerCase()}${words.join('')}`;
}

function toJson(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as JsonSchema;
}

function operationFor(route: RegisteredRoute, spec: RouteSpec | undefined, opts: BuildOptions, operationId: string): OpenApiOperation {
  const params = pathParams(route.url).map((name) => ({ name, in: 'path' as const, required: true, schema: paramSchema(name) }));
  const op: OpenApiOperation = {
    operationId,
    summary: spec?.summary ?? `${route.method} ${route.url}`,
    tags: [spec?.tag ?? route.url.split('/').filter(Boolean)[1] ?? 'root'],
    security: securityFor(spec?.floor),
    parameters: params,
    responses: { default: { description: 'See x-ninedeploy-response-type, or the SDK type of the same name.' } },
  };
  if (spec?.description) op.description = spec.description;
  if (spec?.deprecated) op.deprecated = true;
  if (spec?.query) {
    const query = toJson(spec.query, 'input');
    const props = (query['properties'] ?? {}) as Record<string, JsonSchema>;
    const required = new Set((query['required'] as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries(props)) op.parameters.push({ name, in: 'query', required: required.has(name), schema });
  }
  if (spec?.body) op.requestBody = { required: true, content: { 'application/json': { schema: toJson(spec.body, 'input') } } };
  if (spec?.response) op.responses = { 200: { description: 'OK', content: { 'application/json': { schema: toJson(spec.response, 'output') } } } };
  if (spec?.responseType) op['x-ninedeploy-response-type'] = spec.responseType;
  op['x-ninedeploy-floor'] = spec?.floor ?? null;
  op['x-ninedeploy-scope'] = (opts.scopeFor ?? requiredFineGrainedScope)(route.url, route.method === 'ALL' ? 'GET' : route.method);
  if (route.websocket || spec?.websocket) op['x-ninedeploy-websocket'] = true;
  if (spec?.validation) op['x-ninedeploy-validation'] = spec.validation;
  if (route.method === 'ALL') op['x-ninedeploy-all-methods'] = true;
  if (!spec) op['x-ninedeploy-undocumented'] = true;
  return op;
}

/** Build the document for the live routes. Spec entries naming no live route are ignored here (the coverage test refuses them). */
export function buildOpenApiDocument(routes: RegisteredRoute[], specs: RouteSpecMap, opts: BuildOptions): OpenApiDocument {
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: 'NineDeploy API', version: opts.version },
    servers: [{ url: opts.serverUrl ?? '/' }],
    paths: {},
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'A session JWT or an API token.' },
        scimBearer: { type: 'http', scheme: 'bearer', description: 'A workspace SCIM token (/scim/v2 only).' },
      },
      schemas: {},
    },
  };
  const used = new Set<string>();
  for (const route of routes) {
    let operationId = operationIdFor(route.method, route.url);
    for (let n = 2; used.has(operationId); n++) operationId = `${operationIdFor(route.method, route.url)}${n}`;
    used.add(operationId);
    const path = toOpenApiPath(route.url);
    const verb = route.method === 'ALL' ? 'get' : route.method.toLowerCase();
    doc.paths[path] ??= {};
    doc.paths[path]![verb] = operationFor(route, specs[route.key], opts, operationId);
  }
  return doc;
}
