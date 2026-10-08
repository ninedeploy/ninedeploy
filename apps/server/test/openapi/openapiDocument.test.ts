/**
 * The OpenAPI 3.1 document built from every ROUTE_SPECS entry (0.15, DESIGN
 * §3.2). The live-route half — every registered route has an entry, every
 * entry names a registered route, and each entry's floor equals its
 * authorization-matrix floor — lives in `test/authzMatrix.test.ts` (block
 * `0.15 T4 openapi`), which already boots the real app.
 *
 * Here, without booting anything:
 *   - the document is valid in the ways a client generator cares about:
 *     3.1.0, unique operationIds, every `$ref` resolves, every `{param}` has
 *     a parameter object;
 *   - `mcp` entries are GETs and never `sensitive`;
 *   - static truth: every schema a module handler parses from `req.body` or
 *     `req.query` is named by some spec entry, so the documented body cannot
 *     silently stop matching what the handler validates;
 *   - the API surface snapshot (`METHOD path floor scope`) is committed, so a
 *     reviewer sees surface changes in the diff.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sharedSchemas from '@ninedeploy/schemas';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, inlineSchema, isZodSchema, sharedSchemaNames, zodExportNames } from '../../src/openapi/build.js';
import { ROUTE_SPECS, SPEC_FRAGMENTS } from '../../src/openapi/specs/index.js';
import type { RouteSpec } from '../../src/openapi/types.js';
import type { RegisteredRoute } from '../../src/lib/routeRegistry.js';
import { requiredFineGrainedScope } from '../../src/plugins/auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.resolve(HERE, '../../src/modules');

const routes: RegisteredRoute[] = Object.keys(ROUTE_SPECS).map((key) => {
  const [method, url] = key.split(' ') as [string, string];
  return { key, method, url, websocket: ROUTE_SPECS[key]!.websocket === true };
});
const doc = buildOpenApiDocument(routes, ROUTE_SPECS, { version: '0.15.0-test' });
const operations = Object.entries(doc.paths).flatMap(([p, ops]) => Object.entries(ops).map(([verb, op]) => ({ path: p, verb, op })));
const FLOORS = new Set(['public', 'token', 'self', 'authed', 'viewer', 'member', 'admin', 'owner', 'operator', 'scim']);

describe('ROUTE_SPECS entries', () => {
  it('covers the routes that predate 0.15 (417 matrix entries, plus /v1/openapi.json)', () => {
    expect(Object.keys(ROUTE_SPECS).length).toBeGreaterThanOrEqual(418);
  });

  it('every entry has a summary, a tag and a known floor; flags are consistent', () => {
    const problems: string[] = [];
    for (const [key, spec] of Object.entries(ROUTE_SPECS)) {
      if (!spec.summary.trim()) problems.push(`${key}: empty summary`);
      if (!/^[a-z][a-z0-9-]*$/.test(spec.tag)) problems.push(`${key}: tag "${spec.tag}"`);
      if (!FLOORS.has(spec.floor)) problems.push(`${key}: floor "${spec.floor}"`);
      if (spec.body && !isZodSchema(spec.body)) problems.push(`${key}: body is not a zod schema (undefined import?)`);
      if (spec.query && !isZodSchema(spec.query)) problems.push(`${key}: query is not a zod schema (undefined import?)`);
      if (spec.response && !isZodSchema(spec.response)) problems.push(`${key}: response is not a zod schema (undefined import?)`);
      if (spec.body && (spec.localBody || spec.bodyType)) problems.push(`${key}: body named twice`);
      if ((spec.body || spec.query || spec.localBody || spec.localQuery) && spec.validation !== 'zod') problems.push(`${key}: zod-parsed but validation is not 'zod'`);
      if ((spec.bodyType || spec.queryType) && !spec.validation) problems.push(`${key}: handler-cast shape without validation`);
      for (const local of [spec.localBody, spec.localQuery]) {
        if (local && !/^[A-Za-z]+\.ts#[A-Za-z]\w*$/.test(local)) problems.push(`${key}: localBody/localQuery "${local}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('mcp entries are read-only GETs, never sensitive and never WebSockets', () => {
    const mcp = Object.entries(ROUTE_SPECS).filter(([, s]) => s.mcp);
    expect(mcp.length).toBeGreaterThan(0);
    for (const [key, spec] of mcp) {
      expect(key.startsWith('GET /v1/'), key).toBe(true);
      expect(spec.sensitive, key).toBeUndefined();
      expect(spec.websocket, key).toBeUndefined();
      expect(spec.mcp!.readOnly).toBe(true);
    }
  });

  it('marks the routes that hand out secrets as sensitive', () => {
    for (const key of [
      'GET /v1/databases/:id/credentials',
      'GET /v1/services/:id/env',
      'GET /v1/services/:id/env/export',
      'GET /v1/projects/:id/env',
      'GET /v1/backups/:bid/download',
      'GET /v1/system/export',
      'GET /v1/config/:key',
      'POST /v1/auth/tokens',
    ]) {
      expect(ROUTE_SPECS[key]?.sensitive, key).toBe(true);
    }
  });

  it('the three WebSockets are flagged', () => {
    const ws = Object.entries(ROUTE_SPECS)
      .filter(([, s]) => s.websocket)
      .map(([k]) => k);
    expect(ws).toEqual(expect.arrayContaining(['GET /v1/events', 'GET /v1/services/:id/deploys/:depId/logs', 'GET /v1/services/:id/exec']));
  });
});

describe('the built document', () => {
  it('is OpenAPI 3.1.0 with one operation per entry and no undocumented route', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(operations).toHaveLength(Object.keys(ROUTE_SPECS).length);
    expect(operations.filter(({ op }) => op['x-ninedeploy-undocumented'])).toEqual([]);
    expect(doc.tags.map((t) => t.name)).toEqual([...new Set(Object.values(ROUTE_SPECS).map((s) => s.tag))].sort());
  });

  it('has unique operationIds', () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every $ref to a component', () => {
    const json = JSON.stringify(doc);
    const refs = [...json.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((r) => !r.startsWith('#/components/schemas/') || !(r.slice('#/components/schemas/'.length) in doc.components.schemas));
    expect([...new Set(missing)]).toEqual([]);
  });

  it('documents every {param} in a path as a required path parameter', () => {
    for (const { path: p, verb, op } of operations) {
      const names = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const params = op.parameters.filter((x) => x.in === 'path');
      expect(params.map((x) => x.name), `${verb} ${p}`).toEqual(names);
      for (const x of params) expect(x.required).toBe(true);
    }
  });

  it('renders every zod body as a non-empty schema and names its component after the export', () => {
    const names = sharedSchemaNames();
    for (const [key, spec] of Object.entries(ROUTE_SPECS)) {
      if (!spec.body) continue;
      const [method, url] = key.split(' ') as [string, string];
      const op = doc.paths[url.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*$/, '{wildcard}')]![method === 'ALL' ? 'get' : method.toLowerCase()]!;
      const schema = op.requestBody!.content['application/json'].schema;
      const name = names.get(spec.body);
      if (name) {
        expect(schema, key).toEqual({ $ref: `#/components/schemas/${name}` });
        expect(Object.keys(doc.components.schemas[name] ?? {}).length, `${key}: component ${name}`).toBeGreaterThan(0);
      } else {
        expect(Object.keys(schema).length, key).toBeGreaterThan(0);
      }
    }
    for (const [id, schema] of Object.entries(doc.components.schemas)) {
      expect(schema['$schema'], id).toBeUndefined();
      expect(schema['$id'], id).toBeUndefined();
    }
  });

  it('carries floor, scope, validation and the handler-cast extensions', () => {
    const op = (verb: string, p: string) => doc.paths[p]![verb]!;
    expect(op('get', '/v1/services/{id}')).toMatchObject({ 'x-ninedeploy-floor': 'viewer', 'x-ninedeploy-scope': 'nd://scope/read/services' });
    expect(op('get', '/v1/openapi.json')['x-ninedeploy-scope']).toBeNull();
    expect(op('get', '/v1/doctor')['x-ninedeploy-mcp-tool']).toBe('doctor_report');
    expect(op('get', '/v1/databases/{id}/credentials')['x-ninedeploy-sensitive']).toBe(true);
    expect(op('get', '/v1/labels')).toMatchObject({ 'x-ninedeploy-validation': 'handler', 'x-ninedeploy-query-type': '{ workspaceId?: string }' });
    const env = op('post', '/v1/environments');
    expect(env['x-ninedeploy-body-schema']).toBe('environments.ts#environmentCreate');
    expect(env.requestBody!.content['application/json'].schema).toMatchObject({ type: 'object' });
    const egress = op('post', '/v1/egress');
    expect(egress['x-ninedeploy-body-type']).toMatch(/projectId: number/);
    expect(egress.requestBody!.required).toBe(false);
    for (const { op: o } of operations) {
      expect(o['x-ninedeploy-scope']).toBe(o['x-ninedeploy-scope'] ?? null);
    }
  });

  it('agrees with the auth plugin on each route scope', () => {
    for (const { key, method, url } of routes) {
      const p = url.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*$/, '{wildcard}');
      const op = doc.paths[p]![method === 'ALL' ? 'get' : method.toLowerCase()]!;
      expect(op['x-ninedeploy-scope'], key).toBe(requiredFineGrainedScope(url, method === 'ALL' ? 'GET' : method));
    }
  });
});

describe('builder edge cases', () => {
  const route = (method: string, url: string): RegisteredRoute => ({ key: `${method} ${url}`, method, url, websocket: false });
  const Named = z.object({ name: z.string(), retries: z.number().int().default(3) });
  const Parent = z.object({ child: Named });
  const names = new Map<z.ZodType, string>([
    [Named, 'Named'],
    [Parent, 'Parent'],
  ]);
  const spec = (extra: Partial<RouteSpec>): RouteSpec => ({ summary: 's', tag: 't', floor: 'operator', ...extra });

  it('references named schemas, cross-references nested ones, and splits input from output', () => {
    const d = buildOpenApiDocument(
      [route('POST', '/v1/a'), route('POST', '/v1/b'), route('GET', '/v1/c')],
      {
        'POST /v1/a': spec({ body: Named, validation: 'zod' }),
        'POST /v1/b': spec({ body: Parent, response: Named, validation: 'zod' }),
        'GET /v1/c': spec({ response: Named }),
      },
      { version: 'x', schemaNames: names },
    );
    expect(d.paths['/v1/a']!['post']!.requestBody!.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Named' });
    expect(d.paths['/v1/b']!['post']!.responses['200']!.content!['application/json'].schema).toEqual({ $ref: '#/components/schemas/NamedOutput' });
    expect(d.paths['/v1/c']!['get']!.responses['200']!.content!['application/json'].schema).toEqual({ $ref: '#/components/schemas/NamedOutput' });
    expect(d.components.schemas['Parent']).toMatchObject({ properties: { child: { $ref: '#/components/schemas/Named' } } });
    // Input: a defaulted field is optional; output: it is always present.
    expect(d.components.schemas['Named']!['required']).toEqual(['name']);
    expect(d.components.schemas['NamedOutput']!['required']).toEqual(['name', 'retries']);
  });

  it('documents a localBody and a bodyType without rendering a schema', () => {
    const d = buildOpenApiDocument(
      [route('POST', '/v1/a'), route('PUT', '/v1/b')],
      {
        'POST /v1/a': spec({ localBody: 'x.ts#local', localQuery: 'x.ts#q', validation: 'zod' }),
        'PUT /v1/b': spec({ bodyType: '{ a?: string }', queryType: '{ b?: string }', validation: 'handler', sensitive: true }),
      },
      { version: 'x', schemaNames: names },
    );
    const a = d.paths['/v1/a']!['post']!;
    expect(a).toMatchObject({ 'x-ninedeploy-body-schema': 'x.ts#local', 'x-ninedeploy-query-schema': 'x.ts#q' });
    expect(a.requestBody).toMatchObject({ required: false });
    const b = d.paths['/v1/b']!['put']!;
    expect(b).toMatchObject({ 'x-ninedeploy-body-type': '{ a?: string }', 'x-ninedeploy-query-type': '{ b?: string }', 'x-ninedeploy-sensitive': true });
    expect(d.components.schemas).toEqual({});
  });

  it('never throws on a schema JSON Schema cannot express', () => {
    expect(inlineSchema(z.date(), 'input')).toEqual({});
    const broken = { _zod: {} } as unknown as z.ZodType;
    expect(inlineSchema(broken, 'input')['description']).toMatch(/Not representable/);
    const d = buildOpenApiDocument([route('POST', '/v1/a')], { 'POST /v1/a': spec({ body: broken, validation: 'zod' }) }, { version: 'x', schemaNames: new Map([[broken, 'Broken']]) });
    expect(d.components.schemas['Broken']!['description']).toMatch(/Not representable/);
  });

  it('names every zod export of a namespace once, first name wins', () => {
    const s = z.string();
    const m = zodExportNames({ a: s, b: s, c: 1, d: null, e: z.number() });
    expect([...m.values()]).toEqual(['a', 'e']);
    expect(sharedSchemaNames().get(sharedSchemas.createService)).toBe('createService');
    expect(sharedSchemaNames()).toBe(sharedSchemaNames());
  });
});

/** `X.parse(req.body` / `X.safeParse(req.query` identifiers per module file. */
function parsedSchemas(source: string, kind: 'body' | 'query'): string[] {
  return [...new Set([...source.matchAll(new RegExp(`(\\w+)\\s*\\.\\s*(?:safeParse|parse)\\(\\s*req\\.${kind}\\b`, 'g'))].map((m) => m[1]!))];
}

