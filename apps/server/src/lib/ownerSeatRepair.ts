import { and, eq, ne } from 'drizzle-orm';
import { workspaceMembers, workspaces, type DB } from '@ninedeploy/db';

/**
 * D1/F146 (F1000): boot repair for personal workspaces created by SSO
 * auto-enroll before the fix. The OIDC callback used to seat the new user in
 * the personal workspace it had just created for them (ownerId = the user)
 * with the provider's defaultRole, so they owned a workspace they could not
 * rename, invite into, or repair (the role routes refuse to change the
 * owner's seat outside a transfer, and a transfer needs an owner seat).
 *
 * Every other code path keeps the owner's seat at 'owner' (POST /workspaces
 * seats owner, the role PATCH refuses to demote ownerId, a transfer swaps
 * ownerId and both seats together), so "ownerId holds a non-owner seat" is
 * only ever this defect. The repair upgrades exactly that one seat, and only
 * when no other member holds an owner seat (an ambiguous workspace is logged
 * and left alone). It never inserts or deletes a seat and never touches any
 * other member. Idempotent: a second run finds nothing, so it simply runs on
 * every boot.
 */
export interface OwnerSeatRepairResult {
  /** workspace_members ids upgraded to 'owner'. */
  repaired: number[];
  /** Workspaces skipped because another member already holds an owner seat. */
  ambiguous: number[];
}

export async function repairOwnerSeats(
  db: Pick<DB, 'select' | 'update'>,
  warn: (msg: string, detail: Record<string, unknown>) => void = () => undefined,
): Promise<OwnerSeatRepairResult> {
  const result: OwnerSeatRepairResult = { repaired: [], ambiguous: [] };
  const stale = await db
    .select({ seatId: workspaceMembers.id, workspaceId: workspaces.id, userId: workspaces.ownerId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(
      workspaces,
      and(eq(workspaces.id, workspaceMembers.workspaceId), eq(workspaces.ownerId, workspaceMembers.userId)),
    )
    .where(ne(workspaceMembers.role, 'owner'));
  for (const row of stale) {
    const otherOwners = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, row.workspaceId),
          eq(workspaceMembers.role, 'owner'),
          ne(workspaceMembers.userId, row.userId),
        ),
      );
    if (otherOwners.length > 0) {
      result.ambiguous.push(row.workspaceId);
      continue;
    }
    await db
      .update(workspaceMembers)
      .set({ role: 'owner', updatedAt: new Date() })
      .where(and(eq(workspaceMembers.id, row.seatId), ne(workspaceMembers.role, 'owner')));
    result.repaired.push(row.seatId);
  }
  if (result.repaired.length > 0 || result.ambiguous.length > 0) {
    warn('workspace owner seats repaired (D1/F146)', { ...result });
  }
  return result;
}
