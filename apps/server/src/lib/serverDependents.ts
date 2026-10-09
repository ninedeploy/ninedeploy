import type { DB } from '@ninedeploy/db';

/**
 * What a server delete must never orphan, even with `?force=true`
 * (multi-node). A forced delete of a node that hosts a managed database would
 * leave data the panel then believes is local; the `databases.server_id`
 * foreign key is the backstop, this is the readable refusal (409
 * `server_hosts_databases`, design §5.7).
 *
 * Owner: task T6. T1 stub, called from `DELETE /v1/servers/:id` (mount point
 * M7, block `0.16 T6 server delete guard`). It reports no blocker, so the
 * route behaves exactly as in 0.15 until T6 fills it.
 */
export interface ServerDeleteBlocker {
  /** The API error code, e.g. `server_hosts_databases`. */
  code: string;
  message: string;
}

export async function serverDeleteBlockers(_db: DB, _serverId: number): Promise<ServerDeleteBlocker[]> {
  return [];
}
