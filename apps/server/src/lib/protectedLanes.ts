import { and, eq, inArray, lt } from 'drizzle-orm';
import { deployments, environments, services, workspaceMembers, type DB } from '@ninedeploy/db';
import type { WorkspaceRole } from '@ninedeploy/schemas';
import { grantRoleForService, grantsForUser } from './accessGrants.js';
import { HttpError } from './errors.js';
import { roleAtLeast, serviceRole, type AuthedUser } from './resourceAccess.js';

type DbLike = Pick<DB, 'query' | 'select' | 'insert' | 'update' | 'delete'>;

/** 403 with its own code, so a client can tell a lane refusal from a role one. */
const laneRefusal = (message: string) => new HttpError(403, 'protected_lane', message);

/**
 * 0.16.13 protected lanes and deploy approvals. Two switches on a lane
 * (`environments`), both off by default, both admin-only to change:
 *
 *  - `protected`: the variable values, deploy and runtime logs and shells of
 *    the lane's services are for those holding `admin` or higher on the
 *    service. A member still edits the service, sets variables (write-only)
 *    and pushes code — git deploys keep working — but cannot read back what
 *    production holds.
 *  - `requireApproval`: a deploy into the lane waits as `awaiting_approval`
 *    until an admin approves it (→ `queued`) or rejects it (→ `cancelled`).
 *    The worker turns a fresh `queued` row into a waiting one at claim time
 *    (`holdForApprovalIfNeeded`), so every trigger path — webhook, schedule,
 *    image poll, API, volume edits — is gated without each insert knowing.
 *    A deploy an admin starts is approved at insert (`approvalStamp`).
 *
 * "Admin" is `isLaneAdmin`: an operator, an admin or owner seat in the
 * lane's workspace, or an admin grant covering the service.
 */

export interface LaneRules {
  id: number;
  workspaceId: number;
  name: string;
  protected: boolean;
  requireApproval: boolean;
}

/**
 * The lane a service sits in, with its two switches; null outside any lane.
 * A PR preview sits in no lane of its own and takes its parent's: a preview
 * runs the PR's code with the parent's variables, so a protected parent's
 * preview logs and an approval-gated parent's preview deploys are guarded too.
 */
export async function laneRules(
  db: DbLike,
  service: { environmentId?: number | null; previewParentServiceId?: number | null },
): Promise<LaneRules | null> {
  let environmentId = service.environmentId ?? null;
  if (environmentId == null && service.previewParentServiceId != null) {
    const parent = await db.query.services.findFirst({
      where: eq(services.id, service.previewParentServiceId),
      columns: { environmentId: true },
    });
    environmentId = parent?.environmentId ?? null;
  }
  if (environmentId == null) return null;
  const row = await db.query.environments.findFirst({
    where: eq(environments.id, environmentId),
    columns: { id: true, workspaceId: true, name: true, protected: true, requireApproval: true },
  });
  return row ?? null;
}

type ServiceRef = {
  id: number;
  ownerUserId: number | null;
  environmentId?: number | null;
  previewParentServiceId?: number | null;
};

/**
 * True when the caller is an admin of the lane's rules for this service: an
 * operator, an admin or owner seat in the lane's workspace, or an admin grant
 * covering the service. Being the service's creator is not enough here, unlike
 * `serviceRole`: a member who clones a protected service or creates one in
 * the lane would otherwise read its secrets, or approve their own deploy.
 * Outside any lane it falls back to `admin` on the service.
 */
export async function isLaneAdmin(db: DbLike, service: ServiceRef, user: AuthedUser): Promise<boolean> {
  if (user.isOperator) return true;
  const lane = await laneRules(db, service);
  if (!lane) {
    const role = await serviceRole(db, service, user);
    return role !== null && roleAtLeast(role, 'admin');
  }
  const seat = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, lane.workspaceId), eq(workspaceMembers.userId, user.id)),
    columns: { role: true },
  });
  if (seat && roleAtLeast(seat.role as WorkspaceRole, 'admin')) return true;
  return (await grantRoleForService(db, await grantsForUser(db, user.id), service)) === 'admin';
}

