import { monitorCreate, monitorPatch, statusPageCreate, statusPagePatch } from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/** 0.16.8 uptime monitors and status pages (docs/UPTIME.md). */
export const uptimeSpecs: RouteSpecMap = {
  'GET /v1/monitors': {
    summary: 'List uptime monitors',
    tag: 'monitors',
    description:
      'Operators see every monitor; anyone else sees the monitors of the services they can see (an operator-only monitor has no service). `?serviceId=` narrows to one service. Each carries its state, last check and 24-hour, 7-day and 30-day uptime. Added in 0.16.8.',
    floor: 'authed',
    responseType: 'MonitorView[]',
    mcp: { name: 'list_monitors', description: 'List uptime monitors with their state and uptime.', readOnly: true },
  },
  'GET /v1/monitors/:id': {
    summary: 'Get an uptime monitor',
    tag: 'monitors',
    description: '404 for a monitor the caller cannot see. Added in 0.16.8.',
    floor: 'authed',
    responseType: 'MonitorView',
  },
  'GET /v1/monitors/:id/checks': {
    summary: "A monitor's recent checks",
    tag: 'monitors',
    description: 'Newest first, for the last `?hours=` (1–168, default 24); raw checks are kept 7 days. Added in 0.16.8.',
    floor: 'authed',
    responseType: 'MonitorCheckView[]',
  },
  'POST /v1/monitors': {
    summary: 'Create an uptime monitor',
    tag: 'monitors',
    description:
      'An HTTP(S) check (status codes, optional keyword in the first 1 MiB of the body) or a TCP connect, run from the panel host every `intervalSeconds` (30–3600). It goes down after `failuresBeforeDown` failed checks in a row and up after one success; each transition is an `alert.monitor_down` / `alert.monitor_up` notification. Added in 0.16.8.',
    floor: 'operator',
    body: monitorCreate,
    validation: 'zod',
    responseType: 'MonitorView',
  },
  'PATCH /v1/monitors/:id': {
    summary: 'Update an uptime monitor',
    tag: 'monitors',
    description: 'Partial. Turning it off pauses it; changing the target or kind starts it over (pending). Added in 0.16.8.',
    floor: 'operator',
    body: monitorPatch,
    validation: 'zod',
    responseType: 'MonitorView',
  },
  'DELETE /v1/monitors/:id': {
    summary: 'Delete an uptime monitor',
    tag: 'monitors',
    description: 'Its checks and history go with it. Added in 0.16.8.',
    floor: 'operator',
  },
  'POST /v1/monitors/:id/check': {
    summary: 'Check a monitor now',
    tag: 'monitors',
    description: 'Runs one check and records it like a scheduled one (state, history, notifications). Added in 0.16.8.',
    floor: 'operator',
    responseType: '{ check: MonitorCheckView; monitor: MonitorView }',
  },
  'GET /v1/status-pages': {
    summary: 'List status pages',
    tag: 'monitors',
    description: 'Added in 0.16.8.',
    floor: 'operator',
    responseType: 'StatusPageView[]',
  },
  'GET /v1/status-pages/:id': {
    summary: 'Get a status page',
    tag: 'monitors',
    description: 'Added in 0.16.8.',
    floor: 'operator',
    responseType: 'StatusPageView',
  },
  'POST /v1/status-pages': {
    summary: 'Create a status page',
    tag: 'monitors',
    description:
      'A public page at `/status/<slug>` listing the chosen monitors by name with their state and 90-day history; the target is never shown. It answers 404 until `published` is true. 409 when the slug is taken. Added in 0.16.8.',
    floor: 'operator',
    body: statusPageCreate,
    validation: 'zod',
    responseType: 'StatusPageView',
  },
  'PATCH /v1/status-pages/:id': {
    summary: 'Update a status page',
    tag: 'monitors',
    description: 'Partial; `notice` shows a message (maintenance, an incident) at the top. Added in 0.16.8.',
    floor: 'operator',
    body: statusPagePatch,
    validation: 'zod',
    responseType: 'StatusPageView',
  },
  'DELETE /v1/status-pages/:id': {
    summary: 'Delete a status page',
    tag: 'monitors',
    description: 'Added in 0.16.8.',
    floor: 'operator',
  },
  'GET /v1/status/:slug': {
    summary: 'A published status page (JSON)',
    tag: 'monitors',
    description:
      'No session. Monitor names, states, 90-day uptime and daily history, and the average response time unless the page hides it. Cached for 30 s. 404 for an unknown or unpublished slug alike. Added in 0.16.8.',
    floor: 'public',
    responseType: 'PublicStatusPage',
  },
  'GET /status/:slug': {
    summary: 'A published status page (HTML)',
    tag: 'monitors',
    description: 'The same page as `GET /v1/status/:slug`, as a self-contained HTML document that refreshes every 60 s. Added in 0.16.8.',
    floor: 'public',
    responseType: 'string (text/html)',
  },
  // 0.16.11 scale to zero (modules/wake.ts). Not called directly: Traefik
  // sends a sleeping service's requests here, with the visitor's Host header.
  'ALL /_nd/wake': {
    summary: 'Wake endpoint for a sleeping service (Traefik only)',
    tag: 'services',
    description:
      "No session. Traefik routes a sleeping service's domains here with the path prefixed by `/_nd/wake`. The service is found by the Host header and the path. GET and HEAD wait up to 25 s for the wake, then `307` to the same URL; other methods get `503` with `Retry-After`. A slower wake answers a self-reloading `503` page. `404` for a host no domain routes. Added in 0.16.11.",
    floor: 'public',
  },
  'ALL /_nd/wake/*': {
    summary: 'Wake endpoint for a sleeping service (Traefik only)',
    tag: 'services',
    description: 'The same as `/_nd/wake`, for every path below it.',
    floor: 'public',
  },
  // G2.2 (modules/maintenance.ts). Traefik only, with the visitor's Host header.
  'ALL /_nd/maintenance/:serviceId': {
    summary: 'Maintenance page of a service (Traefik only)',
    tag: 'services',
    description:
      "No session. A service in maintenance has its domains routed here (`addPrefix`). Answers `503` with `Retry-After` and the service's title and message, as HTML for a browser and text otherwise. `404` unless the Host header is one of the service's active domains (never the panel's own). G2.2.",
    floor: 'public',
  },
  'ALL /_nd/maintenance/:serviceId/*': {
    summary: 'Maintenance page of a service (Traefik only)',
    tag: 'services',
    description: 'The same as `/_nd/maintenance/:serviceId`, for every path below it.',
    floor: 'public',
  },
  'ALL /_nd/errors/:serviceId/:status': {
    summary: 'Custom error page of a service (Traefik only)',
    tag: 'services',
    description:
      "No session. Traefik's `errors` middleware fetches the page here when the app answers 502, 503 or 504. Answers that status with the service's custom HTML, or a plain default page. `404` unless the Host header is one of the service's active domains (never the panel's own). G2.2.",
    floor: 'public',
  },
};
