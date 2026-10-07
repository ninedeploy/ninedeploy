import { eq, inArray } from 'drizzle-orm';
import { projects, serviceProjects, serviceWorkspaces, services, type DB, type Service } from '@ninedeploy/db';
import { audit } from './audit.js';
import { decrypt, encrypt } from './crypto.js';
import { forbidden } from './errors.js';
import { isOperator, type AuthedUser } from './resourceAccess.js';
import { getSettingJson, getSettingString, setSettingJson, setSettingString } from './settings.js';

/**
 * Vault-provider secret resolution (deploy-time). Env values may reference
 * external secret stores with the `${{provider:KEY}}` syntax; the reference is
 * resolved at deploy time and never stored. Zero-dependency: plain fetch.
 *
 * Providers: infisical (Machine Identity / Universal Auth token),
 * doppler (service token — Basic auth).
 */

export const vaultProviders = ['infisical', 'doppler'] as const;
export type VaultProvider = (typeof vaultProviders)[number];

export interface VaultConfig {
  provider: VaultProvider | null;
  token: string | null;
  /** Infisical workspace/project id + environment slug; Doppler project + config. */
  projectId: string | null;
  environment: string | null;
}

export async function getVaultConfig(db: DB): Promise<VaultConfig> {
  const provider = getSettingString(db, 'vault_provider', null);
  const tokenEncrypted = getSettingString(db, 'vault_token_encrypted', null);
  const projectId = getSettingString(db, 'vault_project_id', null);
  const environment = getSettingString(db, 'vault_environment', null);
  const [p, t, pi, e] = await Promise.all([provider, tokenEncrypted, projectId, environment]);
  if (!p || p !== 'infisical' && p !== 'doppler') return { provider: null, token: null, projectId: null, environment: null };
  return { provider: p, token: t ? decryptToken(t) : null, projectId: pi, environment: e };
}

/**
 * F176: an envelope this key ring cannot open (its version was dropped from
 * NINEDEPLOY_MASTER_KEYS, a DB restored under other keys) reads as "no token"
 * — as enrolment.ts and modules/ai.ts do — instead of throwing out of every
 * caller, which 500'd the Vault settings routes and blocked re-entering it.
 */
function decryptToken(envelope: string): string | null {
  try {
    return decrypt(envelope);
  } catch {
    return null;
  }
}

export async function setVaultConfig(
  db: DB,
  cfg: { provider: VaultProvider | null; token: string | null; projectId: string | null; environment: string | null },
): Promise<void> {
  await Promise.all([
    setSettingString(db, 'vault_provider', cfg.provider ?? ''),
    cfg.token === null
      ? setSettingString(db, 'vault_token_encrypted', '')
      : setSettingString(db, 'vault_token_encrypted', encrypt(cfg.token)),
    setSettingString(db, 'vault_project_id', cfg.projectId ?? ''),
    setSettingString(db, 'vault_environment', cfg.environment ?? ''),
  ]);
}

const INFISICAL_BASE = 'https://app.infisical.com/api/v3';
const DOPPLER_BASE = 'https://api.doppler.com/v3';

async function fetchInfisicalSecrets(cfg: VaultConfig): Promise<Record<string, string>> {
  const url = new URL(`${INFISICAL_BASE}/secrets/raw`);
  url.searchParams.set('workspaceId', cfg.projectId ?? '');
  url.searchParams.set('environment', cfg.environment ?? 'default');
  url.searchParams.set('secretPath', '/');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Infisical API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { secrets?: Array<{ secretKey: string; secretValue: string }> };
  const out: Record<string, string> = {};
  for (const s of body.secrets ?? []) out[s.secretKey] = s.secretValue;
  return out;
}

async function fetchDopplerSecrets(cfg: VaultConfig): Promise<Record<string, string>> {
  const url = new URL(`${DOPPLER_BASE}/configs/secrets/download`);
  url.searchParams.set('format', 'json');
  if (cfg.projectId) url.searchParams.set('project', cfg.projectId);
  url.searchParams.set('config', cfg.environment ?? 'dev');
  const basic = Buffer.from(`${cfg.token}:`).toString('base64');
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Doppler API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, string>;
}

