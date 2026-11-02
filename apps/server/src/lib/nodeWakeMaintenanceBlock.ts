import { nodeWakeMaintenance, type DB } from '@ninedeploy/db';
import { and, eq, ne } from 'drizzle-orm';

/** Worker expiry permits recovery, never admission past an unresolved remote effect. */
export async function nodeWakeMaintenancePending(db: Pick<DB, 'select'>, serverId: number) {
  return (await db.select({ id: nodeWakeMaintenance.serverId }).from(nodeWakeMaintenance).where(and(
    eq(nodeWakeMaintenance.serverId, serverId), ne(nodeWakeMaintenance.phase, 'completed'))).limit(1)).length > 0;
}
