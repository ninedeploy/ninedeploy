import { eq } from 'drizzle-orm';
import { databaseAttachments, type DB } from '@ninedeploy/db';
import { badRequest } from './errors.js';

/**
 * What a remote node can and cannot run.
 *
 * Remote deployments used to be refused outright: `server_id` existed on the
 * services table, on the Servers page and in the BuildContext, and no builder
 * read it, so a service pinned to a node would have been built and started on
 * the PANEL host while the panel reported the node. Refusing was the honest
 * behaviour — a failed deployment is recoverable, a container on the wrong
 * machine is not.
 *
 * `engine/builders/remoteDocker.ts` now routes docker services through the
 * node's agent, so the blanket refusal is gone. What remains is a narrower and
 * still-honest one: the shapes the agent has no operation for.
 *
 *   - PM2 has no agent operation at all, and it is host-privileged.
 *
 * Compose stacks DO run on a node now (`engine/builders/remoteCompose.ts`):
 * the panel ships an inline stack's YAML, or the node checks the repository
 * out, and the same preflight-then-up ordering the local builder uses is
 * driven through typed operations.
 *
 * Nixpacks source builds are refused too, but only the builder can see that
 * (it depends on the build config, not the service type) — see
 * `RemoteDeployUnsupportedError` there.
 */

/** Service types a node's agent can run today. */
const REMOTE_CAPABLE_TYPES = new Set(['docker', 'compose']);

/** True when a service of this type can be deployed to a node. */
export function remoteDeploySupported(type: string): boolean {
  return REMOTE_CAPABLE_TYPES.has(type);
}

/** Operator-facing reason a service of this type cannot go to a node. */
export function remoteDeployUnsupportedReason(type: string): string {
  const why =
    type === 'pm2'
      ? 'PM2 services run as host processes and the node agent has no operation for them'
      : `service type "${type}" has no remote implementation`;
  return `Deployments to a remote server are not available for this service: ${why}. Clear the target server to deploy it on the panel host.`;
}

/**
 * r229: why a node cannot run this service's DATABASE wiring, or null.
 * Managed databases always run on the panel host, and the runtime env names
 * them by container (`nd-db-<slug>`) — a name only the panel's docker network
 * resolves. A database-attached service pinned to a node deployed "green"
 * (remote health is container state) and then failed DNS on every connection.
 */
export async function remoteDatabaseRefusal(
  db: DB,
  service: { id: number; serverId?: number | null; templateDatabaseEnv?: unknown },
): Promise<string | null> {
  if (service.serverId == null) return null;
  const attached = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, service.id) });
  if (attached.length === 0) return null;
  return 'Deployments to a remote server are not available for a service with an attached managed database: the database runs on the panel host and its hostname does not resolve on the node. Detach it (use an external database URL) or clear the target server.';
}

/** Queue-time 400 for {@link remoteDatabaseRefusal}. */
export async function assertRemoteDatabaseReachable(
  db: DB,
  service: { id: number; serverId?: number | null },
): Promise<void> {
  const reason = await remoteDatabaseRefusal(db, service);
  if (reason) throw badRequest(reason, 'remote_database_unreachable');
}

/**
 * Throw a 400 for a service pinned to a node whose type cannot run there
 * (queue-time feedback, so the operator hears it before a deployment row is
 * created). A docker service passes straight through.
 */
export function assertRemoteDeploySupported(service: {
  serverId?: number | null;
  type?: string | null;
}): void {
  if (service.serverId == null) return;
  const type = service.type ?? 'docker';
  if (remoteDeploySupported(type)) return;
  throw badRequest(remoteDeployUnsupportedReason(type), 'remote_deploy_unsupported');
}
