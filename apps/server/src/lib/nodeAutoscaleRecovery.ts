import { and, eq, isNull, lte, notInArray, or } from 'drizzle-orm';
import { nodeAutoscaleTransitions, type DB } from '@ninedeploy/db';
import { discardExpiredNodeAutoscale, NODE_AUTOSCALE_LEASE_MS, recoverNodeAutoscaleAdmission, type NodeAutoscaleAdmission } from './nodeAutoscaleAuthority.js';
import { executeNodeAutoscale, type NodeAutoscaleControllerDeps } from './nodeAutoscaleController.js';
import { nodeAutoscaleRuntime } from './nodeAutoscaleRuntime.js';

/** Reclaim only expired decisions; every resumed effect rechecks the durable runtime owner. */
export async function reconcileNodeAutoscale(db: DB, options: { signal?: AbortSignal; limit?: number; log?: (line: string) => void;
  runtime?: (admission: NodeAutoscaleAdmission) => NodeAutoscaleControllerDeps } = {}) {
  options.signal?.throwIfAborted();
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(16, options.limit!)) : 4;
  const due = await db.select({ serviceId: nodeAutoscaleTransitions.serviceId }).from(nodeAutoscaleTransitions).where(and(
    notInArray(nodeAutoscaleTransitions.phase, ['held']),
    or(isNull(nodeAutoscaleTransitions.leaseUntil), lte(nodeAutoscaleTransitions.leaseUntil, new Date())),
  )).orderBy(nodeAutoscaleTransitions.updatedAt, nodeAutoscaleTransitions.serviceId).limit(limit);
  const results: Array<{ serviceId: number; state: 'completed' | 'discarded' | 'busy' | 'failed' }> = [];
  for (const item of due) {
    options.signal?.throwIfAborted();
    try {
      const admission = await recoverNodeAutoscaleAdmission(db, item.serviceId);
      if (!admission) { results.push({ serviceId: item.serviceId, state: 'busy' }); continue; }
      if (await discardExpiredNodeAutoscale(db, admission)) { results.push({ serviceId: item.serviceId, state: 'discarded' }); continue; }
      await executeNodeAutoscale(db, admission, options.runtime?.(admission) ?? nodeAutoscaleRuntime(db, admission, options));
      results.push({ serviceId: item.serviceId, state: 'completed' });
    } catch (error) {
      options.signal?.throwIfAborted();
      // A failed admission rolls its lease back. Defer that record without
      // reviving its previous worker, so it cannot starve the next batch.
      const now = new Date();
      await db.update(nodeAutoscaleTransitions).set({ workerToken: null, leaseUntil: new Date(now.getTime() + NODE_AUTOSCALE_LEASE_MS) }).where(and(
        eq(nodeAutoscaleTransitions.serviceId, item.serviceId), notInArray(nodeAutoscaleTransitions.phase, ['held']),
        or(isNull(nodeAutoscaleTransitions.leaseUntil), lte(nodeAutoscaleTransitions.leaseUntil, now)),
      ));
      options.log?.(`Node autoscale recovery for service #${item.serviceId} is unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ serviceId: item.serviceId, state: 'failed' });
    }
  }
  return results;
}
