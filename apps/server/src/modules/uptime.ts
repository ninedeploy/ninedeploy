import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { services, statusPages, uptimeChecks, uptimeMonitors } from '@ninedeploy/db';
import {
  type MonitorCheckView,
  type MonitorKind,
  monitorCreate,
  monitorPatch,
  monitorTargetProblem,
  type MonitorView,
  statusPageCreate,
  statusPagePatch,
  statusPageSlug,
  type StatusPageView,
} from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, isUniqueViolation, notFound, parseId } from '../lib/errors.js';
import { visibleServiceIdSet } from '../lib/resourceAccess.js';
import { cachedPublicStatusPage, clearStatusPageCache, renderStatusPageHtml } from '../lib/statusPage.js';
import { monitorUptimes, probeMonitor, recordCheck, type UptimeMonitorRow } from '../lib/uptime.js';

/**
 * 0.16.8 uptime monitors and status pages (docs/UPTIME.md).
 *
 *  - `/v1/monitors` — operators manage; anyone reads the monitors of the
 *    services they can see (an operator-only monitor has no service), as
 *    with alert rules.
 *  - `/v1/status-pages` — operator only.
 *  - `/v1/status/:slug` (JSON) and `/status/:slug` (HTML) — public, for a
 *    published page only.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function serializeMonitor(m: UptimeMonitorRow, uptime?: MonitorView['uptime']): MonitorView {
  return {
    id: m.id,
    name: m.name,
    serviceId: m.serviceId ?? null,
    kind: m.kind,
    target: m.target,
    method: m.method === 'HEAD' ? 'HEAD' : 'GET',
    expectedStatus: m.expectedStatus,
    keyword: m.keyword ?? null,
    intervalSeconds: m.intervalSeconds,
    timeoutSeconds: m.timeoutSeconds,
    failuresBeforeDown: m.failuresBeforeDown,
    followRedirects: !!m.followRedirects,
    verifyTls: !!m.verifyTls,
    enabled: !!m.enabled,
    status: m.status,
    statusSince: iso(m.statusSince),
    consecutiveFailures: m.consecutiveFailures,
    lastCheckedAt: iso(m.lastCheckedAt),
    lastResponseMs: m.lastResponseMs ?? null,
    lastStatusCode: m.lastStatusCode ?? null,
    lastError: m.lastError ?? null,
    certExpiresAt: iso(m.certExpiresAt),
    uptime: uptime ?? { h24: null, d7: null, d30: null },
    createdAt: m.createdAt.toISOString(),
  };
}

export function serializeStatusPage(p: typeof statusPages.$inferSelect): StatusPageView {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description ?? null,
    notice: p.notice ?? null,
    published: !!p.published,
    showResponseTimes: !!p.showResponseTimes,
    monitorIds: Array.isArray(p.monitorIds) ? p.monitorIds : [],
    path: `/status/${p.slug}`,
    createdAt: p.createdAt.toISOString(),
  };
}

export const monitorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  /** The monitor when the caller may see it, else 404. */
  const visibleMonitor = async (req: Parameters<typeof visibleServiceIdSet>[1], id: number): Promise<UptimeMonitorRow> => {
    const m = await app.db.query.uptimeMonitors.findFirst({ where: eq(uptimeMonitors.id, id) });
    if (!m) throw notFound('Monitor not found');
    const visible = await visibleServiceIdSet(app.db, req);
    if (visible !== null && (m.serviceId == null || !visible.has(m.serviceId))) throw notFound('Monitor not found');
    return m;
  };

  const assertService = async (serviceId: number | null | undefined) => {
    if (serviceId == null) return;
    const svc = await app.db.query.services.findFirst({ where: eq(services.id, serviceId), columns: { id: true } });
    if (!svc) throw badRequest('Service not found', 'service_not_found');
  };

  app.get('/', async (req) => {
    const all = await app.db.select().from(uptimeMonitors).orderBy(desc(uptimeMonitors.id));
    const visible = await visibleServiceIdSet(app.db, req.user!);
    const rows = visible === null ? all : all.filter((m) => m.serviceId != null && visible.has(m.serviceId));
    const q = req.query as { serviceId?: string };
    const filtered = q.serviceId ? rows.filter((m) => m.serviceId === parseId(q.serviceId!, 'Invalid serviceId')) : rows;
    const uptimes = await monitorUptimes(app.db, filtered.map((m) => m.id));
    return filtered.map((m) => serializeMonitor(m, uptimes.get(m.id)));
  });

  app.get('/:id', async (req) => {
    const m = await visibleMonitor(req.user!, parseId((req.params as { id: string }).id));
    return serializeMonitor(m, (await monitorUptimes(app.db, [m.id])).get(m.id));
  });

  /** The checks of the last `hours` (1–168, default 24), newest first. */
  app.get('/:id/checks', async (req): Promise<MonitorCheckView[]> => {
    const m = await visibleMonitor(req.user!, parseId((req.params as { id: string }).id));
    const raw = Number((req.query as { hours?: string }).hours ?? 24);
    const hours = Number.isInteger(raw) && raw >= 1 && raw <= 168 ? raw : 24;
    const rows = await app.db
      .select()
      .from(uptimeChecks)
      .where(and(eq(uptimeChecks.monitorId, m.id), gte(uptimeChecks.ts, new Date(Date.now() - hours * 3600_000))))
      .orderBy(desc(uptimeChecks.ts))
      .limit(5000);
    return rows.map((r) => ({ ts: r.ts.toISOString(), ok: !!r.ok, responseMs: r.responseMs ?? null, statusCode: r.statusCode ?? null, error: r.error ?? null }));
  });

  app.post('/', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const input = monitorCreate.parse(req.body);
    await assertService(input.serviceId);
    const [row] = await app.db
      .insert(uptimeMonitors)
      .values({ ...input, status: input.enabled ? 'pending' : 'paused', statusSince: new Date() })
      .returning();
    void audit(app.db, req.user!.id, 'monitor.create', `${row!.name} #${row!.id}`, row!.serviceId != null ? { serviceId: row!.serviceId } : undefined);
    reply.code(201);
    return serializeMonitor(row!);
  });

  app.patch('/:id', { preHandler: [app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = monitorPatch.parse(req.body ?? {});
    const current = await app.db.query.uptimeMonitors.findFirst({ where: eq(uptimeMonitors.id, id) });
    if (!current) throw notFound('Monitor not found');
    if (input.serviceId !== undefined) await assertService(input.serviceId);
    // The merged shape is checked again: a patch may change only one half of a pair.
    const kind = (input.kind ?? current.kind) as MonitorKind;
    const target = input.target ?? current.target;
    const keyword = input.keyword !== undefined ? input.keyword : current.keyword;
    const method = input.method ?? current.method;
    const problem = monitorTargetProblem(kind, target);
    if (problem) throw badRequest(`target: ${problem}`);
    if (keyword && kind === 'tcp') throw badRequest('keyword: a keyword applies to HTTP checks');
    if (keyword && method === 'HEAD') throw badRequest('keyword: a HEAD request has no body to search; use GET');
    const reprobe = input.kind !== undefined || input.target !== undefined;
    const state: Partial<typeof uptimeMonitors.$inferInsert> = {};
    if (input.enabled === false && current.enabled) Object.assign(state, { status: 'paused', consecutiveFailures: 0, statusSince: new Date() });
    else if ((input.enabled === true && !current.enabled) || (reprobe && current.enabled)) {
      Object.assign(state, { status: 'pending', consecutiveFailures: 0, statusSince: new Date(), lastCheckedAt: null });
    }
    const [row] = await app.db.update(uptimeMonitors).set({ ...input, ...state }).where(eq(uptimeMonitors.id, id)).returning();
    clearStatusPageCache();
    void audit(app.db, req.user!.id, 'monitor.update', `${row!.name} #${row!.id}`, row!.serviceId != null ? { serviceId: row!.serviceId } : undefined);
    return serializeMonitor(row!, (await monitorUptimes(app.db, [row!.id])).get(row!.id));
  });

  app.delete('/:id', { preHandler: [app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const [gone] = await app.db.delete(uptimeMonitors).where(eq(uptimeMonitors.id, id)).returning();
    if (!gone) throw notFound('Monitor not found');
    clearStatusPageCache();
    void audit(app.db, req.user!.id, 'monitor.delete', `${gone.name} #${gone.id}`, gone.serviceId != null ? { serviceId: gone.serviceId } : undefined);
    return { ok: true };
  });

  /** Run a check now and record it (the state and alerts follow it as for a scheduled one). */
  app.post('/:id/check', { preHandler: [app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const m = await app.db.query.uptimeMonitors.findFirst({ where: eq(uptimeMonitors.id, id) });
    if (!m) throw notFound('Monitor not found');
    const result = await probeMonitor(m);
    const row = await recordCheck(app.db, m, result);
    return {
      check: { ts: new Date().toISOString(), ok: result.ok, responseMs: result.responseMs, statusCode: result.statusCode, error: result.error },
      monitor: serializeMonitor(row, (await monitorUptimes(app.db, [row.id])).get(row.id)),
    };
  });
};

export const statusPageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  const assertMonitors = async (ids: number[] | undefined) => {
    if (!ids?.length) return;
    const found = await app.db.select({ id: uptimeMonitors.id }).from(uptimeMonitors).where(inArray(uptimeMonitors.id, ids));
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw badRequest(`Monitor not found: ${missing.join(', ')}`, 'monitor_not_found');
  };
  const taken = (err: unknown, slug: string | undefined) => {
    if (slug && isUniqueViolation(err)) return conflict(`The slug "${slug}" is taken by another status page.`);
    return err;
  };

  app.get('/', async () => (await app.db.select().from(statusPages).orderBy(desc(statusPages.id))).map(serializeStatusPage));

  app.get('/:id', async (req) => {
    const p = await app.db.query.statusPages.findFirst({ where: eq(statusPages.id, parseId((req.params as { id: string }).id)) });
    if (!p) throw notFound('Status page not found');
    return serializeStatusPage(p);
  });

  app.post('/', async (req, reply) => {
    const input = statusPageCreate.parse(req.body);
    await assertMonitors(input.monitorIds);
    let row: typeof statusPages.$inferSelect | undefined;
    try {
      [row] = await app.db.insert(statusPages).values(input).returning();
    } catch (err) {
      throw taken(err, input.slug);
    }
    clearStatusPageCache();
    void audit(app.db, req.user!.id, 'status_page.create', `${row!.title} #${row!.id}`);
    reply.code(201);
    return serializeStatusPage(row!);
  });

  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = statusPagePatch.parse(req.body ?? {});
    await assertMonitors(input.monitorIds);
    let row: typeof statusPages.$inferSelect | undefined;
    try {
      [row] = await app.db.update(statusPages).set(input).where(eq(statusPages.id, id)).returning();
    } catch (err) {
      throw taken(err, input.slug);
    }
    if (!row) throw notFound('Status page not found');
    clearStatusPageCache();
    void audit(app.db, req.user!.id, 'status_page.update', `${row.title} #${row.id}`);
    return serializeStatusPage(row);
  });

  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const [gone] = await app.db.delete(statusPages).where(eq(statusPages.id, id)).returning();
    if (!gone) throw notFound('Status page not found');
    clearStatusPageCache();
    void audit(app.db, req.user!.id, 'status_page.delete', `${gone.title} #${gone.id}`);
    return { ok: true };
  });
};

/** Public: `GET /v1/status/:slug`, a published page as JSON. */
export const publicStatusRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:slug', async (req, reply) => {
    const slug = statusPageSlug.safeParse((req.params as { slug: string }).slug);
    const page = slug.success ? await cachedPublicStatusPage(app.db, slug.data) : null;
    if (!page) throw notFound('Status page not found');
    reply.header('cache-control', 'public, max-age=30');
    return page;
  });
};

/** Public: `GET /status/:slug`, a published page as HTML (outside /v1, registered before the SPA). */
export const publicStatusHtmlRoutes: FastifyPluginAsync = async (app) => {
  app.get('/status/:slug', async (req, reply) => {
    const slug = statusPageSlug.safeParse((req.params as { slug: string }).slug);
    const page = slug.success ? await cachedPublicStatusPage(app.db, slug.data) : null;
    reply.header('cache-control', 'public, max-age=30');
    if (!page) {
      reply.code(404).type('text/html; charset=utf-8');
      return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><p>Status page not found.</p></body></html>';
    }
    reply.type('text/html; charset=utf-8');
    return renderStatusPageHtml(page);
  });
};
