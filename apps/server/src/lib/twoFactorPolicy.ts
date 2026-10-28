import { and, eq, inArray, like } from 'drizzle-orm';
import { settings, users, webauthnCredentials, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G1.4 workspace-enforced 2FA. A workspace admin can require two-factor
 * authentication (TOTP or a passkey) of every member. A member without it who
 * signs in gets a session that answers only the enrolment routes (see
 * `isEnrolmentRoute`) until they set one up; every other route is 403
 * `two_factor_required`. Optionally, sessions from an SSO sign-in are exempt,
 * for an IdP that enforces MFA itself.
 *
 * Scope: interactive sessions. API tokens a member already holds keep
 * working; a blocked session cannot mint new ones.
 *
 * No migration: one settings row per workspace, `workspace_2fa:<id>`.
 */

const PREFIX = 'workspace_2fa:';
const key = (workspaceId: number) => `${PREFIX}${workspaceId}`;

export interface WorkspaceTwoFactorPolicy {
  required: boolean;
  /** Sessions from an SSO sign-in (OIDC, SAML, GitHub) do not need panel 2FA. */
  ssoExempt: boolean;
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
    let v = row.value as unknown as Partial<WorkspaceTwoFactorPolicy> | string | null;
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v) as Partial<WorkspaceTwoFactorPolicy>;
      } catch {
        v = null;
      }
    }
    if (Number.isInteger(id) && id > 0 && v && typeof v === 'object' && v.required === true) map.set(id, { required: true, ssoExempt: v.ssoExempt === true });
  }
  cache = { at: Date.now(), policies: map };
  return map;
}

export async function getWorkspaceTwoFactor(db: DB, workspaceId: number): Promise<WorkspaceTwoFactorPolicy> {
  const v = await getSettingJson<Partial<WorkspaceTwoFactorPolicy>>(db, key(workspaceId), null);
  return { required: v?.required === true, ssoExempt: v?.ssoExempt === true };
}

export async function setWorkspaceTwoFactor(db: DB, workspaceId: number, policy: WorkspaceTwoFactorPolicy): Promise<void> {
  if (!policy.required) await db.delete(settings).where(eq(settings.key, key(workspaceId)));
  else await setSettingJson(db, key(workspaceId), { required: true, ssoExempt: policy.ssoExempt });
  resetTwoFactorPolicyCache();
}

export interface TwoFactorRequirement {
  /** A workspace the user belongs to requires 2FA of this session. */
  required: boolean;
  /** The user has TOTP or a passkey. */
  enrolled: boolean;
  /** The workspaces that require it. */
  workspaces: Array<{ id: number; name: string }>;
}

/** What the workspace policies ask of this user's session. Cheap when no workspace requires 2FA. */
export async function twoFactorRequirement(db: DB, userId: number, opts: { sso: boolean }): Promise<TwoFactorRequirement> {
  const all = await policies(db);
  const none: TwoFactorRequirement = { required: false, enrolled: false, workspaces: [] };
  if (all.size === 0) return none;
  const ids = [...all].filter(([, p]) => !(opts.sso && p.ssoExempt)).map(([id]) => id);
  if (ids.length === 0) return none;
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), inArray(workspaceMembers.workspaceId, ids)));
  if (rows.length === 0) return none;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { totpEnabled: true } });
  const passkey = user?.totpEnabled
    ? undefined
    : await db.query.webauthnCredentials.findFirst({ where: eq(webauthnCredentials.userId, userId), columns: { id: true } });
  return { required: true, enrolled: user?.totpEnabled === true || !!passkey, workspaces: rows };
}

/**
 * Routes a session that still has to enrol may call: who am I, the
 * requirement itself, TOTP and passkey setup, the panel's public status, and
 * signing out.
 */
export function isEnrolmentRoute(method: string, url: string): boolean {
  const path = url.split('?')[0]!.replace(/\/+$/, '');
  if (method === 'GET' && ['/v1/auth/me', '/v1/auth/status', '/v1/auth/2fa/requirement', '/v1/auth/passkey', '/v1/auth/2fa/recovery-codes'].includes(path)) return true;
  if (method === 'POST' && ['/v1/auth/logout', '/v1/auth/2fa/setup', '/v1/auth/2fa/enable', '/v1/auth/passkey/register/options', '/v1/auth/passkey/register/verify'].includes(path)) return true;
  return false;
}
