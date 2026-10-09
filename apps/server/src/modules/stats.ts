import { and, asc, eq, gte } from 'drizzle-orm';
import { databases, metrics, services } from '@ninedeploy/db';
import { metricQuery } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { parseId as num } from '../lib/errors.js';
import { loadServiceForUser, visibleDatabaseIds, visibleServiceIdSet } from '../lib/resourceAccess.js';
import { swarmContainerStat, swarmRuntimeOf } from '../lib/swarm.js';

const MB = 1024 * 1024;

/** Live resource snapshot: host + every running container mapped to its service/database. */
export const statsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const user = req.user!;
    const { containers, host } = app.stats.raw();
    const [allServices, allDatabases, visibleDatabases, visibleServices] = await Promise.all([
      app.db.select().from(services),
      app.db.select().from(databases),
      visibleDatabaseIds(app.db, user),
      // r694: the one shared visibility answer (`null` = operator, all). This
      // route kept its own copy that still let a creator see the live stats of
      // a team service after losing their seat.
      visibleServiceIdSet(app.db, user),
    ]);
    const svcs = visibleServices === null ? allServices : allServices.filter((s) => visibleServices.has(s.id));
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
      // 0.16 T7: a Swarm service's figure is its local tasks summed (design §7.4).
      const swarmRuntime = swarmRuntimeOf(s);
      const st = swarmRuntime
        ? swarmContainerStat(containers, swarmRuntime)
        : ((s.runtimeId ? containers.get(s.runtimeId) : undefined) ?? containers.get(`nd-app-${s.slug}`));
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
        // 0.16 T7: a Swarm service's figure is its local tasks summed.
        const swarmRuntime = swarmRuntimeOf(svc);
        const st = swarmRuntime
          ? swarmContainerStat(containers, swarmRuntime)
          : ((svc.runtimeId ? containers.get(svc.runtimeId) : undefined) ?? containers.get(`nd-app-${svc.slug}`));
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