/** Fetch the provider's full secret set (used for both resolution and testing). */
export async function fetchVaultSecrets(cfg: VaultConfig): Promise<Record<string, string>> {
  if (!cfg.provider || !cfg.token) throw new Error('No vault provider configured');
  if (cfg.provider === 'infisical') return fetchInfisicalSecrets(cfg);
  return fetchDopplerSecrets(cfg);
}

/** Connectivity test — returns the number of reachable secrets. */
export async function testVault(db: DB): Promise<number> {
  const cfg = await getVaultConfig(db);
  const secrets = await fetchVaultSecrets(cfg);
  return Object.keys(secrets).length;
}

// ── deploy-time resolution ─────────────────────────────────────────────────
// One shared regex; caching avoids re-parsing. Provider+key are both
// constrained ([\w.-]+) so a hostile value can't smuggle extra syntax.
const REF = /\$\{\{(infisical|doppler):([\w.-]+)\}\}/g;

/** True when the value contains at least one vault reference. */
export function hasVaultRef(value: string): boolean {
  REF.lastIndex = 0;
  return REF.test(value);
}

// ── r510: who may resolve vault references ─────────────────────────────────
// The vault token is ONE instance-wide credential. Resolving `${{provider:KEY}}`
// for every service let any member write `X=${{infisical:PROD_DB_PASSWORD}}`
// on their own service and read any secret the operator's token can see. A
// reference now resolves only for a service whose owner is an instance
// operator, or that the operator has allowed: its workspace (a tag, or a
// trustworthy linked project's workspace) is on the allowlist stored with the
// vault settings, or — legacy, seeded at upgrade only — the service id itself.

/** Settings key holding the allowlist. Its ABSENCE means "never initialised". */
export const VAULT_ALLOWLIST_KEY = 'vault_allowlist';

export interface VaultAllowlist {
  workspaceIds: number[];
  /** Un-tagged services grandfathered by the upgrade seed (no workspace to allow). */
  serviceIds: number[];
}

/** What the deploy (or a write) is resolving references for. */
export interface VaultSubject {
  service: Pick<Service, 'id' | 'ownerUserId'> & { previewParentServiceId?: number | null };
  /** Project links that survived `filterTrustworthyProjectLinks`. */
  projectIds: number[];
}

const VAULT_SETTINGS_PATH = 'Settings → Integrations → Vault provider';

