import { auditLog, type DB } from '@ninedeploy/db';
import { eventBus } from './events.js';
import { notifyEvent } from './notifier.js';

/** Optional request context folded into the audit entry's meta. */
export interface AuditContext {
  ip?: string;
  userAgent?: string;
}

/** Write an audit-log entry and emit a real-time event (best-effort, never throws). */
export async function audit(
  db: DB,
  userId: number | null,
  action: string,
  entity?: string,
  meta?: Record<string, unknown>,
  ctx?: AuditContext,
): Promise<void> {
  const enriched: Record<string, unknown> | undefined =
    ctx && (ctx.ip || ctx.userAgent) ? { ...(meta ?? {}), ip: ctx.ip, ua: ctx.userAgent?.slice(0, 200) } : meta;
  try {
    await db.insert(auditLog).values({ userId, action, entity, meta: enriched });
  } catch {
    /* audit logging must never break the request */
  }
  const event = {
    id: 0,
    action,
    entity: entity ?? null,
    ts: new Date().toISOString(),
    actorUserId: userId,
    ...(enriched ? { meta: enriched } : {}),
  };
  // The actor rides along so the /v1/events socket can decide who may see it.
  eventBus.publish(action, entity, userId);
  // Fire-and-forget notification dispatch
  void notifyEvent(db, event).catch(() => undefined);
}
