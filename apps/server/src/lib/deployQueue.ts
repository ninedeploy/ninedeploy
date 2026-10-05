import { and, DrizzleQueryError, eq, sql } from 'drizzle-orm';
import { deployments, type DB } from '@ninedeploy/db';
import { badRequest } from './errors.js';
import { assertMayDeployStoredService } from './hostPrivilege.js';
import type { AuthedUser } from './resourceAccess.js';

/**
 * r640: the ONE way a signed-in caller puts a deployment on the queue.
 *
 * `POST /services/:id/deploys` carried the two guards a user-triggered deploy
 * needs — the stored-definition privilege check (a member must not redeploy an
 * operator-authored compose / static / PM2 / lifecycle-hook / docker-socket
 * service, because the deploy is what executes on the host) and the
 * per-service queued cap. The volume routes inserted their own `queued` rows
 * and skipped both: a member attaching, editing or detaching a volume on such
 * a service got the host-executing redeploy anyway, without limit. Every
 * user-triggered enqueue now goes through here so the paths cannot drift
 * again; `test/deployQueueWiring.test.ts` refuses a new direct
 * `insert(deployments)` of a queued row anywhere under `modules/`.
 */

/** Queued rows one service may hold — a runaway client must not grow the
 *  queue without bound, while a legitimate second click still stacks. */
export const MAX_QUEUED_PER_SERVICE = 50;

export interface EnqueueTarget {
  id: number;
  type: string;
  dockerSocket?: boolean | null;
}

/**
 * Throws 403 (privileged stored definition, non-operator caller) or 400
 * (queue full) — call this BEFORE any side effect a route performs ahead of
 * its redeploy, so a refused enqueue leaves nothing half-applied.
 */
export async function assertMayEnqueueDeploy(
  db: DB,
  user: AuthedUser,
  service: EnqueueTarget,
  opts: { subject?: string } = {},
): Promise<void> {
  await assertMayDeployStoredService(db, user, service);
  const queuedRows = await db.query.deployments.findMany({
    where: and(eq(deployments.serviceId, service.id), eq(deployments.status, 'queued')),
    columns: { id: true },
  });
  if (queuedRows.length >= MAX_QUEUED_PER_SERVICE) {
    throw badRequest(
      `${opts.subject ?? 'Service'} already has ${queuedRows.length} queued deploys (max ${MAX_QUEUED_PER_SERVICE}). Cancel one first.`,
    );
  }
}

/**
 * Re-checks {@link assertMayEnqueueDeploy} and inserts the `queued` row the
 * worker claims. Returns the new deployment id. Auditing stays with the
 * caller: each route records its own action (`deploy.trigger`,
 * `service.volume.attach`, …).
 */
export async function enqueueUserDeploy(
  db: DB,
  user: AuthedUser,
  service: EnqueueTarget,
  values: { message: string; commitSha?: string | null; imageDigest?: string | null },
  opts: { subject?: string } = {},
): Promise<number> {
  await assertMayEnqueueDeploy(db, user, service, opts);
  const [dep] = await db
    .insert(deployments)
    .values({
      serviceId: service.id,
      status: 'queued',
      // Recheck inside the insert: a concurrent enqueue may fill the last slot.
      // NULL makes the existing trigger constraint abort that losing insert.
      trigger: sql`(select case when count(*) < ${MAX_QUEUED_PER_SERVICE} then 'user' else null end
        from ${deployments} where ${deployments.serviceId} = ${service.id} and ${deployments.status} = 'queued')`,
      message: values.message,
      ...(values.commitSha !== undefined ? { commitSha: values.commitSha } : {}),
      ...(values.imageDigest !== undefined ? { imageDigest: values.imageDigest } : {}),
    })
    .returning({ id: deployments.id })
    .catch((err: unknown) => {
      if (err instanceof DrizzleQueryError && err.cause?.message.endsWith('NOT NULL constraint failed: deployments.trigger')) {
        throw badRequest(`${opts.subject ?? 'Service'} reached the queued deploy limit (max ${MAX_QUEUED_PER_SERVICE}). Cancel one first.`);
      }
      throw err;
    });
  if (!dep) throw new Error('Could not queue the deployment');
  return dep.id;
}
