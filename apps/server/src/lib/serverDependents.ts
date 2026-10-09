import { eq } from 'drizzle-orm';
import { databases, type DB } from '@ninedeploy/db';

/**
 * What a server delete must never orphan, even with `?force=true`
 * (multi-node). A forced delete of a node that hosts a managed database would
 * leave data the panel then believes is local; the `databases.server_id`
 * foreign key is the backstop, this is the readable refusal (409
 * `server_hosts_databases`, design §5.7).
 *
 * Called from `DELETE /v1/servers/:id` (mount point M7, block `0.16 T6 server
 * delete guard`), before the route's own hosted-services check.
 */
export interface ServerDeleteBlocker {
  /** The API error code, e.g. `server_hosts_databases`. */
  code: string;
  message: string;
}

export async function serverDeleteBlockers(db: DB, serverId: number): Promise<ServerDeleteBlocker[]> {
  const hosted = await db
    .select({ id: databases.id, name: databases.name })
    .from(databases)
    .where(eq(databases.serverId, serverId));
  if (hosted.length === 0) return [];
  const names = hosted.map((d) => `"${d.name}" (#${d.id})`).join(', ');
  return [
    {
      code: 'server_hosts_databases',
      message:
        `Cannot delete this server: it hosts ${hosted.length} managed database${hosted.length > 1 ? 's' : ''} (${names}). ` +
        'Back up and delete them first (Databases → database → Delete; the data stays on the node unless you purge its volume). ' +
        '?force=true does not override this: the database rows would be left pointing at a host the panel no longer knows.',
    },
  ];
}
