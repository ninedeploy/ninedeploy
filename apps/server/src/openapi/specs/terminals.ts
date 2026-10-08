import {
  createTerminalSession,
  terminalSession,
  terminalSessionCreated,
  terminalSessionList,
  terminalSessionListQuery,
  terminalSettings,
  terminalSettingsView,
  terminalTerminateResult,
} from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment for `/v1/terminals` (0.15). Owner: task T2a (T2b for
 * node-target additions). Every key names a live route (authzMatrix
 * `ROUTE_SPECS` coverage case); every route is operator-only.
 */
export const terminalSpecs: RouteSpecMap = {
  'POST /v1/terminals': {
    summary: 'Open a terminal session',
    tag: 'terminals',
    description:
      'Resolves and authorises the target, then answers 201 with a single-use ticket (valid 30s) for GET /v1/terminals/{id}/attach. ' +
      'Host shells are off by default and additionally need an interactive session, a password re-check (`password`) and no NINEDEPLOY_HOST_TERMINAL=off.',
    floor: 'operator',
    body: createTerminalSession,
    response: terminalSessionCreated,
    validation: 'zod',
    // The answer carries a ticket: a short-lived credential.
    sensitive: true,
  },
  'GET /v1/terminals': {
    summary: 'Terminal session history',
    tag: 'terminals',
    description: 'Newest first; metadata only (no transcript is ever recorded).',
    floor: 'operator',
    query: terminalSessionListQuery,
    response: terminalSessionList,
    validation: 'zod',
  },
  'GET /v1/terminals/settings': {
    summary: 'Terminal settings',
    tag: 'terminals',
    floor: 'operator',
    response: terminalSettingsView,
  },
  'PUT /v1/terminals/settings': {
    summary: 'Change terminal settings',
    tag: 'terminals',
    description: 'Partial. Turning host shells on needs an interactive session and step-up (`password`, or a sign-in under 10 minutes old).',
    floor: 'operator',
    body: terminalSettings,
    response: terminalSettingsView,
    validation: 'zod',
  },
  'GET /v1/terminals/:id': {
    summary: 'One terminal session',
    tag: 'terminals',
    floor: 'operator',
    response: terminalSession,
  },
  'DELETE /v1/terminals/:id': {
    summary: 'Terminate a terminal session',
    tag: 'terminals',
    description: 'Closes a live session (WebSocket close 4410) or revokes a pending ticket.',
    floor: 'operator',
    response: terminalTerminateResult,
  },
  'GET /v1/terminals/:id/attach': {
    summary: 'Attach to a terminal session (WebSocket, protocol ninedeploy.terminal.v1)',
    tag: 'terminals',
    description:
      "Offer the subprotocols ['ninedeploy.terminal.v1', 'ninedeploy.ticket.<ticket>']. Binary frames carry stdin/output; " +
      'text frames carry JSON control messages (client: resize, ping; server: ready, notice, exit). Frames over 64 KiB close 1009. ' +
      'Send nothing before the `ready` message.',
    floor: 'operator',
    websocket: true,
  },
};
