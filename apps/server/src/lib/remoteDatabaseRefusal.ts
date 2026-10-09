import { eq } from 'drizzle-orm';
import { databaseAttachments, type DB } from '@ninedeploy/db';

/**
 * Moved out of `lib/remoteDeploy.ts` unchanged (multi-node T1, a pure move),
 * which re-exports it, so node databases (T6, design §5.5) relax it in this
 * file alone. Every caller still imports it from `remoteDeploy.ts`.
 */

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
  // r269: a template that declares a managed database (ghost, wordpress …)
  // carries its env mapping on the service from install on, but the
  // attachment itself is only created by reconcileTemplateDependencies —
  // AFTER this check runs in the pipeline. The first deploy of such a service
  // on a node therefore passed, provisioned the database on the panel and
  // went green pointing at a host the node cannot resolve. The mapping is
  // what r229 took this parameter for; it was never read.
  if (service.templateDatabaseEnv != null) {
    return 'Deployments to a remote server are not available for this service: its template provisions a managed database, which runs on the panel host, and that hostname does not resolve on the node. Clear the target server to deploy it on the panel host.';
  }
  const attached = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, service.id) });
  if (attached.length === 0) return null;
  return 'Deployments to a remote server are not available for a service with an attached managed database: the database runs on the panel host and its hostname does not resolve on the node. Detach it (use an external database URL) or clear the target server.';
}
