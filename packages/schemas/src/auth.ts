import { z } from 'zod';

export const register = z.object({
  email: z.email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100).optional(),
});
export type Register = z.infer<typeof register>;

/** Initial bootstrap — same shape as register, only works when no users exist. */
export const setup = register;
export type Setup = Register;

export const login = z.object({
  email: z.email(),
  password: z.string().min(1),
  /** Required when the account has 2FA enabled. */
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type Login = z.infer<typeof login>;

/** Verifying a two-factor action (enable / disable companion). */
export const twoFactorCode = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TwoFactorCode = z.infer<typeof twoFactorCode>;

/** Regenerating the 2FA secret: password required when 2FA is already enabled. */
export const twoFactorSetup = z.object({ password: z.string().min(1) });
export type TwoFactorSetup = z.infer<typeof twoFactorSetup>;

export const twoFactorDisable = z.object({
  password: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});
export type TwoFactorDisable = z.infer<typeof twoFactorDisable>;

/** Self-service password change: requires the current password. */
export const passwordChange = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});
export type PasswordChange = z.infer<typeof passwordChange>;

/** Admin-initiated password reset for another user. */
/**
 * Admin-created user — same shape as register, no global role.
 * A new user has no workspace memberships until an existing owner/admin
 * invites them; the first user on a fresh install is auto-promoted to owner
 * of a personal workspace by the auth module.
 */
export const userCreate = z.object({
  email: z.email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100).optional(),
});
export type UserCreate = z.infer<typeof userCreate>;

export const passwordReset = z.object({
  newPassword: z.string().min(8).max(128),
});
export type PasswordReset = z.infer<typeof passwordReset>;

/**
 * API-token scopes.
 *
 * Until 0.3.5 the `api_tokens.scopes` column existed but was never written
 * (always `[]`) and never read, so every token carried its owner's FULL
 * authority — including the instance-operator flag, which gates host-privileged
 * deploys. A CI or MCP token was therefore an instance-root credential.
 *
 * The vocabulary is deliberately tiny and method-based, so it can be enforced
 * in one place (`plugins/auth.ts`) instead of being annotated onto 51 route
 * modules:
 *
 *   read      → safe methods only (GET / HEAD / OPTIONS)
 *   write     → every method, but the request runs as a NON-operator even if
 *               the owner is one
 *   operator  → no restriction beyond the owner's own authority
 *
 * An EMPTY scope list means "unrestricted" and is what every pre-0.3.5 token
 * has. That is deliberate back-compat: silently downgrading tokens already
 * deployed in someone's CI would break their pipeline on upgrade. New tokens
 * should always be created with an explicit scope.
 */
// ── API-token scopes (G-08 fine-grained) ──────────────────────────────────
// The pre-0.3.5 enum (`read` | `write` | `operator`) was a coarse
// binary/ternary. G-08 adds per-resource URI scopes
// (`nd://scope/{read,write,admin}/<resource>`) so an MCP / CI token
// can be limited to, say, `nd://scope/read/services +
// nd://scope/read/databases` and nothing else.
//
// The two forms are accepted in the same array; the old enum
// continues to be a valid shorthand (a `write` token expands to
// "any write" at the auth plugin, which is the pre-0.3.5
// behaviour for backwards compat).
const LEGACY_SCOPE = z.enum(['read', 'write', 'operator']);
const RESOURCE_SCOPE = z.string().regex(
  /^nd:\/\/scope\/(read|write|admin)\/[a-z][a-z0-9_]{0,63}$/,
  'expected nd://scope/{read,write,admin}/<resource>',
);
export const apiTokenScope = z.union([LEGACY_SCOPE, RESOURCE_SCOPE]);
export type ApiTokenScope = z.infer<typeof apiTokenScope>;

/** All known resource names. The auth plugin checks these
 *  literally — adding a new resource is a one-line change
 *  in the auth plugin's resource map. Listed here so the
 *  CLI can suggest completions and the Zod regex can
 *  cross-check. */
export const KNOWN_SCOPE_RESOURCES = [
  'services',
  'databases',
  'domains',
  'deploys',
  'alerts',
  'webhooks',
  'env',
  'backups',
  'volumes',
  'projects',
  'users',
  'tokens',
  'notifications',
  'config',
  'topology',
  'health',
  'settings',
  'manifests',
  'domains_transfer',
  'backup_drill',
  'images',
  'audit',
  'firewall',
  'sso',
  'egress',
  'orchestrators',
  'housekeeping',
] as const;
export type ScopeResource = (typeof KNOWN_SCOPE_RESOURCES)[number];

/**
 * Grant or revoke the INSTANCE-operator flag (`PATCH /v1/users/:id/operator`).
 *
 * This is not a workspace role. It gates the operator-only routes and the
 * host-privilege boundary (PM2/compose deploys, lifecycle hooks, docker-socket
 * templates), so it can only be changed by an existing operator, and the last
 * one cannot revoke itself.
 */
