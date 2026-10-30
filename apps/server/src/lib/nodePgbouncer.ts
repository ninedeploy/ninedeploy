import { z } from 'zod';
import type { DB } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal, nodeLabel, type AgentCaller } from './agentCapabilities.js';
import { HttpError } from './errors.js';
import { agentReplyCall } from './nodeAgentReply.js';

/**
 * PgBouncer for a node database, panel side of the agent calls
 * (agentOps/pgbouncer.ts). lib/pgbouncer.ts decides; this file only talks to
 * the node.
 */

export const NODE_PGBOUNCER_FEATURE = 'pool connections with PgBouncer';
const REPLY = 'ND-PGBOUNCER ';

/** Re-probed before an enable: the agent must offer the op and the transport must be sealed (the password travels). */
export async function assertNodePgbouncerSupport(db: DB, serverId: number): Promise<void> {
  const caller: AgentCaller = (op, params, sink) => agentOp(db, serverId, op, params, sink, { timeoutMs: 15_000 });
  const refused = await capabilityRefusal(caller, await nodeLabel(db, serverId), await agentTransportSealed(db, serverId), {
    cap: ['db.manage', 'db.pgbouncer'],
    feature: NODE_PGBOUNCER_FEATURE,
    sealedRequired: true,
    persist: { db, serverId },
  });
  if (refused) throw new HttpError(refused.status, refused.code, refused.message);
}

const call = <T>(db: DB, serverId: number, op: string, params: Record<string, unknown>, shape: z.ZodType<T>, timeoutMs: number): Promise<T> =>
  agentReplyCall(db, serverId, op, params, {
    prefix: REPLY,
    shape,
    timeoutMs,
    unconfirmed: { code: 'node_pgbouncer_unconfirmed', message: 'The node did not confirm the PgBouncer change' },
  });

export interface NodePgbouncerEnable {
  databaseId: number;
  slug: string;
  container: string;
  postgresPort: number;
  listenPort: number;
  user: string;
  dbName: string;
  password: string;
}

export async function nodeEnablePgbouncer(db: DB, serverId: number, input: NodePgbouncerEnable): Promise<string> {
  const res = await call(db, serverId, 'db.pgbouncer.enable', { ...input }, z.object({ containerName: z.string(), running: z.literal(true) }), 300_000);
  return res.containerName;
}

export async function nodeDisablePgbouncer(db: DB, serverId: number, slug: string): Promise<void> {
  await call(db, serverId, 'db.pgbouncer.disable', { slug }, z.object({ removed: z.literal(true) }), 60_000);
}

/** The node's view of the sidecar; null when the node could not answer. */
export async function nodePgbouncerState(db: DB, serverId: number, slug: string): Promise<{ running: boolean; poolMode: string | null } | null> {
  try {
    return await call(db, serverId, 'db.pgbouncer.status', { slug }, z.object({ running: z.boolean(), poolMode: z.string().nullable() }), 10_000);
  } catch {
    return null;
  }
}
