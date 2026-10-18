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
  'GET /v1/services/:id/source': {
    summary: 'List the uploaded source archives a service keeps',
    tag: 'deploys',
    description: 'The last five uploads, newest first. `uploadSourced` says whether the service takes uploads (a docker service with no repository, image or inline stack). Added in 0.16.1.',
    floor: 'viewer',
    responseType:
      "{ uploadSourced: boolean; maxBytes: number; uploads: Array<{ sha: string; format: 'zip' | 'tar.gz'; bytes: number; uploadedAt: string }> }",
  },
  'POST /v1/services/:id/source': {
    summary: 'Upload a .zip or .tar.gz as the service source and deploy it',
    tag: 'deploys',
    description:
      'The request body is the raw archive (application/zip or application/gzip, up to 100 MiB), not JSON. It is checked completely before it is kept: only regular files and directories, relative paths without `..`, at most 50 000 entries and 1 GiB extracted. A single top-level folder becomes the build root. `?deploy=false` only stores it. 409 for a service with a repository, image or inline stack. Added in 0.16.1.',
    floor: 'member',
    responseType:
      "{ sha: string; format: 'zip' | 'tar.gz'; bytes: number; uploadedAt: string; entries: number; deploymentId: number | null }",
  },
  'GET /v1/services/:id/badge': {
    summary: 'Whether the status badge is on, and its public URL',
    tag: 'deploys',
    description: 'The URL is the badge credential, so reading it takes a member seat. Added in 0.16.1.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null }',
  },
  'POST /v1/services/:id/badge': {
    summary: 'Turn the status badge on, or rotate its URL',
    tag: 'deploys',
    description: 'Mints a new token; a previous badge URL stops working. Audited service.badge.enable / service.badge.rotate. Added in 0.16.1.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null }',
  },
  'DELETE /v1/services/:id/badge': {
    summary: 'Turn the status badge off',
    tag: 'deploys',
    description: 'The badge URL answers 404 from now on. Audited service.badge.disable. Added in 0.16.1.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null }',
  },
  'GET /v1/services/:id/host-addresses': {
    summary: 'The panel host IPs a port mapping can be bound to',
    tag: 'deploys',
    description:
      'Global-scope addresses of the panel host (loopback, link-local and Docker bridges left out), read with `ip -o addr` in a host-network container and cached for a minute. `detected: false` when the host could not be asked; a node service gets none, since port mappings are published on the panel host only. Added in 0.16.1.',
    floor: 'member',
    responseType: '{ detected: boolean; addresses: Array<{ ip: string; family: 4 | 6; iface: string }> }',
  },
  'GET /v1/services/:id/deploy-hook': {
    summary: 'Whether the deploy hook is on, and its secret URL',
    tag: 'deploys',
    description: 'The URL is the hook credential, so reading it takes a member seat. Added in 0.16.2.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null }',
  },
  'POST /v1/services/:id/deploy-hook': {
    summary: 'Turn the deploy hook on, or rotate its URL',
    tag: 'deploys',
    description:
      'Mints a new token (the previous URL stops working). The hook will deploy as the caller, with every check a manual deploy makes re-done on each call and never with more operator authority than this request has. Audited service.deploy_hook.enable / rotate. Added in 0.16.2.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null }',
  },
  'DELETE /v1/services/:id/deploy-hook': {
    summary: 'Turn the deploy hook off',
    tag: 'deploys',
    description: 'The hook URL answers 404 from now on. Audited service.deploy_hook.disable. Added in 0.16.2.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null }',
  },
  'POST /v1/deploy-hooks/:token': {
    summary: 'Redeploy a service from CI (deploy hook)',
    tag: 'deploys',
    description:
      'No session: the token in the path is the credential. Queues a deploy as the member who made the hook and answers 202 `{ deploymentId }`, or the running deployment with `alreadyInProgress: true`. 404 for an unknown token or a hook whose creator was deleted; 403 when that member lost the service. Audited deploy.trigger (via deploy_hook). Added in 0.16.2.',
    floor: 'token',
    responseType: '{ deploymentId: number; alreadyInProgress?: boolean }',
  },
  'GET /v1/badges/:badge': {
    summary: 'A deploy status badge (SVG) for a README',
    tag: 'deploys',
    description:
      '`:badge` is `<token>.svg`; the token is the credential (no session). The badge reads running, deploying, failed, stopped or not deployed, and nothing else about the service. `?label=` replaces the "deploy" label (letters, digits, spaces and `._-`, up to 32). An unknown token answers 404 with a "not found" badge. Added in 0.16.1.',
    floor: 'token',
    responseType: 'string (image/svg+xml)',
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
