import { and, eq, notExists, sql } from 'drizzle-orm';
import {
  alertRules,
  databases,
  domains,
  githubApps,
  oidcProviders,
  services,
  settings,
  ssoProviders,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import { settingRowsWithPrefix } from './settingRows.js';

/**
 * Settings rows that belong to one entity (COMPETITIVE_ROADMAP_2026-11 S1/S2).
 *
 * Many features keep per-entity state in the key/value `settings` table instead
 * of a column (`restart_limit:<serviceId>`, `forward_auth:<domainId>`, …). Rows
 * have no foreign key, so nothing removed them with their entity. This table
 * declares each prefix once: who owns it, how its key is shaped, whether it
 * holds a secret, and what an export or clone does with it.
 *
 * A new per-entity prefix must be declared here or listed in
 * `UNOWNED_SETTING_PREFIXES` with a reason; test/ownedSettings.test.ts scans
 * the source and fails otherwise.
 */

export type SettingOwner =
  | 'service'
  | 'domain'
  | 'database'
  | 'githubApp'
  | 'workspace'
  | 'ssoProvider'
  | 'oidcProvider'
  | 'alertRule';

/**
 * - `id`: the key is the prefix followed by the owner id and nothing else.
 * - `idColon`: the owner id is followed by `:` and more (`saml_identity:<provider>:<sha>`).
 */
export type SettingKeyShape = 'id' | 'idColon';

/**
 * What a service export, import or clone does with the row (S3).
 * - `copy`: configuration; it travels with the entity.
 * - `regenerate`: holds a secret or token; the copy gets a fresh one, never this one.
 * - `drop`: state that describes this instance only (results, progress, staged edits).
 */
export type SettingPortability = 'copy' | 'regenerate' | 'drop';

export interface OwnedSettingDef {
  prefix: string;
  owner: SettingOwner;
  shape: SettingKeyShape;
  secret: boolean;
  portability: SettingPortability;
}

export const OWNED_SETTINGS: readonly OwnedSettingDef[] = [
  // Services
  { prefix: 'restart_limit:', owner: 'service', shape: 'id', secret: false, portability: 'copy' },
  { prefix: 'maintenance:', owner: 'service', shape: 'id', secret: false, portability: 'copy' },
  { prefix: 'error_pages:', owner: 'service', shape: 'id', secret: false, portability: 'copy' },
  { prefix: 'inline_dockerfile:', owner: 'service', shape: 'id', secret: false, portability: 'copy' },
  { prefix: 'commit_status:', owner: 'service', shape: 'id', secret: false, portability: 'copy' },
  { prefix: 'ci_pipeline:', owner: 'service', shape: 'id', secret: false, portability: 'copy' },
  { prefix: 'sticky_session:', owner: 'service', shape: 'idColon', secret: false, portability: 'copy' },
  { prefix: 'registry_hook:', owner: 'service', shape: 'id', secret: true, portability: 'regenerate' },
  { prefix: 'error_ingest:', owner: 'service', shape: 'id', secret: true, portability: 'regenerate' },
  { prefix: 'pending_changes:', owner: 'service', shape: 'id', secret: false, portability: 'drop' },
  { prefix: 'image_scan:', owner: 'service', shape: 'id', secret: false, portability: 'drop' },
  { prefix: 'service_move:', owner: 'service', shape: 'id', secret: false, portability: 'drop' },
  // Domains
  { prefix: 'forward_auth:', owner: 'domain', shape: 'id', secret: false, portability: 'copy' },
  { prefix: 'compose_route:', owner: 'domain', shape: 'id', secret: false, portability: 'copy' },
  // Databases
  { prefix: 'backup_replicas:', owner: 'database', shape: 'id', secret: false, portability: 'drop' },
  // GitHub Apps
  { prefix: 'github_runners:', owner: 'githubApp', shape: 'id', secret: false, portability: 'drop' },
  // Workspaces
  { prefix: 'workspace_2fa:', owner: 'workspace', shape: 'id', secret: false, portability: 'drop' },
  { prefix: 'access_grants.idp_suspended.ws', owner: 'workspace', shape: 'id', secret: false, portability: 'drop' },
  { prefix: 'access_grants.admin_suspended.ws', owner: 'workspace', shape: 'id', secret: false, portability: 'drop' },
  { prefix: 'scim.suspended.ws', owner: 'workspace', shape: 'id', secret: false, portability: 'drop' },
  // Identity providers
  { prefix: 'saml_identity:', owner: 'ssoProvider', shape: 'idColon', secret: false, portability: 'drop' },
  { prefix: 'oidc.allowed_domains.', owner: 'oidcProvider', shape: 'id', secret: false, portability: 'drop' },
  // Alert rules
  { prefix: 'alert_investigation:', owner: 'alertRule', shape: 'id', secret: false, portability: 'drop' },
];

/**
 * Key prefixes that look per-entity but are deliberately NOT swept, each with
 * the reason. The source scan accepts these.
 */
export const UNOWNED_SETTING_PREFIXES: Readonly<Record<string, string>> = {
  'cloud_server:': 'links a node to a billable cloud VM; deleting the link would leave the VM unmanageable from the panel. hetznerCloud.ts removes it when the VM is deleted.',
  'cloud_rekey:': 'pending agent key of a cloud node; removed with cloud_server: by hetznerCloud.ts.',
  'oauth_client:': 'remote-MCP OAuth clients, not owned by a panel entity; sweepMcpOAuth ages them out.',
  'oauth_refresh:': 'remote-MCP refresh tokens; sweepMcpOAuth ages them out.',
  'ssh.hostKeys:': 'pinned SSH host keys per host:port, independent of any server row.',
  'plugin:': 'kernel plugin configuration, owned by the plugin rather than an entity.',
  'project:': 'plugin configuration scoped to a project through the config center (sticky IP).',
};

const OWNER_TABLES = {
  service: services,
  domain: domains,
  database: databases,
  githubApp: githubApps,
  workspace: workspaces,
  ssoProvider: ssoProviders,
  oidcProvider: oidcProviders,
  alertRule: alertRules,
} as const;

/** The owner id a key carries, or null when the key does not have the declared shape. */
export function ownerIdOf(def: OwnedSettingDef, key: string): number | null {
  if (!key.startsWith(def.prefix)) return null;
  const rest = key.slice(def.prefix.length);
  const idText = def.shape === 'id' ? rest : rest.slice(0, rest.indexOf(':'));
  if (def.shape === 'idColon' && rest.indexOf(':') < 1) return null;
  if (!/^[1-9]\d{0,15}$/.test(idText)) return null;
  const id = Number(idText);
  return Number.isSafeInteger(id) ? id : null;
}

/** Declarations owned by one entity kind. */
export function ownedSettingDefs(owner: SettingOwner): OwnedSettingDef[] {
  return OWNED_SETTINGS.filter((d) => d.owner === owner);
}

/**
 * Remove every declared settings row owned by `owner` `id`. Call it after the
 * entity row is gone; anything it misses (a crash in between, a delete path that
 * does not call it, an FK cascade) is removed by `sweepOrphanedSettings`.
 * Returns the number of rows removed.
 */
export async function deleteOwnedSettings(db: DB, owner: SettingOwner, id: number): Promise<number> {
  let removed = 0;
  for (const def of ownedSettingDefs(owner)) {
    if (def.shape === 'id') {
      const rows = await db.delete(settings).where(eq(settings.key, `${def.prefix}${id}`)).returning({ key: settings.key });
      removed += rows.length;
    } else {
      for (const row of await settingRowsWithPrefix(db, `${def.prefix}${id}:`)) {
        const rows = await db.delete(settings).where(eq(settings.key, row.key)).returning({ key: settings.key });
        removed += rows.length;
      }
    }
  }
  return removed;
}

/**
 * Remove declared rows whose owner no longer exists. Each candidate is deleted
 * by one statement that re-checks the owner (`NOT EXISTS`), so an entity created
 * while the sweep runs never loses its row. Keys that do not parse are kept.
 * Returns the rows removed per prefix (prefixes with none are omitted).
 */
export async function sweepOrphanedSettings(db: DB): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const def of OWNED_SETTINGS) {
    const table = OWNER_TABLES[def.owner];
    for (const row of await settingRowsWithPrefix(db, def.prefix)) {
      const id = ownerIdOf(def, row.key);
      if (id === null) continue;
      const gone = await db
        .delete(settings)
        .where(and(eq(settings.key, row.key), notExists(db.select({ one: sql`1` }).from(table).where(eq(table.id, id)))))
        .returning({ key: settings.key });
      if (gone.length) removed[def.prefix] = (removed[def.prefix] ?? 0) + gone.length;
    }
  }
  return removed;
}
