import * as sharedSchemas from '@ninedeploy/schemas';
import { z } from 'zod';
import type { RegisteredRoute } from '../lib/routeRegistry.js';
import { requiredFineGrainedScope } from '../plugins/auth.js';
import type { RouteFloor, RouteSpec, RouteSpecMap } from './types.js';

/**
 * OpenAPI 3.1 document builder (0.15, DESIGN §3.1). Owner: task T4.
 *
 * Documents every LIVE route (from `app.routeRegistry`): routes with a
 * `ROUTE_SPECS` entry get its summary, floor, security, schemas and
 * extensions; routes without one still appear, marked
 * `x-ninedeploy-undocumented`. Request bodies and responses that are named
 * zod exports (of `@ninedeploy/schemas` by default) become
 * `components.schemas` entries behind `$ref`s, keyed by their export name;
 * unnamed schemas are rendered inline. Query schemas are expanded into
 * `in: query` parameters.
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
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
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
  /** zod schema → component name. Defaults to every zod export of `@ninedeploy/schemas`. */
  schemaNames?: Map<z.ZodType, string>;
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

/** A zod 4 schema (duck-typed, so a second copy of zod still counts). */
export function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

/**
 * zod schema → export name, for every zod export of a module namespace. An
 * object exported under two names (`containerFileWrite = volumeFileWrite`)
 * keeps the alphabetically first, so the component name is stable.
 */
export function zodExportNames(namespace: Record<string, unknown>): Map<z.ZodType, string> {
  const names = new Map<z.ZodType, string>();
  for (const name of Object.keys(namespace).sort()) {
    const value = namespace[name];
    if (isZodSchema(value) && !names.has(value)) names.set(value, name);
  }
  return names;
}

let defaultNames: Map<z.ZodType, string> | undefined;
/** The `@ninedeploy/schemas` zod exports, by object. */
export function sharedSchemaNames(): Map<z.ZodType, string> {
  defaultNames ??= zodExportNames(sharedSchemas as Record<string, unknown>);
  return defaultNames;
}

const JSON_OPTIONS = { target: 'draft-2020-12', unrepresentable: 'any', cycles: 'ref' } as const;

/** Drop the per-document keys `z.toJSONSchema` adds; a component or an inline schema carries neither. */
function bare(schema: JsonSchema): JsonSchema {
  const { $schema: _s, $id: _i, ...rest } = schema;
  return rest;
}

/** Render one schema inline; a schema `z.toJSONSchema` cannot express is documented as `{}`, never a crash. */
export function inlineSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  try {
    return bare(z.toJSONSchema(schema, { ...JSON_OPTIONS, io }) as JsonSchema);
  } catch (err) {
    return { description: `Not representable as JSON Schema (${err instanceof Error ? err.message : String(err)}).` };
  }
}

/**
 * Render named schemas as `components.schemas`, cross-referencing each other
 * by `$ref`. Falls back to one schema at a time (no cross references) if the
 * registry as a whole cannot be rendered.
 */
function renderComponents(named: Map<string, z.ZodType>, io: 'input' | 'output'): Record<string, JsonSchema> {
  if (named.size === 0) return {};
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of named) registry.add(schema, { id });
  try {
    const out = z.toJSONSchema(registry, { ...JSON_OPTIONS, io, uri: (id: string) => `#/components/schemas/${id}` }) as {
      schemas: Record<string, JsonSchema>;
    };
    return Object.fromEntries(Object.entries(out.schemas).map(([id, s]) => [id, bare(s)]));
  } catch {
    return Object.fromEntries([...named].map(([id, schema]) => [id, inlineSchema(schema, io)]));
  }
}

const ref = (id: string): JsonSchema => ({ $ref: `#/components/schemas/${id}` });

/** Collects the named schemas the operations reference, one component per (schema, direction). */
class ComponentSet {
  readonly input = new Map<string, z.ZodType>();
  readonly output = new Map<string, z.ZodType>();
  private readonly ids = new Map<z.ZodType, { input?: string; output?: string }>();
  constructor(private readonly names: Map<z.ZodType, string>) {}

  /** A `$ref` for a named schema, or the inline rendering of an unnamed one. */
  use(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
    const name = this.names.get(schema);
    if (!name) return inlineSchema(schema, io);
    const seen = this.ids.get(schema) ?? {};
    let id = seen[io];
    if (!id) {
      // A schema used both as a body and as a response renders differently
      // (defaults are optional on input): the output side gets a suffix.
      const other = io === 'input' ? this.output : this.input;
      id = other.has(name) ? `${name}${io === 'input' ? 'Input' : 'Output'}` : name;
      seen[io] = id;
      this.ids.set(schema, seen);
      (io === 'input' ? this.input : this.output).set(id, schema);
    }
    return ref(id);
  }