/** May the caller read the service's secrets and logs? Always true outside a protected lane. */
export async function maySeeLaneSecrets(db: DbLike, service: ServiceRef, user: AuthedUser): Promise<boolean> {
  const lane = await laneRules(db, service);
  if (!lane?.protected) return true;
  return isLaneAdmin(db, service, user);
}

/**
 * Throws 403 `protected_lane` unless the caller may read the service's
 * secrets and logs. `what` names the thing refused ("variable values",
 * "deploy logs", …) so the message says what an admin can still see.
 */
export async function assertMaySeeLaneSecrets(
  db: DbLike,
  service: ServiceRef,
  user: AuthedUser,
  what: string,
): Promise<void> {
  const lane = await laneRules(db, service);
  if (!lane?.protected) return;
  if (await isLaneAdmin(db, service, user)) return;
  throw laneRefusal(`"${lane.name}" is a protected lane: its ${what} are for workspace admins only`);
}

/**
 * Throws 403 unless the caller may take a service out of its lane. Leaving a
 * protected or approval-gated lane would lift the gate itself, so it needs
 * `admin`; joining one, or moving between ordinary lanes, does not.
 */
export async function assertMayLeaveLane(
  db: DbLike,
  service: ServiceRef,
  user: AuthedUser,
  nextEnvironmentId: number | null,
): Promise<void> {
  if ((service.environmentId ?? null) === nextEnvironmentId) return;
  const lane = await laneRules(db, service);
  if (!lane || (!lane.protected && !lane.requireApproval)) return;
  if (await isLaneAdmin(db, service, user)) return;
  throw laneRefusal(`Only a workspace admin may move a service out of the "${lane.name}" lane`);
}

/**
 * The review columns of a deploy an admin starts into an approval-gated lane:
 * it is approved by the act of starting it. Empty for everything else, so
 * the row is gated at claim time if it has to be.
 */
export async function approvalStamp(
  db: DbLike,
  service: ServiceRef,
  user: AuthedUser,
): Promise<{ reviewedBy?: number; reviewedAt?: Date }> {
  const lane = await laneRules(db, service);
  if (!lane?.requireApproval) return {};
  if (!(await isLaneAdmin(db, service, user))) return {};
  return { reviewedBy: user.id, reviewedAt: new Date() };
}

/**
 * Called by the worker for a `queued` row it is about to claim. When the
 * service's lane requires approval and nobody reviewed the row yet, flip it
 * to `awaiting_approval` (only while still `queued`) and return true: the
 * worker skips it. Returns false when the row may build.
 */
export async function holdForApprovalIfNeeded(
  db: DbLike,
  row: { id: number; environmentId: number | null; previewParentServiceId: number | null; reviewedAt: Date | null },
): Promise<boolean> {
  if (row.reviewedAt != null || (row.environmentId == null && row.previewParentServiceId == null)) return false;
  const lane = await laneRules(db, row);
  if (!lane?.requireApproval) return false;
  const held = await db
    .update(deployments)
    .set({ status: 'awaiting_approval' })
    .where(and(eq(deployments.id, row.id), eq(deployments.status, 'queued')))
    .returning({ id: deployments.id });
  return held.length > 0;
}

/**
 * When a deploy of a service starts, its older waiting deploys are stale:
 * approving one later would roll the service back to older code. They end
 * as `cancelled`. Returns the ids it ended.
 */
export async function dropStaleApprovals(db: DbLike, serviceId: number, startedId: number): Promise<number[]> {
  const ended = await db
    .update(deployments)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        inArray(deployments.status, ['awaiting_approval']),
        lt(deployments.id, startedId),
      ),
    )
    .returning({ id: deployments.id });
  return ended.map((r) => r.id);
}
