import { serviceFilePut } from '@ninedeploy/schemas';
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
  'GET /v1/services/approvals': {
    summary: 'Every deployment waiting for approval the caller can see',
    description:
      "0.16.13. Deploys into a lane that requires approval wait as `awaiting_approval` until an admin of the lane approves or rejects them. Oldest first; `mayReview` says whether this caller may decide. Kept out of `/queue`, whose status set older clients parse strictly.",
    tag: 'deploys',
    floor: 'authed',
    responseType: 'ApprovalsResponse',
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
      'The request body is the raw archive (application/zip or application/gzip, up to 100 MiB), not JSON. It is checked completely before it is kept: only regular files and directories, relative paths without `..`, at most 50 000 entries and 1 GiB extracted. A single top-level folder becomes the build root. `?deploy=false` only stores it. 409 for a service with a repository, image or inline stack. A service on a node (0.16.7) is built on the panel and its image shipped: 400 `remote_deploy_unsupported` when its build placement is the node or a build server, and a deploy is first checked against the node (422 `node_agent_outdated` when it cannot receive an image). Added in 0.16.1.',
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
    description:
      'The URL is the hook credential and carries the authority of the member it deploys as, so it is returned only to that member (`mine: true`); another member sees `enabled: true, url: null` and can rotate the hook to make it theirs. Added in 0.16.2.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null; mine: boolean }',
  },
  'POST /v1/services/:id/deploy-hook': {
    summary: 'Turn the deploy hook on, or rotate its URL',
    tag: 'deploys',
    description:
      'Mints a new token (the previous URL stops working). The hook will deploy as the caller, with every check a manual deploy makes re-done on each call and never with more operator authority than this request has. Audited service.deploy_hook.enable / rotate. Added in 0.16.2.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null; mine: boolean }',
  },
  'GET /v1/services/:id/files': {
    summary: "List a service's file mounts (path and size, no content)",
    tag: 'services',
    floor: 'viewer',
    responseType: 'ServiceFileEntry[]',
  },
  'GET /v1/services/:id/files/:fileId': {
    summary: 'Read one file mount with its content',
    tag: 'services',
    floor: 'member',
    responseType: 'ServiceFile',
    sensitive: true,
  },
  'PUT /v1/services/:id/files': {
    summary: 'Create or replace the file mounted read-only at a container path (applies on the next deploy)',
    description: 'Docker services on the panel host or a node (agent 0.16.5+), not Swarm, compose or PM2; at most 20 files of 256 KiB each, the path without ":".',
    tag: 'services',
    floor: 'member',
    body: serviceFilePut,
    responseType: 'ServiceFileEntry',
    validation: 'zod',
  },
  'DELETE /v1/services/:id/files/:fileId': {
    summary: 'Remove a file mount (applies on the next deploy)',
    tag: 'services',
    floor: 'member',
    responseType: '{ ok: boolean }',
  },
  'DELETE /v1/services/:id/deploy-hook': {
    summary: 'Turn the deploy hook off',
    tag: 'deploys',
    description: 'The hook URL answers 404 from now on. Audited service.deploy_hook.disable. Added in 0.16.2.',
    floor: 'member',
    responseType: '{ enabled: boolean; url: string | null; mine: boolean }',
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
  'POST /v1/services/:id/sleep': {
    summary: 'Put a service to sleep now (scale to zero)',
    description:
      "0.16.11. Routes the service's domains to the wake endpoint, then stops its containers; the next request through a domain wakes it. `400 cannot_sleep` names why not (not a running docker service on the panel host, or no routed domain). Works without `sleepAfterMinutes`.",
    tag: 'services',
    floor: 'member',
    responseType: '{ ok: boolean; asleep: boolean }',
  },
  'POST /v1/services/:id/wake': {
    summary: 'Wake a sleeping service',
    description:
      '0.16.11. Starts its containers, waits for the healthcheck and routes its domains back. `400 not_asleep` when it is awake, `409 wake_failed` when it would not start or pass the healthcheck (it stays asleep). Start and restart wake a sleeping service the same way.',
    tag: 'services',
    floor: 'member',
    responseType: '{ ok: boolean; status: string }',
  },
  'GET /v1/services/:id/autoscale': {
    summary: 'What the autoscaler sees for a service',
    description:
      '0.16.10. `enabled: false` without an autoscale configuration. Otherwise the containers serving now (`replicas`), the bounds, the metric and target, the last value per container, the count it asks for (`desired`), why the autoscaler holds (`holding`: a deploy or canary in progress, no traffic analytics for `rps`, a node or Swarm service, spares not created yet) and the last scaling event.',
    tag: 'services',
    floor: 'viewer',
    responseType: 'AutoscaleStatusView',
  },
  'GET /v1/services/:id/canary': {
    summary: "The canary of a service's deploy in progress",
    description:
      "0.16.9. `active: false` when no canary runs. Otherwise the step, the new release's share of the requests (`weight`, percent), when the step ends, and the step's requests, 5xx rate and p95 for the new release (`canary`) and the previous one (`stable`). `measured: false` means traffic analytics is off and steps are judged on the healthcheck only.",
    tag: 'deploys',
    floor: 'viewer',
    responseType: 'CanaryStatusView',
  },
  'POST /v1/services/:id/deploys/:depId/approve': {
    summary: 'Approve a deployment waiting for approval',
    description:
      "0.16.13. `awaiting_approval` → `queued`; the worker then builds it as usual. Needs an admin of the service's lane: an admin or owner seat in the lane's workspace, an admin grant, or an operator (being the service's creator is not enough). `400 not_awaiting_approval` for a deploy that is not waiting. Still works after the lane's switch is turned off.",
    tag: 'deploys',
    floor: 'admin',
    responseType: "{ ok: true; status: 'queued' }",
  },
  'POST /v1/services/:id/deploys/:depId/reject': {
    summary: 'Reject a deployment waiting for approval',
    description:
      "0.16.13. `awaiting_approval` → `cancelled`; it will not run. Same rules as approve. The deploy's author can instead withdraw it with the cancel route.",
    tag: 'deploys',
    floor: 'admin',
    responseType: "{ ok: true; status: 'cancelled' }",
  },
  'POST /v1/services/:id/deploys/:depId/canary/promote': {
    summary: 'Promote a canary: switch all traffic to the new release now',
    description:
      '0.16.9. Skips the remaining canary steps; the deploy then finishes as usual. `400 no_canary` when the deployment has no canary in progress. To stop a canary instead, cancel the deployment: all traffic goes back to the previous release.',
    tag: 'deploys',
    floor: 'member',
    responseType: '{ ok: boolean }',
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
    description:
      '`diagnosis` is always the readable text. 0.16.16: when the model answers in the structured form, `parts` holds the root cause, the quoted evidence and the steps, and `proposal` what it proposes to change: `settings` (port, health path, build pack, base directory, install/build/start command, Dockerfile path; only values that differ from the service) and `files` (up to five exact find/replace edits). Apply a settings proposal with `PATCH /v1/services/:id`, whose rules all apply; nothing is changed by this route.',
    tag: 'ai',
    floor: 'operator',
    responseType: 'AiDiagnosisResult',
  },
  'POST /v1/ai/services/:id/logs/analyze': {
    summary: "AI analysis of a running service's recent runtime logs",
    description:
      "0.16.15. Reads the newest `tail` lines (20-5000, default 300), sanitizes them like a diagnosis and sends the tail to the configured provider. Answers the model's analysis (health, problems with the quoted lines, next steps), the model and how many lines it saw. Needs `member` on the service, a protected lane's logs need its admin, and the AI spend rule applies. `400 not_running` for a service with no runtime, `400 no_logs` when it wrote nothing.",
    tag: 'ai',
    floor: 'operator',
    localBody: 'ai.ts#analyzeLogsBody',
    responseType: 'RuntimeLogAnalysis',
    validation: 'zod',
  },
};
