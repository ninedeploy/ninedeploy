import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment: deploys (routes that predate 0.15). Owner: task T4.
 * Floors mirror the authorization matrix (`test/authzMatrix.test.ts`, which
 * cross-checks every entry); bodies name the zod schema the handler parses.
 */
export const deploysSpecs: RouteSpecMap = {
  'GET /v1/services/queue': {
    summary: 'Every in-flight deployment the caller can see',
    tag: 'deploys',
    floor: 'authed',
    queryType: '{ status?: string }',
    validation: 'handler',
  },
  'GET /v1/services/:id/deploys': {
    summary: "List a service's deployments",
    tag: 'deploys',
    floor: 'viewer',
    responseType: 'Deployment[]',
  },
  'POST /v1/services/:id/deploys': {
    summary: 'Queue a deployment',
    tag: 'deploys',
    floor: 'member',
    responseType: '{ deploymentId: number; alreadyInProgress?: boolean }',
  },
  'DELETE /v1/services/:id/deploys/:depId': {
    summary: 'Remove a finished deployment and its build log',
    tag: 'deploys',
    floor: 'admin',
    responseType: '{ ok: boolean; id: number }',
  },
  'POST /v1/services/:id/deploys/:depId/cancel': {
    summary: 'Cancel a queued or in-flight deployment',
    tag: 'deploys',
    floor: 'member',
    responseType: '{ ok: boolean; status: string }',
  },
  'POST /v1/services/:id/deploys/:depId/rollback': {
    summary: 'Roll back to a previous deployment',
    tag: 'deploys',
    floor: 'member',
    responseType: '{ deploymentId: number }',
  },
  'GET /v1/services/:id/deploys/:depId/diff': {
    summary: 'Config diff between a deployment and the previous one',
    tag: 'deploys',
    floor: 'viewer',
  },
  'GET /v1/services/:id/deploys/:depId/logs': {
    summary: 'Live build log stream (WebSocket)',
    tag: 'deploys',
    description: 'WebSocket. The bearer token travels in the `ninedeploy.bearer.<token>` subprotocol.',
    floor: 'viewer',
    websocket: true,
  },
  'GET /v1/services/:id/deploys/:depId/logs/download': {
    summary: "Download a deployment's build log",
    tag: 'deploys',
    floor: 'viewer',
    sensitive: true,
  },
  'GET /v1/services/:id/exec': {
    summary: 'Interactive container shell (WebSocket)',
    tag: 'terminals',
    description: 'WebSocket. The bearer token travels in the `ninedeploy.bearer.<token>` subprotocol.',
    floor: 'operator',
    sensitive: true,
    websocket: true,
  },
  'POST /v1/services/:id/promote': {
    summary: "Deploy another service at this service's running commit",
    tag: 'deploys',
    floor: 'member',
    localBody: 'deploys.ts#promoteInput',
    responseType: '{ ok: boolean; deploymentId: number; commitSha: string; promotedFrom: string }',
    validation: 'zod',
  },
  'POST /v1/ai/services/:id/deploys/:depId/diagnose': {
    summary: 'AI diagnosis of a failed deployment',
    tag: 'ai',
    floor: 'operator',
    responseType: '{ diagnosis: string; model: string }',
  },
};
