import { and, eq, inArray, like } from 'drizzle-orm';
import { settings, users, webauthnCredentials, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import type { SessionAuthMethod } from './sessionMethod.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G1.4 workspace-enforced 2FA. A workspace admin can require two-factor
 * authentication of every member. What counts is what the SESSION proved, not
 * which credentials the account holds: a session signed in with TOTP, a
 * recovery code or a passkey carries `amr: mfa`. Any other session of a
 * member answers only the enrolment routes (see `isEnrolmentRoute`); every
 * other route is 403 `two_factor_required`. A member who just set up TOTP or
 * a passkey signs in again with it.
 *
 * Sessions from an SSO provider the workspace lists (`ssoExemptProviders`,
 * `oidc:<id>` or `sso:<id>`) are exempt, for an IdP that enforces MFA itself.
 * GitHub sign-ins carry no provider and are never exempt.
 *
 * Scope: interactive sessions. API tokens a member already holds keep
 * working; a held session cannot mint new ones.
 *
 * No migration: one settings row per workspace, `workspace_2fa:<id>`.
 */

const PREFIX = 'workspace_2fa:';
const key = (workspaceId: number) => `${PREFIX}${workspaceId}`;
const PROVIDER_RE = /^(oidc|sso):\d{1,10}$/;

export interface WorkspaceTwoFactorPolicy {
  required: boolean;
  /** SSO providers whose sessions do not need panel 2FA. */
  ssoExemptProviders: string[];
}

function normalize(v: unknown): WorkspaceTwoFactorPolicy {
  let raw = v;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const o = raw && typeof raw === 'object' ? (raw as Partial<WorkspaceTwoFactorPolicy>) : {};
  const providers = Array.isArray(o.ssoExemptProviders) ? o.ssoExemptProviders.filter((p): p is string => typeof p === 'string' && PROVIDER_RE.test(p)) : [];
  return { required: o.required === true, ssoExemptProviders: providers };
}

/** Every workspace's policy, cached briefly: it is read on each authenticated request. */
let cache: { at: number; policies: Map<number, WorkspaceTwoFactorPolicy> } | null = null;
const CACHE_MS = 15_000;

export function resetTwoFactorPolicyCache(): void {
  cache = null;
}

async function policies(db: DB): Promise<Map<number, WorkspaceTwoFactorPolicy>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.policies;
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(like(settings.key, `${PREFIX}%`));
  const map = new Map<number, WorkspaceTwoFactorPolicy>();
  for (const row of rows) {
    const id = Number(row.key.slice(PREFIX.length));
    const policy = normalize(row.value);
    if (Number.isInteger(id) && id > 0 && policy.required) map.set(id, policy);
  }
  cache = { at: Date.now(), policies: map };
  return map;
}

export async function getWorkspaceTwoFactor(db: DB, workspaceId: number): Promise<WorkspaceTwoFactorPolicy> {
  return normalize(await getSettingJson<unknown>(db, key(workspaceId), null));
}

export async function setWorkspaceTwoFactor(db: DB, workspaceId: number, policy: WorkspaceTwoFactorPolicy): Promise<void> {
  if (!policy.required) await db.delete(settings).where(eq(settings.key, key(workspaceId)));
  else await setSettingJson(db, key(workspaceId), normalize(policy));
  resetTwoFactorPolicyCache();
}

export interface TwoFactorRequirement {
  /** A workspace the user belongs to requires 2FA of this session. */
  required: boolean;
  /** The account has TOTP or a passkey. */
  enrolled: boolean;
  /** This session proved a second factor when it signed in. */
  verified: boolean;
  /** The workspaces that require it. */
  workspaces: Array<{ id: number; name: string }>;
}

/** Whether the account holds TOTP or a passkey. */
export async function hasSecondFactor(db: DB, userId: number): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { totpEnabled: true } });
  if (user?.totpEnabled) return true;
  return !!(await db.query.webauthnCredentials.findFirst({ where: eq(webauthnCredentials.userId, userId), columns: { id: true } }));
}

/** What the workspace policies ask of this session. Cheap when no workspace requires 2FA. */
export async function twoFactorRequirement(db: DB, userId: number, method: SessionAuthMethod): Promise<TwoFactorRequirement> {
  const verified = method.amr === 'mfa';
  const all = await policies(db);
  const none: TwoFactorRequirement = { required: false, enrolled: verified, verified, workspaces: [] };
  if (all.size === 0) return none;
  const ids = [...all].filter(([, p]) => !(method.amr === 'sso' && method.idp && p.ssoExemptProviders.includes(method.idp))).map(([id]) => id);
  if (ids.length === 0) return none;
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), inArray(workspaceMembers.workspaceId, ids)));
  if (rows.length === 0) return none;
  return { required: true, enrolled: verified || (await hasSecondFactor(db, userId)), verified, workspaces: rows };
}

/**
 * Routes a session that still has to prove a second factor may call: who am
 * I, the requirement itself, the panel's public status and signing out, and,
 * only for an account with no second factor at all, TOTP and passkey setup.
 * An account that already has one signs in again with it: a password-only
 * session must not add a factor of its own choosing and then pass with it.
 */
export function isEnrolmentRoute(method: string, url: string, enrolled: boolean): boolean {
  const path = url.split('?')[0]!.replace(/\/+$/, '');
  if (method === 'GET' && ['/v1/auth/me', '/v1/auth/status', '/v1/auth/2fa/requirement'].includes(path)) return true;
  if (method === 'POST' && path === '/v1/auth/logout') return true;
  if (enrolled) return false;
  if (method === 'GET' && ['/v1/auth/passkey', '/v1/auth/2fa/recovery-codes'].includes(path)) return true;
  if (method === 'POST' && ['/v1/auth/2fa/setup', '/v1/auth/2fa/enable', '/v1/auth/passkey/register/options', '/v1/auth/passkey/register/verify'].includes(path)) return true;
  return false;
}
