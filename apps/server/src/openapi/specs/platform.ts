import { register } from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment: platform (routes that predate 0.15). Owner: task T4.
 * Floors mirror the authorization matrix (`test/authzMatrix.test.ts`, which
 * cross-checks every entry); bodies name the zod schema the handler parses.
 */
export const platformSpecs: RouteSpecMap = {
  'GET /health': {
    summary: 'Instance health (API and database)',
    tag: 'platform',
    floor: 'public',
    responseType: 'HealthStatus',
  },
  'GET /v1/about': {
    summary: 'Version, license and repository; instance counts when signed in',
    tag: 'platform',
    floor: 'public',
  },
  'POST /v1/setup': {
    summary: 'Create the first operator account (only while no user exists)',
    tag: 'platform',
    floor: 'public',
    body: register,
    responseType: 'Session',
    validation: 'zod',
    sensitive: true,
  },
  'GET /v1/openapi.json': {
    summary: 'This OpenAPI 3.1 document',
    tag: 'platform',
    description:
      'Generated from the live route table. Any session or coarse API token; fine-grained tokens are refused. Answers 304 to a matching If-None-Match; ?download=1 adds a Content-Disposition.',
    floor: 'authed',
    queryType: '{ download?: string }',
    validation: 'handler',
  },
  'GET /v1/events': {
    summary: 'Live event feed (WebSocket)',
    tag: 'platform',
    description: 'WebSocket. The bearer token travels in the `ninedeploy.bearer.<token>` subprotocol.',
    floor: 'authed',
    websocket: true,
  },
  'GET /scim/v2/Schemas': {
    summary: 'SCIM 2.0 schema discovery',
    tag: 'scim',
    floor: 'public',
  },
  'GET /scim/v2/ServiceProviderConfig': {
    summary: 'SCIM 2.0 service provider configuration',
    tag: 'scim',
    floor: 'public',
  },
  'GET /scim/v2/Users': {
    summary: "List SCIM users in the token's workspace",
    tag: 'scim',
    floor: 'scim',
    queryType: '{ filter?: string; startIndex?: string; count?: string }',
    validation: 'handler',
  },
  'POST /scim/v2/Users': {
    summary: 'Create or adopt a SCIM user',
    tag: 'scim',
    floor: 'scim',
    bodyType: 'ScimUserPayload',
    validation: 'handler',
  },
  'GET /scim/v2/Users/:id': {
    summary: 'Get a SCIM user',
    tag: 'scim',
    floor: 'scim',
  },
  'PUT /scim/v2/Users/:id': {
    summary: 'Replace a SCIM user',
    tag: 'scim',
    floor: 'scim',
    bodyType: 'ScimUserPayload',
    validation: 'handler',
  },
  'PATCH /scim/v2/Users/:id': {
    summary: 'Patch a SCIM user (for example, deactivate)',
    tag: 'scim',
    floor: 'scim',
    bodyType: '{ Operations?: Array<{ op?: unknown; path?: unknown; value?: unknown }> }',
    validation: 'handler',
  },
  'DELETE /scim/v2/Users/:id': {
    summary: 'Deprovision a SCIM user',
    tag: 'scim',
    floor: 'scim',
  },
};
