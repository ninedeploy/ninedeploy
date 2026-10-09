import { eq } from 'drizzle-orm';
import { databaseAttachments, databases, type DB, servers } from '@ninedeploy/db';
import type { MultiNodeCapability } from '@ninedeploy/schemas';
import { type AgentCaller, capabilityRefusal, nodeLabel } from './agentCapabilities.js';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { HttpError } from './errors.js';

/**
 * Moved out of `lib/remoteDeploy.ts` unchanged (multi-node T1, a pure move),
 * which re-exports it, so node databases (T6, design §5.5) relax it in this
 * file alone. Every caller still imports it from `remoteDeploy.ts`.
 */

/** The 0.15 refusals, word for word (a panel-host database never resolves on a node). */
const TEMPLATE_REFUSAL =
  'Deployments to a remote server are not available for this service: its template provisions a managed database, which runs on the panel host, and that hostname does not resolve on the node. Clear the target server to deploy it on the panel host.';
const PANEL_DATABASE_REFUSAL =
  'Deployments to a remote server are not available for a service with an attached managed database: the database runs on the panel host and its hostname does not resolve on the node. Detach it (use an external database URL) or clear the target server.';

/** What a node needs to run a database for a service on it (T6, lib/nodeDatabase.ts NODE_DATABASE_CAPS). */
const NODE_DATABASE_CAPS: readonly MultiNodeCapability[] = ['db.manage', 'stream', 'docker.runSpec', 'volume.manage'];

/** How the refusal reaches the node (tests inject it). */
export interface RemoteDatabaseProbe {
  agent: AgentCaller;
  nodeLabel: string;
  sealed: boolean;
}

/**
 * r229: why a node cannot run this service's DATABASE wiring, or null.
 *
 * Multi-node T6 (design §5.5): a database may now run on a node too, and a
 * service reaches it only on the SAME host (cross-host attachments are refused,
 * owner decision O2). So, for a service placed on a node:
 *
 *  - an attached panel-host database: refused with the 0.15 message, unchanged;
 *  - an attached database on ANOTHER node: refused, naming both hosts;
 *  - databases on this node: the node's agent must manage databases
 *    (`db.manage` and the rest of {@link NODE_DATABASE_CAPS}), else the
 *    "update the node agent" refusal;
 *  - r269, a template that declares a managed database: it is provisioned ON
 *    THIS NODE by the template reconcile when the agent can host databases;
 *    otherwise the 0.15 refusal, with the update hint added.
 *
 * A panel-host service is never refused here (its attachments are host-checked
 * where they are made).
 */
