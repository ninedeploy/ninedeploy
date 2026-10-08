import { z } from 'zod';
import { id } from './common.js';

// ── Project and environment access grants (0.15) ────────────────────────────
// Request and response shapes for `/v1/workspaces/:wid/access-grants`,
// `/v1/projects/:id/access` and `/v1/access/me`. Grants are raise-only (owner
// decision O5): a user's effective role on a resource is the higher of their
// seat role and any matching, non-suspended grant; `owner` is never grantable.
// The role cap (no higher than the granter's own role) and the workspace
// consistency checks are enforced by the server. Design: DESIGN.md §4.

/** Mirrors `accessGrantRole` in `@ninedeploy/db`. */
export const accessGrantRole = z.enum(['viewer', 'member', 'admin']);
export type AccessGrantRole = z.infer<typeof accessGrantRole>;

/**
 * The uniqueness key stored in `access_grants.target_key`: `p:<project>`,
 * `e:<environment>` or `pe:<project>:<environment>`. SQLite unique indexes
 * treat NULLs as distinct, so the pair alone could not be unique.
 */
export function accessGrantTargetKey(target: { projectId?: number | null; environmentId?: number | null }): string {
  const p = target.projectId ?? null;
  const e = target.environmentId ?? null;
  if (p !== null && e !== null) return `pe:${p}:${e}`;
  if (p !== null) return `p:${p}`;
  if (e !== null) return `e:${e}`;
  throw new Error('an access grant needs a project or an environment');
}

const hasTarget = (v: { projectId?: number | null; environmentId?: number | null }) =>
  v.projectId != null || v.environmentId != null;
const hasSubject = (v: { email?: string; userId?: number }) => (v.email === undefined) !== (v.userId === undefined);

/**
 * POST /v1/workspaces/:wid/access-grants (workspace admin). Name the user by
 * exactly one of `email` or `userId`, and target a project, an environment, or
 * both (services linked to the project AND in the environment).
 */
export const accessGrantCreate = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    userId: id.optional(),
    projectId: id.optional(),
    environmentId: id.optional(),
    role: accessGrantRole,
  })
  .strict()
  .refine(hasSubject, { message: 'name the user by exactly one of email or userId', path: ['email'] })
  .refine(hasTarget, { message: 'a grant needs a projectId, an environmentId, or both', path: ['projectId'] });
export type AccessGrantCreate = z.infer<typeof accessGrantCreate>;

/** PATCH /v1/workspaces/:wid/access-grants/:grantId: only the role changes. */
export const accessGrantUpdate = z.object({ role: accessGrantRole }).strict();
export type AccessGrantUpdate = z.infer<typeof accessGrantUpdate>;

/** GET /v1/workspaces/:wid/access-grants query. Query strings arrive as text. */
export const accessGrantListQuery = z
  .object({
    userId: z.coerce.number().int().positive().optional(),
    projectId: z.coerce.number().int().positive().optional(),
    environmentId: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type AccessGrantListQuery = z.infer<typeof accessGrantListQuery>;

const namedRef = z.object({ id, name: z.string() });

/** One grant as the workspace admin sees it. */
export const accessGrant = z.object({
  id,
  workspaceId: id,
  user: z.object({ id, email: z.string(), name: z.string() }),
  project: namedRef.nullable(),
  environment: namedRef.nullable(),
  role: accessGrantRole,
  suspended: z.boolean(),
  createdAt: z.string(),
  createdBy: z.object({ id, email: z.string() }).nullable(),
  /** The user has no seat in the grant's workspace: they see only what grants cover. */
  isGuest: z.boolean(),
});
export type AccessGrant = z.infer<typeof accessGrant>;

/** How a user reaches a project, as GET /v1/projects/:id/access explains it. */
export const projectAccessVia = z.enum(['operator', 'seat', 'grant', 'creator']);
export type ProjectAccessVia = z.infer<typeof projectAccessVia>;

/** GET /v1/projects/:id/access (project admin). */
export const projectAccessEntry = z.object({
  user: z.object({ id, email: z.string(), name: z.string() }),
  /** Effective role on the project (operators are `owner`). */
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  via: z.array(projectAccessVia).min(1),
});
export type ProjectAccessEntry = z.infer<typeof projectAccessEntry>;

/** GET /v1/access/me (self): the caller's own grants and guest workspaces. */
export const accessMe = z.object({
  grants: z.array(accessGrant),
  /** Workspaces the caller reaches only through grants (no seat). */
  guestWorkspaces: z.array(z.object({ id, name: z.string(), slug: z.string() })),
});
export type AccessMe = z.infer<typeof accessMe>;
