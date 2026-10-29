import { z } from 'zod';
import type { DB } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
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
const refusal = z.object({ error: z.object({ status: z.number().int().min(400).max(599), code: z.string().min(1).max(64), message: z.string().min(1).max(600) }) });

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

async function call<T>(db: DB, serverId: number, op: string, params: Record<string, unknown>, shape: z.ZodType<T>, timeoutMs: number): Promise<T> {
  const unconfirmed = () => new HttpError(502, 'node_public_access_unconfirmed', 'The node did not confirm the public access change');
  let reply: Awaited<ReturnType<typeof agentOp>>;
  try {
    reply = await agentOp(db, serverId, op, params, () => undefined, { timeoutMs, tolerateExit: true });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'node_unreachable', `The node could not be reached: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
  }
  const line = reply.lines.find((l) => l.startsWith(REPLY));
  if (!line) throw unconfirmed();
  let value: unknown;
  try {
    value = JSON.parse(line.slice(REPLY.length));
  } catch {
    throw unconfirmed();
  }
  if (reply.exitCode !== 0) {
    const r = refusal.safeParse(value);
    if (r.success) throw new HttpError(r.data.error.status, r.data.error.code, r.data.error.message);
    throw unconfirmed();
  }
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw unconfirmed();
  return parsed.data;
}

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
