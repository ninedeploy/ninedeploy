import { z } from 'zod';
import type { DB } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { agentReplyCall } from './nodeAgentReply.js';
import { capabilityRefusal, nodeLabel, type AgentCaller } from './agentCapabilities.js';
import { HttpError } from './errors.js';

/**
 * Public access to a node database, panel side of the agent calls
 * (agentOps/publicAccess.ts). lib/publicDatabaseAccess.ts decides; this file
 * only talks to the node and turns each `ND-PUBLIC-DB` reply into a value or
 * the agent's own refusal.
 */

export const NODE_PUBLIC_ACCESS_FEATURE = 'expose a database publicly';
const REPLY = 'ND-PUBLIC-DB ';

/** Re-probed before every change: the agent must offer the op and the transport must be sealed. */
export async function assertNodePublicAccessSupport(db: DB, serverId: number): Promise<void> {
  const caller: AgentCaller = (op, params, sink) => agentOp(db, serverId, op, params, sink, { timeoutMs: 15_000 });
  const refused = await capabilityRefusal(caller, await nodeLabel(db, serverId), await agentTransportSealed(db, serverId), {
    cap: ['db.manage', 'db.publicAccess'],
    feature: NODE_PUBLIC_ACCESS_FEATURE,
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
    unconfirmed: { code: 'node_public_access_unconfirmed', message: 'The node did not confirm the public access change' },
  });

export interface NodeSidecarApply {
  databaseId: number;
  slug: string;
  container: string;
  enginePort: number;
  port: number;
  allowlist: string[];
}

/** Write the config and (re)start the sidecar on the node; `hot` when only the allow-list changed. */
export function nodeApplySidecar(db: DB, serverId: number, input: NodeSidecarApply): Promise<{ mode: 'hot' | 'started' }> {
  return call(db, serverId, 'db.publicAccess.apply', { ...input }, z.object({ mode: z.enum(['hot', 'started']) }), 180_000);
}

export async function nodeRemoveSidecar(db: DB, serverId: number, slug: string): Promise<void> {
  await call(db, serverId, 'db.publicAccess.remove', { slug }, z.object({ removed: z.literal(true) }), 60_000);
}

/** Whether the node's sidecar runs; null when the node could not answer. */
export async function nodeSidecarRunning(db: DB, serverId: number, slug: string): Promise<boolean | null> {
  try {
    return (await call(db, serverId, 'db.publicAccess.inspect', { slug }, z.object({ running: z.boolean() }).passthrough(), 10_000)).running;
  } catch {
    return null;
  }
}
