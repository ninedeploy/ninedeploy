import { and, desc, eq } from 'drizzle-orm';
import { nodeServingTrafficReceipts, type DB } from '@ninedeploy/db';
import { servingTrafficOpen, servingTrafficSnapshot, type ServingTrafficOpen, type ServingTrafficSnapshot } from '@ninedeploy/schemas';
import { AUTOSCALE_STATS_MAX_AGE_MS } from './autoscaler.js';
import { nodeServingTrafficContext, readNodeServingTrafficState } from './nodeServingTrafficContext.js';
import { proxyTrafficRoutingGeneration, proxyTrafficTargetHash, proxyTrafficUnavailable } from './proxyTrafficCounter.js';

/** Private adapter boundary: timestamps and context are captured by the panel, never supplied by an API caller. */
export async function consumeNodeServingTraffic(db: DB, params: ServingTrafficOpen, raw: ServingTrafficSnapshot,
  observation: { context: string; openedAt: number; receivedAt: number }, clock = Date.now) {
  const input = servingTrafficOpen.parse(params), receipt = servingTrafficSnapshot.parse(raw);
  if (!receipt.complete || receipt.endCounter === null || receipt.elapsedMs < input.durationMs ||
    receipt.nodeId !== input.nodeId || receipt.serviceId !== input.serviceId || receipt.deploymentId !== input.deploymentId ||
    receipt.requestId !== input.requestId || receipt.targetHash !== proxyTrafficTargetHash(input) ||
    receipt.routingGeneration !== proxyTrafficRoutingGeneration(input)) throw proxyTrafficUnavailable('completed serving receipt was not bound');
  const fresh = () => {
    const now = clock();
    if (![now, observation.openedAt, observation.receivedAt].every(Number.isSafeInteger) || observation.openedAt < 0 ||
      observation.receivedAt > now || observation.receivedAt < observation.openedAt || now - observation.receivedAt > AUTOSCALE_STATS_MAX_AGE_MS ||
      receipt.elapsedMs > observation.receivedAt - observation.openedAt) throw proxyTrafficUnavailable('serving receipt is stale, future or outside its panel observation');
    return now;
  };
  fresh();
  const value = receipt.serving.requests * 1000 / receipt.elapsedMs / input.serving.length;
  if (await nodeServingTrafficContext(db, input) !== observation.context) throw proxyTrafficUnavailable('serving context changed before receipt consumption');
  await db.transaction(async tx => {
    if (await readNodeServingTrafficState(tx, input) !== observation.context) {
      throw proxyTrafficUnavailable('serving context changed before receipt consumption');
    }
    // Fixed-width decimal storage makes the source index order uint64 values exactly.
    // Compare as BigInt, never SQLite REAL or JS Number.
    // Source identity survives agent epochs; restarting an agent cannot replay an old interval.
    const [prior] = await tx.select({ endCounter: nodeServingTrafficReceipts.endCounter }).from(nodeServingTrafficReceipts)
      .where(and(eq(nodeServingTrafficReceipts.serviceId, input.serviceId), eq(nodeServingTrafficReceipts.nodeId, input.nodeId), eq(nodeServingTrafficReceipts.sourceId, receipt.sourceId)))
      .orderBy(desc(nodeServingTrafficReceipts.endCounter)).limit(1);
    if (prior && BigInt(receipt.startCounter) <= BigInt(prior.endCounter)) throw proxyTrafficUnavailable('serving receipt interval was already consumed or superseded');
    const now = fresh();
    const inserted = await tx.insert(nodeServingTrafficReceipts).values({ nodeId: input.nodeId, serviceId: input.serviceId, deploymentId: input.deploymentId,
      requestId: input.requestId, windowId: receipt.windowId, sourceId: receipt.sourceId, proxyId: receipt.proxyId, epoch: receipt.epoch,
      targetHash: receipt.targetHash, routingGeneration: receipt.routingGeneration, startCounter: receipt.startCounter.padStart(20, '0'), endCounter: receipt.endCounter!.padStart(20, '0'),
      requests: receipt.serving.requests, elapsedMs: receipt.elapsedMs, replicas: input.serving.length,
      observedAtMs: observation.receivedAt, consumedAtMs: now }).onConflictDoNothing().returning({ windowId: nodeServingTrafficReceipts.windowId });
    if (inserted.length !== 1) throw proxyTrafficUnavailable('serving request or window was already consumed');
  });
  // A concurrent routing edit may spend a receipt, but must never release decision evidence.
  if (await nodeServingTrafficContext(db, input) !== observation.context) throw proxyTrafficUnavailable('serving context changed after receipt consumption');
  fresh();
  return { value, sampledAt: observation.receivedAt, requestId: receipt.requestId, windowId: receipt.windowId };
}