  render(): Record<string, JsonSchema> {
    const all = { ...renderComponents(this.input, 'input'), ...renderComponents(this.output, 'output') };
    return Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  }
}

function describedObject(description: string): JsonSchema {
  return { type: 'object', description };
}

function operationFor(
  route: RegisteredRoute,
  spec: RouteSpec | undefined,
  opts: BuildOptions,
  operationId: string,
  components: ComponentSet,
): OpenApiOperation {
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
    const query = inlineSchema(spec.query, 'input');
    const props = (query['properties'] ?? {}) as Record<string, JsonSchema>;
    const required = new Set((query['required'] as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries(props)) op.parameters.push({ name, in: 'query', required: required.has(name), schema });
  }
  if (spec?.body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: components.use(spec.body, 'input') } } };
  } else if (spec?.localBody) {
    op.requestBody = {
      required: false,
      content: { 'application/json': { schema: describedObject(`Validated by the module-local zod schema ${spec.localBody}.`) } },
    };
  } else if (spec?.bodyType) {
    op.requestBody = {
      required: false,
      content: { 'application/json': { schema: describedObject(`Read by the handler as ${spec.bodyType} (not validated by a schema).`) } },
    };
  }
  if (spec?.response) op.responses = { 200: { description: 'OK', content: { 'application/json': { schema: components.use(spec.response, 'output') } } } };
  if (spec?.responseType) op['x-ninedeploy-response-type'] = spec.responseType;
  if (spec?.localBody) op['x-ninedeploy-body-schema'] = spec.localBody;
  if (spec?.localQuery) op['x-ninedeploy-query-schema'] = spec.localQuery;
  if (spec?.bodyType) op['x-ninedeploy-body-type'] = spec.bodyType;
  if (spec?.queryType) op['x-ninedeploy-query-type'] = spec.queryType;
  op['x-ninedeploy-floor'] = spec?.floor ?? null;
  op['x-ninedeploy-scope'] = (opts.scopeFor ?? requiredFineGrainedScope)(route.url, route.method === 'ALL' ? 'GET' : route.method);
  if (route.websocket || spec?.websocket) op['x-ninedeploy-websocket'] = true;
  if (spec?.validation) op['x-ninedeploy-validation'] = spec.validation;
  if (spec?.sensitive) op['x-ninedeploy-sensitive'] = true;
  if (spec?.mcp) op['x-ninedeploy-mcp-tool'] = spec.mcp.name;
  if (route.method === 'ALL') op['x-ninedeploy-all-methods'] = true;
  if (!spec) op['x-ninedeploy-undocumented'] = true;
  return op;
}

/** Build the document for the live routes. Spec entries naming no live route are ignored here (the coverage test refuses them). */
export function buildOpenApiDocument(routes: RegisteredRoute[], specs: RouteSpecMap, opts: BuildOptions): OpenApiDocument {
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: 'NineDeploy API',
      version: opts.version,
      description:
        'Generated from the live route table. x-ninedeploy-floor is the minimum caller (a workspace role, operator, or self/authed/public/token/scim); x-ninedeploy-scope is the fine-grained API-token scope a route needs (null: sessions and coarse tokens only).',
    },
    servers: [{ url: opts.serverUrl ?? '/' }],
    tags: [],
    paths: {},
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'A session JWT or an API token.' },
        scimBearer: { type: 'http', scheme: 'bearer', description: 'A workspace SCIM token (/scim/v2 only).' },
      },
      schemas: {},
    },
  };
  const components = new ComponentSet(opts.schemaNames ?? sharedSchemaNames());
  const used = new Set<string>();
  const tags = new Set<string>();
  for (const route of routes) {
    let operationId = operationIdFor(route.method, route.url);
    for (let n = 2; used.has(operationId); n++) operationId = `${operationIdFor(route.method, route.url)}${n}`;
    used.add(operationId);
    const path = toOpenApiPath(route.url);
    const verb = route.method === 'ALL' ? 'get' : route.method.toLowerCase();
    const op = operationFor(route, specs[route.key], opts, operationId, components);
    for (const tag of op.tags) tags.add(tag);
    doc.paths[path] ??= {};
    doc.paths[path]![verb] = op;
  }
  doc.tags = [...tags].sort().map((name) => ({ name }));
  doc.components.schemas = components.render();
  return doc;
}