function normaliseAllowlist(raw: unknown): VaultAllowlist {
  const ids = (v: unknown) =>
    Array.isArray(v)
      ? [...new Set(v.filter((n): n is number => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
      : [];
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { workspaceIds: ids(o['workspaceIds']), serviceIds: ids(o['serviceIds']) };
}

/** The stored allowlist, or null when it was never initialised. */
export async function getVaultAllowlist(db: DB): Promise<VaultAllowlist | null> {
  const raw = await getSettingJson<unknown>(db, VAULT_ALLOWLIST_KEY, null);
  return raw == null ? null : normaliseAllowlist(raw);
}

export async function setVaultAllowlist(db: DB, list: VaultAllowlist): Promise<VaultAllowlist> {
  const clean = normaliseAllowlist(list);
  await setSettingJson(db, VAULT_ALLOWLIST_KEY, clean);
  return clean;
}

let seeding: Promise<VaultAllowlist> | null = null;

/**
 * r510 upgrade path. A 0.10.35 instance resolved references for everyone, so
 * the first boot of this release must not break deploys that work today:
 * when the allowlist was never initialised, seed it from current usage — the
 * workspaces of every non-operator service whose env holds a reference, the
 * workspaces of projects whose shared env holds one, and the ids of such
 * services that have no workspace — then mark it initialised. Operator-owned
 * services need no entry (they resolve regardless). The seed is audited and
 * logged so the operator can review exactly what was grandfathered.
 * Idempotent, and called both at boot and lazily from the gate, so no path
 * can observe an uninitialised list.
 */
export async function ensureVaultAllowlistInitialised(
  db: DB,
  log?: (msg: string, detail: Record<string, unknown>) => void,
): Promise<VaultAllowlist> {
  const existing = await getVaultAllowlist(db);
  if (existing) return existing;
  seeding ??= seedVaultAllowlist(db, log).finally(() => {
    seeding = null;
  });
  return seeding;
}

async function seedVaultAllowlist(
  db: DB,
  log?: (msg: string, detail: Record<string, unknown>) => void,
): Promise<VaultAllowlist> {
  const serviceIdsWithRefs = new Set<number>();
  const projectIdsWithRefs = new Set<number>();
  for (const row of await db.query.envVars.findMany()) {
    let value: string;
    try {
      value = decrypt(row.valueEncrypted);
    } catch {
      continue; // undecryptable envelope: it cannot resolve today either
    }
    if (!hasVaultRef(value)) continue;
    if (row.scope === 'project') projectIdsWithRefs.add(row.scopeKey);
    else if (row.serviceId != null) serviceIdsWithRefs.add(row.serviceId);
  }
  const workspaceIds = new Set<number>();
  const serviceIds = new Set<number>();
  if (serviceIdsWithRefs.size > 0) {
    const rows = await db.query.services.findMany({ where: inArray(services.id, [...serviceIdsWithRefs]) });
    for (const svc of rows) {
      if (svc.ownerUserId != null && (await isOperator(db, { id: svc.ownerUserId }))) continue;
      const tags = await db.query.serviceWorkspaces.findMany({ where: eq(serviceWorkspaces.serviceId, svc.id) });
      if (tags.length === 0) serviceIds.add(svc.id);
      for (const t of tags) workspaceIds.add(t.workspaceId);
    }
  }
  if (projectIdsWithRefs.size > 0) {
    const rows = await db.query.projects.findMany({ where: inArray(projects.id, [...projectIdsWithRefs]) });
    for (const p of rows) if (p.workspaceId != null) workspaceIds.add(p.workspaceId);
  }
  const seeded = await setVaultAllowlist(db, { workspaceIds: [...workspaceIds], serviceIds: [...serviceIds] });
  if (seeded.workspaceIds.length > 0 || seeded.serviceIds.length > 0) {
    const summary = `seeded from existing vault references: workspaces [${seeded.workspaceIds.join(', ')}], services [${seeded.serviceIds.join(', ')}]`;
    await audit(db, null, 'settings.vault_allowlist_seeded', summary, { ...seeded });
    log?.(`vault allowlist initialised from current usage (r510) — review it under ${VAULT_SETTINGS_PATH}`, { ...seeded });
  }
  return seeded;
}

/**
 * Whether references may resolve for `subject`. `ownerOperatorCounts` is true
 * at deploy time (an operator-owned service resolves regardless) and false
 * for a member's WRITE: a member who can edit an operator-owned service in a
 * shared workspace must not be able to plant a new reference there either.
 */
export async function vaultRefsAllowed(
  db: DB,
  subject: VaultSubject,
  opts: { ownerOperatorCounts: boolean },
): Promise<boolean> {
  const { service } = subject;
  if (opts.ownerOperatorCounts && service.ownerUserId != null && (await isOperator(db, { id: service.ownerUserId }))) {
    return true;
  }
  const allow = await ensureVaultAllowlistInitialised(db);
  // A PR preview is a copy of its parent (same env, same tags); a parent
  // grandfathered by id covers its previews.
  if (allow.serviceIds.includes(service.id)) return true;
  if (service.previewParentServiceId != null && allow.serviceIds.includes(service.previewParentServiceId)) return true;
  if (allow.workspaceIds.length === 0) return false;
  const tags = await db.query.serviceWorkspaces.findMany({ where: eq(serviceWorkspaces.serviceId, service.id) });
  return workspacesAllowed(db, allow, tags.map((t) => t.workspaceId), subject.projectIds);
}

/** A tag workspace, or a linked project's workspace, is on the allowlist. */
async function workspacesAllowed(
  db: DB,
  allow: VaultAllowlist,
  workspaceIds: number[],
  projectIds: number[],
): Promise<boolean> {
  if (allow.workspaceIds.length === 0) return false;
  if (workspaceIds.some((w) => allow.workspaceIds.includes(w))) return true;
  for (const projectId of projectIds) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project?.workspaceId != null && allow.workspaceIds.includes(project.workspaceId)) return true;
  }
  return false;
}

const REF_EXAMPLE = ['$', '{{infisical:…}} / $', '{{doppler:…}}'].join('');

function notAllowedMessage(what: string): string {
  return (
    `Vault references (${REF_EXAMPLE}) are not enabled for ${what}. ` +
    `An instance operator can allow its workspace under ${VAULT_SETTINGS_PATH}.`
  );
}

/**
 * r510 write-time gate for the env routes: a non-operator may only store a
 * value containing a vault reference on a service / project the operator has
 * allowed. Values without a reference (and operators) pass untouched.
 */
export async function assertMayWriteVaultRefs(
  db: DB,
  user: AuthedUser,
  target:
    | {
        kind: 'service';
        service: Pick<Service, 'id' | 'ownerUserId' | 'name'> & { previewParentServiceId?: number | null };
      }
    | { kind: 'project'; project: { id: number; name: string; workspaceId: number | null } }
    // r601: a service a request is ABOUT to create (template deploy, bundle
    // import) — judged by the workspace tags and project links it will get,
    // so the request is refused before any row is written.
    | { kind: 'newService'; name: string; workspaceIds: number[]; projectIds: number[] },
  values: string[],
): Promise<void> {
  if (user.isOperator || !values.some(hasVaultRef)) return;
  if (target.kind === 'newService') {
    const allow = await ensureVaultAllowlistInitialised(db);
    if (await workspacesAllowed(db, allow, target.workspaceIds, target.projectIds)) return;
    throw forbidden(notAllowedMessage(`service "${target.name}"`));
  }
  if (target.kind === 'project') {
    const allow = await ensureVaultAllowlistInitialised(db);
    const ws = target.project.workspaceId;
    if (ws != null && allow.workspaceIds.includes(ws)) return;
    throw forbidden(notAllowedMessage(`project "${target.project.name}"`));
  }
  const links = await db.query.serviceProjects.findMany({
    where: eq(serviceProjects.serviceId, target.service.id),
  });
  const ok = await vaultRefsAllowed(
    db,
    { service: target.service, projectIds: links.map((l) => l.projectId) },
    { ownerOperatorCounts: false },
  );
  if (!ok) throw forbidden(notAllowedMessage(`service "${target.service.name}"`));
}

/**
 * Resolve every `${{provider:KEY}}` reference in an env map, in place of the
 * caller. Loads each referenced provider once (deploy-scoped cache). Missing
 * keys throw — a half-resolved secret leaking the raw reference into a
 * container is worse than a failed deploy. `subject` (r510) is the service
 * the env belongs to; it must be allowed to resolve references at all.
 */
export async function resolveVaultRefs(
  db: DB,
  env: Record<string, string>,
  subject: VaultSubject,
): Promise<Record<string, string>> {
  const needed = new Map<VaultProvider, void>();
  for (const value of Object.values(env)) {
    REF.lastIndex = 0;
    for (const m of value.matchAll(REF)) needed.set(m[1] as VaultProvider);
  }
  if (needed.size === 0) return env;
  const pools = new Map<VaultProvider, Record<string, string>>();
  for (const provider of needed.keys()) {
    const cfg = await getVaultConfig(db);
    if (cfg.provider !== provider || !cfg.token) {
      throw new Error(`Vault provider "${provider}" is referenced but not configured`);
    }
    // r510: no unscoped resolution — a service the operator has not allowed
    // fails its deploy with an actionable message instead of receiving the
    // operator's secrets. Checked before the first provider fetch.
    if (pools.size === 0 && !(await vaultRefsAllowed(db, subject, { ownerOperatorCounts: true }))) {
      throw new Error(notAllowedMessage('this service'));
    }
    pools.set(provider, await fetchVaultSecrets(cfg));
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(REF, (_all, provider: string, name: string) => {
      const pool = pools.get(provider as VaultProvider);
      // F177: own keys only — `constructor`, `toString`, `__proto__` … are
      // inherited by the plain-object pool and must not resolve to garbage.
      const resolved = pool && Object.hasOwn(pool, name) ? pool[name] : undefined;
      if (resolved === undefined) throw new Error(`Vault secret "${provider}:${name}" not found (env key ${key})`);
      return resolved;
    });
  }
  return out;
}
