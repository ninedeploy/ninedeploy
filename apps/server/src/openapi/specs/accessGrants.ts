import { z } from 'zod';
import {
  accessGrant,
  accessGrantCreate,
  accessGrantListQuery,
  accessGrantUpdate,
  accessMe,
  projectAccessEntry,
} from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment for `/v1/workspaces/:wid/access-grants`,
 * `GET /v1/projects/:id/access` and `GET /v1/access/me` (0.15). Owner: task
 * T5. Every key names a live route (authzMatrix `ROUTE_SPECS` coverage case)
 * and its floor equals the route's MATRIX floor.
 */
const RAISE_ONLY =
  'Grants are raise-only: a user’s role on a covered resource is the higher of their workspace seat and their grants; a grant never lowers a seat and `owner` is never grantable.';

export const accessGrantSpecs: RouteSpecMap = {
  'GET /v1/workspaces/:wid/access-grants': {
    summary: 'List access grants in a workspace',
    tag: 'workspaces',
    description: `Workspace admins and operators. Optional filters narrow by user, project or environment. ${RAISE_ONLY}`,
    floor: 'admin',
    query: accessGrantListQuery,
    response: z.array(accessGrant),
    validation: 'zod',
  },
  'POST /v1/workspaces/:wid/access-grants': {
    summary: 'Grant a user access to a project or environment',
    tag: 'workspaces',
    description:
      'Name the user by `email` or `userId` and target a project, an environment, or both. 201 with the grant. ' +
      'An account the caller cannot already see (or an unknown email) gets 404; a duplicate target 409; a role above the caller’s own (capped at admin) 403 `grant_exceeds_role`. ' +
      RAISE_ONLY,
    floor: 'admin',
    body: accessGrantCreate,
    response: accessGrant,
    validation: 'zod',
  },
  'PATCH /v1/workspaces/:wid/access-grants/:grantId': {
    summary: 'Change an access grant’s role',
    tag: 'workspaces',
    floor: 'admin',
    body: accessGrantUpdate,
    response: accessGrant,
    validation: 'zod',
  },
  'DELETE /v1/workspaces/:wid/access-grants/:grantId': {
    summary: 'Revoke an access grant',
    tag: 'workspaces',
    floor: 'admin',
    response: z.object({ ok: z.literal(true) }),
  },
  'GET /v1/projects/:id/access': {
    summary: 'Who can reach a project, and how',
    tag: 'projects',
    description: 'Project admins (a workspace admin seat or an admin project grant) and operators. `via` names each path: operator, seat, grant.',
    floor: 'admin',
    response: z.array(projectAccessEntry),
  },
  'GET /v1/access/me': {
    summary: 'My access grants and guest workspaces',
    tag: 'workspaces',
    description: 'The caller’s own grants, and the workspaces they reach only through grants (no seat).',
    floor: 'self',
    response: accessMe,
  },
};
