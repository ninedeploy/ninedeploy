import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { databases, metrics, services, serviceWorkspaces, workspaceMembers } from '@ninedeploy/db';
import { metricQuery } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { parseId as num } from '../lib/errors.js';
import { loadServiceForUser, visibleDatabaseIds } from '../lib/resourceAccess.js';

const MB = 1024 * 1024;

/** Live resource snapshot: host + every running container mapped to its service/database. */
export const statsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const user = req.user!;
    const { containers, host } = app.stats.raw();
    const [allServices, allDatabases, visibleDatabases, userWsMemberships] = await Promise.all([
      app.db.select().from(services),
      app.db.select().from(databases),
      visibleDatabaseIds(app.db, user),
      app.db
        .select({ id: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user.id)),
    ]);
    const userWsIds = userWsMemberships.map((w) => w.id);
    // Services the caller can see: owned, or tagged into a workspace they
    // belong to, or everything (for operators).
    const visibleServiceIds = user.isOperator
      ? new Set(allServices.map((s) => s.id))
      : await (async () => {
          if (userWsIds.length === 0) {
            const owned = await app.db
              .select({ id: services.id })
              .from(services)
              .where(eq(services.ownerUserId, user.id));
            return new Set(owned.map((s) => s.id));
          }
          const [owned, tagged] = await Promise.all([
            app.db.select({ id: services.id }).from(services).where(eq(services.ownerUserId, user.id)),
            app.db
              .select({ id: serviceWorkspaces.serviceId })
              .from(serviceWorkspaces)
              .where(inArray(serviceWorkspaces.workspaceId, userWsIds)),
          ]);
          const set = new Set<number>();
          for (const r of owned) set.add(r.id);
          for (const r of tagged) set.add(r.id);
          return set;
        })();
    const svcs = allServices.filter((s) => visibleServiceIds.has(s.id));
    const dbs = visibleDatabases === null
      ? allDatabases
      : allDatabases.filter((database) => visibleDatabases.includes(database.id));

    const out: Array<{
      name: string;
      kind: 'service' | 'database';
      refId: number;
      refName: string;
      engine?: string;
      cpuPct: number;
      memMb: number;
      memLimitMb: number;
    }> = [];

    for (const s of svcs) {
      const cname = s.runtimeId ?? `nd-app-${s.slug}`;
      const st = (s.runtimeId ? containers.get(s.runtimeId) : undefined) ?? containers.get(`nd-app-${s.slug}`);
      if (!st) continue;
      out.push({
        name: cname,
        kind: 'service',
        refId: s.id,
        refName: s.name,
        cpuPct: st.cpuPct,
        memMb: +(st.memBytes / MB).toFixed(1),
        memLimitMb: st.memLimitBytes ? Math.round(st.memLimitBytes / MB) : 0,
      });
    }
    for (const d of dbs) {
      const cname = d.containerName ?? `nd-db-${d.name}`;
      const st = containers.get(cname);
      if (!st) continue;
      out.push({
        name: cname,
        kind: 'database',
        refId: d.id,
        refName: d.name,
        engine: d.engine,
        cpuPct: st.cpuPct,
        memMb: +(st.memBytes / MB).toFixed(1),
        memLimitMb: st.memLimitBytes ? Math.round(st.memLimitBytes / MB) : 0,
      });
    }
    // r469: host telemetry is operator-only. The host card exposes machine
    // capacity and the aggregate load of EVERY tenant's workloads — members
    // keep their own services' container stats (scoped above), but not the
    // machine-wide figures. The schema's host is nullable precisely for this.
    return { host: user.isOperator ? host : null, containers: out };
  });
};

/** Historical metric series for a service. Mounted under /services. */
export const metricRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/metrics', async (req) => {
    const id = num((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const q = metricQuery.parse(req.query);
    const kind = q.kind;
    const minutes = q.minutes;
    const since = new Date(Date.now() - minutes * 60_000);
    const rows = await app.db.query.metrics.findMany({
      where: and(eq(metrics.serviceId, id), eq(metrics.kind, kind), gte(metrics.ts, since)),
      orderBy: asc(metrics.ts),
      limit: 1000,
    });

    let points = rows.map((r) => ({
      ts: r.ts.toISOString(),
      value: kind === 'memory' ? Math.round(r.value / (1024 * 1024)) : r.value / 100,
    }));

    if (points.length === 0) {
      const { containers } = app.stats.raw();
      const svc = await app.db.query.services.findFirst({ where: eq(services.id, id) });
      if (svc) {
        const st = (svc.runtimeId ? containers.get(svc.runtimeId) : undefined) ?? containers.get(`nd-app-${svc.slug}`);
        if (st) {
          points = [
            {
              ts: new Date().toISOString(),
              value: kind === 'memory' ? Math.round(st.memBytes / (1024 * 1024)) : +st.cpuPct.toFixed(1),
            },
          ];
        }
      }
    }

    return {
      kind,
      points,
    };
  });
};
