import type { Database } from '@ninedeploy/db';
import type { MultiNodeCapability } from '@ninedeploy/schemas';

/**
 * N12: what a major upgrade calls things, and where a row keeps its names.
 * Shared by the journal (lib/databaseUpgrade.ts), its hands on a node
 * (lib/nodeDatabaseUpgrade.ts) and the agent (agentOps/databaseUpgrade.ts).
 * No imports from either side: they all import this.
 */

/** The agent capability a node needs to run a major upgrade of its database. */
export const NODE_UPGRADE_CAPABILITY = 'db.upgrade' as const satisfies MultiNodeCapability;
/** How a refusal names the feature (nodeFeatureRefusals pins it). */
export const NODE_UPGRADE_FEATURE = 'upgrade a database to a new major version';
/** The line an upgrade op of a node answers its structured result on. */
export const NODE_UPGRADE_REPLY = 'ND-DB-UPGRADE ';

/** The helpers of an upgrade: the old server on the old volume, the new one on the copy, and what copies. */
export type UpgradeHelper = 'fence' | 'staging' | 'copier';

/** Panel-host helper containers (lib/inventory.ts resolves them to the database). */
export const fenceName = (slug: string) => `nd-dbup-${slug}-old`;
export const stagingName = (slug: string) => `nd-dbup-${slug}-new`;
export const copierName = (slug: string) => `nd-dbup-${slug}-copy`;

/**
 * On a node the helpers are managed database names (`nd-db-*`): every rule
 * the agent applies to a database container applies to them too (the dump and
 * restore streams accept such names only). A different slug cannot produce
 * one of them unless it is itself `upg-<slug>-<old|new|copy>`, and the labels
 * decide: an op on a helper refuses a container that is not this database's.
 */
export const nodeFenceName = (slug: string) => `nd-db-upg-${slug}-old`;
export const nodeStagingName = (slug: string) => `nd-db-upg-${slug}-new`;
export const nodeCopierName = (slug: string) => `nd-db-upg-${slug}-copy`;

/** The helper's name where the database lives. */
export function helperName(d: Pick<Database, 'slug' | 'serverId'>, helper: UpgradeHelper): string {
  if (d.serverId == null) return helper === 'fence' ? fenceName(d.slug) : helper === 'staging' ? stagingName(d.slug) : copierName(d.slug);
  return helper === 'fence' ? nodeFenceName(d.slug) : helper === 'staging' ? nodeStagingName(d.slug) : nodeCopierName(d.slug);
}

/** Which helper of this database a container is, or null when it is none of them. */
export function helperOf(d: Pick<Database, 'slug' | 'serverId'>, container: string): UpgradeHelper | null {
  if (container === helperName(d, 'fence')) return 'fence';
  if (container === helperName(d, 'staging')) return 'staging';
  if (container === helperName(d, 'copier')) return 'copier';
  return null;
}

/** The new volume. Resolves to its database in the inventory (lib/inventory.ts); a managed name on a node too. */
export const upgradeVolumeName = (slug: string, upgradeId: number) => `nd-db-${slug}-data-u${upgradeId}`;

/**
 * A row as the upgrade reads it. A node database keeps `container_name` and
 * `volume_name` NULL (the rollback marker 0.15 refuses to act on them) and its
 * real names in the `node_*` columns: this view puts them where the journal
 * expects them. It is a way of READING — a row is never written back in this
 * shape; see {@link volumeSet}.
 */
export function hostView(d: Database): Database {
  if (d.serverId == null) return d;
  return { ...d, containerName: d.nodeContainerName ?? `nd-db-${d.slug}`, volumeName: d.nodeVolumeName ?? `nd-db-${d.slug}-data` };
}

/** The volume the row names, whichever column keeps it (a node's fallback name included). */
export function volumeOf(d: Database): string | null {
  return hostView(d).volumeName;
}

/** What `databases.update().set()` takes to point the row at volume `name`. */
export function volumeSet(d: Pick<Database, 'serverId'>, name: string): { volumeName: string } | { nodeVolumeName: string } {
  return d.serverId == null ? { volumeName: name } : { nodeVolumeName: name };
}