export const operatorGrant = z.object({
  isOperator: z.boolean(),
});
export type OperatorGrant = z.infer<typeof operatorGrant>;

/** Forgot-password request. Always answers 200 (no user enumeration). */
export const forgotPassword = z.object({
  email: z.email(),
});
export type ForgotPassword = z.infer<typeof forgotPassword>;

/** Complete a reset with the token from the email / admin-issued link. */
export const passwordResetWithToken = z.object({
  token: z.string().min(20).max(128),
  newPassword: z.string().min(8).max(128),
});
export type PasswordResetWithToken = z.infer<typeof passwordResetWithToken>;

/** Tokens issued after a successful login/refresh. */
export const tokenPair = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof tokenPair>;

export const refresh = z.object({
  refreshToken: z.string().min(1),
});
export type Refresh = z.infer<typeof refresh>;

/**
 * Public user representation (never includes passwordHash).
 * The legacy global `role` field was removed; authorization is per-workspace
 * now. The effective "is operator" check is computed by joining
 * `workspace_members` and asking whether the user holds owner/admin in any
 * workspace.
 */
export const publicUser = z.object({
  id: z.number().int(),
  email: z.email(),
  name: z.string().nullable(),
  /** True iff the user holds owner/admin in at least one workspace. */
  isOperator: z.boolean(),
  /** Number of workspaces the user belongs to. Computed by the server. */
  workspaceCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type PublicUser = z.infer<typeof publicUser>;

export const session = z.object({
  user: publicUser,
  tokens: tokenPair,
});
export type Session = z.infer<typeof session>;

// ── API tokens (for the CLI / CI) ─────────────────────────────────────────
export const createApiToken = z.object({
  // Lenient on purpose: this endpoint historically accepted any string, sliced
  // it to 100 chars and fell back to "cli" when empty. Rejecting outright would
  // break CLI/CI callers on upgrade.
  name: z
    .string()
    .optional()
    .transform((v) => (v ?? '').slice(0, 100) || 'cli'),
  /**
   * Defaults to `['read']` — a NEW token without explicit scopes is a
   * read-only token, not an unrestricted one. The unrestricted meaning of an
   * EMPTY list survives only for legacy rows created before 0.3.5 (the
   * resolver still maps `[]` → unrestricted); new tokens are never handed
   * their owner's full authority by default.
   */
  scopes: z.array(apiTokenScope).max(3).default(['read']),
  /**
   * Defaults to a one-year lifetime. A standing credential that never expires
   * was the pre-0.3.5 behaviour and is what made a leaked CI token
   * effectively permanent; an operator who wants that must now say so
   * explicitly (3650).
   */
  expiresInDays: z.number().int().min(1).max(3650).default(365),
});
/** Parsed shape (post-defaults) — what the route handler works with. */
export type CreateApiToken = z.infer<typeof createApiToken>;
/**
 * Caller-facing shape: `name` and `scopes` are optional on the wire and filled
 * in by the schema's defaults. The SDK takes this so `tokens.create()` and
 * `tokens.create({ name: 'ci' })` both stay valid.
 */
export type CreateApiTokenInput = z.input<typeof createApiToken>;

export const apiToken = z.object({
  id: z.number().int(),
  name: z.string(),
  /** Empty array = a legacy, unrestricted token. The UI should flag those. */
  scopes: z.array(z.string()),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ApiToken = z.infer<typeof apiToken>;

/** Returned once at creation time — the raw token is never retrievable again. */
export const createdApiToken = z.object({
  id: z.number().int(),
  name: z.string(),
  token: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type CreatedApiToken = z.infer<typeof createdApiToken>;

// ── passkeys (WebAuthn) ────────────────────────────────────────────────────
/** Registration verification: label for the new credential + the browser's response payload. */
export const passkeyRegisterVerify = z.object({
  name: z.string().min(1).max(100),
  response: z.record(z.string(), z.unknown()),
});
export type PasskeyRegisterVerify = z.infer<typeof passkeyRegisterVerify>;

/** Login verification: just the browser's authentication response (discoverable credentials). */
export const passkeyLoginVerify = z.object({
  response: z.record(z.string(), z.unknown()),
});
export type PasskeyLoginVerify = z.infer<typeof passkeyLoginVerify>;

export const passkeyCredential = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.string().datetime(),
});
export type PasskeyCredential = z.infer<typeof passkeyCredential>;

// ── sessions (refresh-token backing store) ─────────────────────────────────
export const activeSession = z.object({
  id: z.number().int(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  current: z.boolean(),
});
export type ActiveSession = z.infer<typeof activeSession>;