export async function remoteDatabaseRefusal(
  db: DB,
  service: { id: number; serverId?: number | null; templateDatabaseEnv?: unknown },
  opts: { probe?: (serverId: number) => Promise<RemoteDatabaseProbe> } = {},
): Promise<string | null> {
  if (service.serverId == null) return null;
  const serverId = service.serverId;
  const attached = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, service.id) });
  if (attached.length === 0 && service.templateDatabaseEnv == null) return null;
  const rows = await attachedRows(db, attached);
  // An attachment whose database row cannot be read is treated as the panel
  // host's — the 0.15 refusal, never a pass.
  if (rows.length < attached.length) return service.templateDatabaseEnv != null ? TEMPLATE_REFUSAL : PANEL_DATABASE_REFUSAL;

  /** Why the node cannot host databases, or null; any failure to even ask reads as a refusal. */
  const capabilityProblem = async (): Promise<string | null> => {
    try {
      const probe = await (opts.probe ?? (async (id: number): Promise<RemoteDatabaseProbe> => ({
        agent: (op, params, sink) => agentOp(db, id, op, params, sink),
        nodeLabel: await nodeLabel(db, id),
        sealed: await agentTransportSealed(db, id),
      })))(serverId);
      const refusal = await capabilityRefusal(probe.agent, probe.nodeLabel, probe.sealed, {
        cap: NODE_DATABASE_CAPS,
        feature: 'host a managed database',
        sealedRequired: true,
      });
      return refusal?.message ?? null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const foreign = rows.filter((d) => (d.serverId ?? null) !== serverId);
  if (service.templateDatabaseEnv != null) {
    // r269: the mapping is the signal on the first deploy (the attachment only
    // appears once the reconcile ran). A template database elsewhere keeps
    // the 0.15 refusal; none yet is provisioned here when the node can.
    if (foreign.some((d) => d.serverId == null)) return TEMPLATE_REFUSAL;
    if (foreign.length === 0) {
      const why = await capabilityProblem();
      return why === null ? null : `${TEMPLATE_REFUSAL} ${why}`;
    }
  }
  if (foreign.some((d) => d.serverId == null)) return PANEL_DATABASE_REFUSAL;
  if (foreign.length > 0) {
    const names = foreign.map((d) => `"${d.name}" (node #${d.serverId})`).join(', ');
    return `Deployments of this service are not available: it runs on node #${serverId}, but its attached managed database${foreign.length > 1 ? 's' : ''} ${names} run${foreign.length > 1 ? '' : 's'} on another node, and a database is reachable only from services on its own host. Detach it (use an external database URL), or attach a database on the same node.`;
  }
  if (rows.length === 0) return null;
  const why = await capabilityProblem();
  return why === null ? null : `Deployments to a remote server are not available for this service yet: ${why}`;
}

/** The database rows behind a service's attachments (a vanished row is skipped). */
async function attachedRows(db: DB, attached: ReadonlyArray<{ databaseId: number }>) {
  const rows: Array<typeof databases.$inferSelect> = [];
  for (const a of attached) {
    const d = await db.query.databases.findFirst({ where: eq(databases.id, a.databaseId) });
    if (d) rows.push(d);
  }
  return rows;
}

// ── the host rule for attachments (design §5.5) ──────────────────────────────

/** "the panel host" or `node "edge-1" (#4)`. */
export async function hostName(db: DB, serverId: number | null | undefined): Promise<string> {
  if (serverId == null) return 'the panel host';
  const row = await db.query.servers.findFirst({ where: eq(servers.id, serverId) }).catch(() => undefined);
  return row ? `node "${row.name}" (#${serverId})` : `node #${serverId}`;
}

/**
 * 409 `attachment_host_mismatch` when a service and a database run on
 * different hosts (both NULL = the panel host, as every 0.15 attachment):
 * the database's hostname resolves only on its own host.
 */
export async function attachmentHostMismatch(
  db: DB,
  service: { name: string; serverId?: number | null },
  database: { name: string; serverId?: number | null },
): Promise<HttpError | null> {
  if ((service.serverId ?? null) === (database.serverId ?? null)) return null;
  return new HttpError(
    409,
    'attachment_host_mismatch',
    `Service "${service.name}" runs on ${await hostName(db, service.serverId)}, but database "${database.name}" runs on ${await hostName(db, database.serverId)}. ` +
      'A managed database is reachable only from services on its own host: use an external database URL, or create a database on the service\'s host.',
  );
}

/**
 * The same rule for a service that MOVES to `serverId` (PATCH): 409 when any
 * database it is attached to would end up on another host.
 */
export async function attachedDatabasesHostMismatch(
  db: DB,
  service: { id: number; name: string },
  serverId: number | null,
): Promise<HttpError | null> {
  const attached = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, service.id) });
  if (attached.length === 0) return null;
  const rows = await attachedRows(db, attached);
  // A panel-host database attached to a service moving to a node keeps the
  // 0.15 behaviour (the deploy refuses it with r229's message); only node
  // databases are new, so only they are host-checked here.
  const off = rows.filter((d) => d.serverId != null && d.serverId !== serverId);
  if (off.length === 0) return null;
  return new HttpError(
    409,
    'attachment_host_mismatch',
    `Service "${service.name}" cannot move to ${await hostName(db, serverId)}: its attached database${off.length > 1 ? 's' : ''} ${off.map((d) => `"${d.name}"`).join(', ')} run${off.length > 1 ? '' : 's'} on ${await hostName(db, off[0]!.serverId)}, and a managed database is reachable only from services on its own host. Detach ${off.length > 1 ? 'them' : 'it'} first.`,
  );
}

/**
 * 409 `fanout_database_host`: fan-out targets run the service on OTHER
 * nodes, which never reach a database on a node (design §5.5).
 */
export async function fanoutDatabaseHostRefusal(
  db: DB,
  service: { id: number; name: string; serverId?: number | null },
  targetServerIds: readonly number[],
  /** A database being attached right now (the attach route), checked with the attached ones. */
  attaching?: { name: string; serverId?: number | null },
): Promise<HttpError | null> {
  const targets = targetServerIds.filter((id) => id !== (service.serverId ?? null));
  if (targets.length === 0) return null;
  const attached = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, service.id) });
  const rows: Array<{ name: string; serverId?: number | null }> = [...(await attachedRows(db, attached)), ...(attaching ? [attaching] : [])];
  const onNodes = rows.filter((d) => d.serverId != null);
  if (onNodes.length === 0) return null;
  return new HttpError(
    409,
    'fanout_database_host',
    `Service "${service.name}" is attached to ${onNodes.map((d) => `"${d.name}"`).join(', ')}, which run${onNodes.length > 1 ? '' : 's'} on ${await hostName(db, onNodes[0]!.serverId)}; fan-out targets on other nodes could never reach it. Detach it, or remove the targets.`,
  );
}
