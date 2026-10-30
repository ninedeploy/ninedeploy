import { createHash, randomBytes } from 'node:crypto';
import { and, eq, nodeProxyWriteHeads, servers, type DB, type NodeProxyWriteHead } from '@ninedeploy/db';
import { isNull } from 'drizzle-orm';

const valid = (row: NodeProxyWriteHead) => Number.isSafeInteger(row.serverId) && row.serverId > 0 &&
  Number.isSafeInteger(row.revision) && row.revision > 0 && /^[a-f0-9]{32}$/.test(row.requestId) &&
  (row.contentHash === null || /^[a-f0-9]{64}$/.test(row.contentHash));
const same = (a: NodeProxyWriteHead, b: NodeProxyWriteHead) => a.serverId === b.serverId && a.revision === b.revision && a.requestId === b.requestId;

/** Reserve before rendering; absent nodes remain on the legacy protocol until explicit adoption. */
export async function reserveNodeProxyWrite(db: DB, serverId: number, options: { adopt?: boolean } = {}): Promise<NodeProxyWriteHead | null> {
  if (!Number.isSafeInteger(serverId) || serverId < 1) throw new Error('Invalid node proxy authority');
  return db.transaction(async tx => {
    const [server] = await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!server) throw new Error('Node proxy server is unavailable');
    const [current] = await tx.select().from(nodeProxyWriteHeads).where(eq(nodeProxyWriteHeads.serverId, serverId)).limit(1);
    if (!current && !options.adopt) return null;
    if (current && (!valid(current) || current.revision >= Number.MAX_SAFE_INTEGER)) throw new Error('Node proxy revision is invalid or exhausted');
    const requestId = randomBytes(16).toString('hex');
    const [next] = current
      ? await tx.update(nodeProxyWriteHeads).set({ revision: current.revision + 1, requestId, contentHash: null }).where(and(
        eq(nodeProxyWriteHeads.serverId, serverId), eq(nodeProxyWriteHeads.revision, current.revision), eq(nodeProxyWriteHeads.requestId, current.requestId))).returning()
      : await tx.insert(nodeProxyWriteHeads).values({ serverId, revision: 1, requestId }).onConflictDoNothing().returning();
    if (!next) throw new Error('Node proxy write was superseded');
    return next;
  });
}

export async function checkpointNodeProxyWrite(db: Pick<DB, 'select'>, expected: NodeProxyWriteHead): Promise<NodeProxyWriteHead> {
  const [current] = await db.select().from(nodeProxyWriteHeads).where(eq(nodeProxyWriteHeads.serverId, expected.serverId)).limit(1);
  if (!valid(expected) || !current || !valid(current) || !same(current, expected)) throw new Error('Node proxy write was superseded');
  return current;
}

/** A revision has one immutable config digest, including across lost transport replies. */
export async function bindNodeProxyWrite(db: DB, expected: NodeProxyWriteHead, content: string): Promise<NodeProxyWriteHead> {
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > 1_048_576) throw new Error('Invalid node proxy configuration');
  const contentHash = createHash('sha256').update(content).digest('hex');
  return db.transaction(async tx => {
    const current = await checkpointNodeProxyWrite(tx, expected);
    if (current.contentHash !== null && current.contentHash !== contentHash) throw new Error('Node proxy write conflicts with its recorded configuration');
    if (current.contentHash !== null) return current;
    const [bound] = await tx.update(nodeProxyWriteHeads).set({ contentHash }).where(and(eq(nodeProxyWriteHeads.serverId, current.serverId),
      eq(nodeProxyWriteHeads.revision, current.revision), eq(nodeProxyWriteHeads.requestId, current.requestId), isNull(nodeProxyWriteHeads.contentHash))).returning();
    if (!bound) throw new Error('Node proxy write was superseded');
    return bound;
  });
}