/** The `@ninedeploy/schemas` names a module imports (value imports only). */
function sharedImports(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@ninedeploy\/schemas'/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim();
      if (!name || name.startsWith('type ')) continue;
      out.add(name.split(/\s+as\s+/).pop()!);
    }
  }
  return out;
}

describe('static truth: documented schemas match what handlers parse', () => {
  const specs = Object.values(ROUTE_SPECS);
  // By object: an export aliased under two names (containerFileWrite = volumeFileWrite) is one schema.
  const documented = (kind: 'body' | 'query') => new Set<unknown>(specs.map((s) => s[kind]).filter(Boolean));
  const documentedLocal = (kind: 'localBody' | 'localQuery') => new Set(specs.map((s) => s[kind]).filter(Boolean));

  it('scans the module files and finds the parse sites', () => {
    const files = readdirSync(MODULES).filter((f) => f.endsWith('.ts'));
    const total = files.reduce((n, f) => n + parsedSchemas(readFileSync(path.join(MODULES, f), 'utf8'), 'body').length, 0);
    expect(total).toBeGreaterThan(100);
  });

  for (const kind of ['body', 'query'] as const) {
    it(`every schema a handler parses from req.${kind} is some entry's ${kind} (or local${kind === 'body' ? 'Body' : 'Query'})`, () => {
      const shared = documented(kind);
      const local = documentedLocal(kind === 'body' ? 'localBody' : 'localQuery');
      const missing: string[] = [];
      for (const file of readdirSync(MODULES).filter((f) => f.endsWith('.ts'))) {
        const source = readFileSync(path.join(MODULES, file), 'utf8');
        const imported = sharedImports(source);
        for (const id of parsedSchemas(source, kind)) {
          const exported = (sharedSchemas as Record<string, unknown>)[id];
          const ok = imported.has(id) ? isZodSchema(exported) && shared.has(exported) : local.has(`${file}#${id}`);
          if (!ok) missing.push(`${file}: ${id}.parse(req.${kind})`);
        }
      }
      expect(missing).toEqual([]);
    });
  }

  it('every localBody / localQuery names a schema its module really parses', () => {
    const stale: string[] = [];
    for (const spec of specs) {
      for (const [local, kind] of [
        [spec.localBody, 'body'],
        [spec.localQuery, 'query'],
      ] as const) {
        if (!local) continue;
        const [file, id] = local.split('#') as [string, string];
        const source = readFileSync(path.join(MODULES, file), 'utf8');
        if (!new RegExp(`\\b${id}\\s*\\.\\s*(?:safeParse|parse)\\(`).test(source) || !new RegExp(`\\bconst ${id}\\b`).test(source)) {
          stale.push(`${local} (${kind})`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});

/**
 * The committed surface list. Regenerate after an intended API change with
 * `ND_UPDATE_API_SURFACE=1 vitest run test/openapi/openapiDocument.test.ts`
 * and review the diff. The three fragments 0.15 feature tasks are still
 * filling (terminals, traffic, access grants) join it once those land.
 */
const SURFACE_FILE = path.join(HERE, 'apiSurface.snap');
const PENDING_FRAGMENTS = ['terminals', 'traffic', 'accessGrants'];

describe('API surface snapshot', () => {
  it('matches the committed METHOD path floor scope list', () => {
    const pending = new Set(PENDING_FRAGMENTS.flatMap((f) => Object.keys(SPEC_FRAGMENTS[f] ?? {})));
    const lines = Object.entries(ROUTE_SPECS)
      .filter(([key]) => !pending.has(key))
      .map(([key, spec]) => {
        const [method, url] = key.split(' ') as [string, string];
        return `${key} ${spec.floor} ${requiredFineGrainedScope(url, method === 'ALL' ? 'GET' : method) ?? '-'}`;
      })
      .sort();
    const actual = `${lines.join('\n')}\n`;
    if (process.env['ND_UPDATE_API_SURFACE'] === '1') writeFileSync(SURFACE_FILE, actual);
    const committed = readFileSync(SURFACE_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(actual, 'API surface changed: review it and regenerate test/openapi/apiSurface.snap').toBe(committed);
  });
});
