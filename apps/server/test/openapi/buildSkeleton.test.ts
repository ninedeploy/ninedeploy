/**
 * The T1 skeleton of the OpenAPI builder and the ROUTE_SPECS aggregation
 * (0.15, DESIGN §3.1). T4 extends both; these pin the contract the skeleton
 * already offers: the document lists exactly the live routes, a route without
 * a spec is still documented (marked undocumented), floors map to security,
 * and two fragments can never claim the same route.
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  buildOpenApiDocument,
  operationIdFor,
  paramSchema,
  pathParams,
  securityFor,
  toOpenApiPath,
} from '../../src/openapi/build.js';
import { mergeSpecFragments, ROUTE_SPECS, SPEC_FRAGMENTS } from '../../src/openapi/specs/index.js';
import type { RegisteredRoute } from '../../src/lib/routeRegistry.js';

const route = (method: string, url: string, websocket = false): RegisteredRoute => ({ key: `${method} ${url}`, method, url, websocket });

describe('builder helpers', () => {
  it('converts paths and types their parameters', () => {
    expect(toOpenApiPath('/v1/services/:id/deploys/:depId')).toBe('/v1/services/{id}/deploys/{depId}');
    expect(toOpenApiPath('/v1/databases/:id/studio-proxy/*')).toBe('/v1/databases/{id}/studio-proxy/{wildcard}');
    expect(pathParams('/v1/databases/:id/studio-proxy/*')).toEqual(['id', 'wildcard']);
    expect(paramSchema('id')).toEqual({ type: 'integer', minimum: 1 });
    expect(paramSchema('grantId')).toEqual({ type: 'integer', minimum: 1 });
    expect(paramSchema('bid')).toEqual({ type: 'integer', minimum: 1 });
    expect(paramSchema('name')).toEqual({ type: 'string' });
    expect(paramSchema('wid')).toEqual({ type: 'string' });
  });

  it('maps floors to security requirements', () => {
    expect(securityFor('public')).toEqual([]);
    expect(securityFor('token')).toEqual([]);
    expect(securityFor('scim')).toEqual([{ scimBearer: [] }]);
    expect(securityFor('operator')).toEqual([{ bearerAuth: [] }]);
    expect(securityFor(undefined)).toEqual([{ bearerAuth: [] }]);
  });

  it('derives camel-case operation ids', () => {
    expect(operationIdFor('GET', '/v1/services/:id/deploys')).toBe('getV1ServicesIdDeploys');
    expect(operationIdFor('POST', '/v1/openapi.json')).toBe('postV1OpenapiJson');
  });
});

describe('buildOpenApiDocument (skeleton)', () => {
  const routes = [
    route('GET', '/v1/terminals'),
    route('GET', '/v1/terminals/:id/attach', true),
    route('POST', '/v1/services/:id/deploys'),
    route('ALL', '/v1/databases/:id/studio-proxy/*'),
    route('GET', '/scim/v2/Users'),
  ];
  const doc = buildOpenApiDocument(
    routes,
    {
      'GET /v1/terminals': {
        summary: 'List terminal sessions',
        tag: 'terminals',
        floor: 'operator',
        query: z.object({ limit: z.number().int().default(50), status: z.string() }),
        response: z.object({ items: z.array(z.string()) }),
        mcp: { name: 'list_terminal_sessions', description: 'x', readOnly: true },
      },
      'POST /v1/services/:id/deploys': {
        summary: 'Queue a deploy',
        tag: 'deploys',
        description: 'Builds and releases.',
        floor: 'member',
        body: z.object({ ref: z.string().optional() }),
        responseType: 'Deployment',
        validation: 'zod',
        deprecated: true,
      },
      'GET /scim/v2/Users': { summary: 'SCIM users', tag: 'scim', floor: 'scim' },
    },
    { version: '0.15.0', scopeFor: (url) => (url.startsWith('/v1/services') ? 'nd://scope/write/deploys' : null) },
  );

  it('is an OpenAPI 3.1 document with both security schemes', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'NineDeploy API', version: '0.15.0' });
    expect(doc.servers).toEqual([{ url: '/' }]);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['bearerAuth', 'scimBearer']);
  });

  it('lists exactly the live routes, specced or not', () => {
    expect(Object.keys(doc.paths).sort()).toEqual(
      ['/scim/v2/Users', '/v1/databases/{id}/studio-proxy/{wildcard}', '/v1/services/{id}/deploys', '/v1/terminals', '/v1/terminals/{id}/attach'].sort(),
    );
    const attach = doc.paths['/v1/terminals/{id}/attach']!['get']!;
    expect(attach['x-ninedeploy-undocumented']).toBe(true);
    expect(attach['x-ninedeploy-websocket']).toBe(true);
    expect(attach['x-ninedeploy-floor']).toBeNull();
    const proxy = doc.paths['/v1/databases/{id}/studio-proxy/{wildcard}']!['get']!;
    expect(proxy['x-ninedeploy-all-methods']).toBe(true);
  });

  it('renders a specced route: summary, floor, scope, query, body and response', () => {
    const list = doc.paths['/v1/terminals']!['get']!;
    expect(list).toMatchObject({ operationId: 'getV1Terminals', summary: 'List terminal sessions', tags: ['terminals'], security: [{ bearerAuth: [] }] });
    expect(list['x-ninedeploy-floor']).toBe('operator');
    expect(list['x-ninedeploy-scope']).toBeNull();
    expect(list['x-ninedeploy-undocumented']).toBeUndefined();
    expect(list.parameters).toEqual([
      { name: 'limit', in: 'query', required: false, schema: expect.objectContaining({ type: 'integer' }) },
      { name: 'status', in: 'query', required: true, schema: { type: 'string' } },
    ]);
    expect(list.responses['200']!.content!['application/json'].schema).toMatchObject({ type: 'object' });

    const deploy = doc.paths['/v1/services/{id}/deploys']!['post']!;
    expect(deploy.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }]);
    expect(deploy.requestBody!.content['application/json'].schema).toMatchObject({ type: 'object' });
    expect(deploy).toMatchObject({ description: 'Builds and releases.', deprecated: true });
    expect(deploy['x-ninedeploy-response-type']).toBe('Deployment');
    expect(deploy['x-ninedeploy-validation']).toBe('zod');
    expect(deploy['x-ninedeploy-scope']).toBe('nd://scope/write/deploys');

    expect(doc.paths['/scim/v2/Users']!['get']!.security).toEqual([{ scimBearer: [] }]);
  });

  it('keeps operation ids unique and defaults the scope to the auth plugin classifier', () => {
    const twice = buildOpenApiDocument([route('GET', '/v1/a-b'), route('GET', '/v1/a/b'), route('GET', '/v1/services/:id')], {}, { version: 'x', serverUrl: 'https://panel.example.com' });
    expect(twice.servers).toEqual([{ url: 'https://panel.example.com' }]);
    const ids = Object.values(twice.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(twice.paths['/v1/services/{id}']!['get']!['x-ninedeploy-scope']).toBe('nd://scope/read/services');
    expect(twice.paths['/v1/a-b']!['get']!.tags).toEqual(['a-b']);
  });
});

describe('ROUTE_SPECS aggregation', () => {
  it('starts with the three 0.15 fragments, all empty until their routes exist', () => {
    expect(Object.keys(SPEC_FRAGMENTS)).toEqual(expect.arrayContaining(['terminals', 'traffic', 'accessGrants']));
    expect(ROUTE_SPECS).toEqual(mergeSpecFragments(SPEC_FRAGMENTS));
  });

  it('refuses a key two fragments claim, and a malformed key', () => {
    const spec = { summary: 's', tag: 't', floor: 'operator' as const };
    expect(() => mergeSpecFragments({ a: { 'GET /v1/x': spec }, b: { 'GET /v1/x': spec } })).toThrow(/both "a" and "b"/);
    expect(() => mergeSpecFragments({ a: { 'get /v1/x': spec } })).toThrow(/malformed key/);
    expect(mergeSpecFragments({ a: { 'GET /v1/x': spec }, b: { 'POST /v1/x': spec } })).toEqual({ 'GET /v1/x': spec, 'POST /v1/x': spec });
  });
});
