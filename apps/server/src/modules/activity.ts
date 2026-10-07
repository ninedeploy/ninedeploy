import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, users } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';

const PAGE_SIZE = 50;

const listQuery = z.object({
  entity: z.string().optional(),
  /**
   * D3: one service's trail (web ActivityTab). Rows that carry
   * `meta.serviceId` match by id only; rows without it fall back to the
   * legacy bare-name `entity` match.
   */
  serviceId: z.coerce.number().int().positive().optional(),
  action: z.string().optional(),
  userId: z.coerce.number().int().positive().optional(),
  /** Cursor: return rows strictly older than this audit id. */
  before: z.coerce.number().int().positive().optional(),
});

/** `meta.serviceId` of an audit row, or NULL (no meta / no key / not JSON). */
const metaServiceId = sql`(CASE WHEN json_valid(${auditLog.meta}) THEN json_extract(${auditLog.meta}, '$.serviceId') END)`;

/**
 * D3/F836/F837: an `?entity=` filter matches BOTH entity formats — the legacy
 * bare name ("api", how service.stop/start/restart and deploy.trigger were
 * audited before D3) and `<name> #<id>` with exactly one appended numeric id
 * ("api #7" / "api #99", the shape kernel/auditBridge decodes). The range
 * keeps the (entity, ts) index usable: every string that starts with
 * "<name> #" sorts in ["<name> #", "<name> $"). SQLite substr() counts code
 * points, hence Array.from for the prefix length.
 */
function entityFilter(entity: string): SQL {
  const prefix = `${entity} #`;
  const n = Array.from(prefix).length;
  return or(
    eq(auditLog.entity, entity),
    and(
      sql`${auditLog.entity} >= ${prefix}`,
      sql`${auditLog.entity} < ${`${entity} $`}`,
      sql`length(${auditLog.entity}) > ${n}`,
      sql`substr(${auditLog.entity}, ${n + 1}) NOT GLOB '*[^0-9]*'`,
    ),
  )!;
}

/**
 * D3: one service's trail. A row that carries `meta.serviceId` (every
 * id-bearing producer: lifecycle, deploy.trigger, deploy outcomes,
 * alert.service_down, ...) belongs to that id and nothing else — so another
 * service NAMED "api #7" can neither inject rows into service 7's trail nor
 * pick up its rows. Rows without it (history, bare-name producers such as
 * service.update) keep the exact legacy match on the service name.
 */
function serviceFilter(serviceId: number, name: string | undefined): SQL {
  const byId = sql`${metaServiceId} = ${serviceId}`;
  if (!name) return byId;
  return or(byId, and(eq(auditLog.entity, name), isNull(metaServiceId)))!;
}

/** Recent activity (audit log). Mounted under /activity. */
export const activityRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // Audit rows do not carry a workspace/resource id, so they cannot be
  // tenant-scoped reliably. Keep the instance-wide feed operator-only.
  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async (req) => {
    const q = listQuery.parse(req.query);
    const filters: SQL[] = [];
    if (q.serviceId) filters.push(serviceFilter(q.serviceId, q.entity));
    else if (q.entity) filters.push(entityFilter(q.entity));
    if (q.action) filters.push(eq(auditLog.action, q.action));
    if (q.userId) filters.push(eq(auditLog.userId, q.userId));
    if (q.before) filters.push(lt(auditLog.id, q.before));
    const rows = await app.db.query.auditLog.findMany({
      where: filters.length ? and(...filters) : undefined,
      orderBy: desc(auditLog.id),
      limit: PAGE_SIZE,
    });

    const userIds = Array.from(new Set(rows.map((r) => r.userId).filter((id): id is number => id !== null)));
    const userMap = new Map<number, { name: string | null; email: string }>();
    if (userIds.length > 0) {
      try {
        const usersList = await app.db.query.users.findMany({
          where: inArray(users.id, userIds),
        });
        for (const u of usersList) {
          userMap.set(u.id, { name: u.name, email: u.email });
        }
      } catch {
        /* fallback if query is mocked or down */
      }
    }

    return {
      entries: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userName: r.userId ? userMap.get(r.userId)?.name ?? null : null,
        userEmail: r.userId ? userMap.get(r.userId)?.email ?? null : null,
        action: r.action,
        entity: r.entity,
        meta: r.meta ?? null,
        ts: r.ts.toISOString(),
      })),
      nextCursor: rows.length === PAGE_SIZE ? rows[PAGE_SIZE - 1]!.id : null,
    };
  });
};
