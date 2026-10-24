import { and, asc, eq, gte } from 'drizzle-orm';
import { databases, metrics, services } from '@ninedeploy/db';
import { metricQuery, observabilityPatch, statsSnapshotQuery } from '@ninedeploy/schemas';
import { OBSERVABILITY_CONFIG_KEY, publicObservabilitySettings, readObservabilitySettings } from '../lib/observabilitySettings.js';
import { prometheusMetrics, resourceMetrics } from '../lib/metricExport.js';
import { audit } from '../lib/audit.js';
import type { FastifyPluginAsync } from 'fastify';
import { parseId as num, notFound, unprocessable } from '../lib/errors.js';
import { loadDatabaseForUser, loadServiceForUser, visibleDatabaseIds, visibleServiceIdSet } from '../lib/resourceAccess.js';
import { swarmContainerStat, swarmRuntimeOf } from '../lib/swarm.js';
import { NODE_METRIC_MAX_AGE_MS, nodeServiceStat } from '../lib/nodeMetrics.js';
import { readMetricPoints } from '../lib/serviceMetricHistory.js';

const MB = 1024 * 1024;

/** Live resource snapshot: host + every running container mapped to its service/database. */
export const statsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);


  const status = () => app.observability?.status() ?? { lastAttemptAt: null, lastSuccessAt: null, result: null };
  app.get('/observability', { preHandler: [app.requireOperator] }, async () => ({
    settings: publicObservabilitySettings(await readObservabilitySettings(app.db)), exportStatus: status(),
  }));
  app.patch('/observability', { preHandler: [app.requireOperator] }, async (req) => {
    const patch = observabilityPatch.parse(req.body);
    const value = { ...await readObservabilitySettings(app.db), ...patch };
    await req.kernel.configCenter.set(OBSERVABILITY_CONFIG_KEY, JSON.stringify(value), {
      isSecret: true, category: 'monitoring', description: 'Resource history, metrics export and log queue limits', userId: req.user!.id,
    });
    void audit(app.db, req.user!.id, 'observability.updated', 'Updated monitoring settings');
    return { settings: publicObservabilitySettings(value), exportStatus: status() };
  });
  app.post('/observability/test', { preHandler: [app.requireOperator] }, async (req) => {
    if (!app.observability) throw unprocessable('Metrics exporter is unavailable');
    const result = await app.observability.exportNow();
    await audit(app.db, req.user!.id, 'observability.export_tested', 'Tested metrics collector', { ok: result.ok, status: result.status, samples: result.samples });
    return result;
  });
  app.get('/prometheus', { preHandler: [app.requireOperator] }, async (_req, reply) => {
    if (!(await readObservabilitySettings(app.db)).prometheusEnabled) throw notFound('Prometheus export is not enabled');
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(prometheusMetrics(await resourceMetrics(app.db)));
  });

  app.get('/', async (req) => {
    const user = req.user!;
    const query = statsSnapshotQuery.parse(req.query);
    if (query.databaseId !== undefined) {
      const database = await loadDatabaseForUser(app.db, query.databaseId, user);
      const raw = app.stats.raw(), nodeId = database.serverId;
      const sample = nodeId == null ? { sampledAt: raw.sampledAt ?? null, error: false } : raw.nodeSamples?.get(nodeId);
      const sampledAt = sample?.sampledAt ?? null;
      const name = (nodeId == null ? database.containerName : database.nodeContainerName) ?? `nd-db-${database.slug}`;
      const stat = (nodeId == null ? raw.containers : raw.nodeContainers?.get(nodeId))?.get(name);
      const state = database.status !== 'running' ? 'stopped' : sample?.error ? 'unavailable'
        : sampledAt == null || !Number.isFinite(sampledAt) ? 'pending'
        : Date.now() - sampledAt > NODE_METRIC_MAX_AGE_MS || sampledAt > Date.now() ? 'stale'
        : !stat || ![stat.cpuPct, stat.memBytes, stat.memLimitBytes].every(value => Number.isFinite(value) && value >= 0) ? 'unavailable' : 'live';
      return { host: null, resource: { kind: 'database', id: database.id, serverId: nodeId, state, sampledAt },
        containers: state === 'live' && stat ? [{ name, kind: 'database', refId: database.id, refName: database.name, engine: database.engine,
          cpuPct: stat.cpuPct, memMb: +(stat.memBytes / MB).toFixed(1), memLimitMb: nodeId != null ? database.memLimitMb ?? 0 : Math.round(stat.memLimitBytes / MB) }] : [] };
    }
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
      // Monitoring's Local Host card consumes this endpoint. Node telemetry
      // belongs to /servers/:id/stats and the service's own history route.
      if (s.serverId != null) continue;
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
      if (d.serverId != null) continue;
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

    let points = minutes > 480 ? await readMetricPoints(app.db, id, kind, minutes) : rows.map((r) => ({
      ts: r.ts.toISOString(),
      value: kind === 'memory' ? Math.round(r.value / (1024 * 1024)) : r.value / 100,
    }));

    if (points.length === 0) {
      const { containers } = app.stats.raw();
      const svc = await app.db.query.services.findFirst({ where: eq(services.id, id) });
      if (svc) {
        // 0.16 T7: a Swarm service's figure is its local tasks summed.
        const swarmRuntime = swarmRuntimeOf(svc);
        const st = svc.serverId != null ? nodeServiceStat(svc, app.stats.raw().nodeContainers?.get(svc.serverId)) : swarmRuntime
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
