import { count, desc, eq, inArray } from 'drizzle-orm';
import { databases, deployments, domains, services, webhooks } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { visibleDatabaseIds, visibleServiceIdSet } from '../lib/resourceAccess.js';
import { capture } from '../lib/exec.js';
import { containerIp } from '../engine/builders/docker.js';
import { TRAEFIK_CONTAINER } from '../engine/proxy.js';
import { buildProbeUrl, safeProbePath } from '../lib/probeUrl.js';
import { ensureDockerImage } from '../lib/dockerPull.js';
import { isSwarmRuntimeId } from '../lib/swarm.js';

// Pinned, never `:latest` — this image runs with the target's network
// namespace on every probe (lib/inventory.ts pins helper images for the same
// supply-chain reason).
const NETNS_PROBE_IMAGE = 'curlimages/curl:8.16.0';

/** F585: docker CLI calls inherit capture()'s 30-minute default timeout; a
 * wedged daemon must not hold the (polled) dashboard request that long. A
 * probe past this deadline reads unhealthy; `docker ps` past it reads null. */
const PROBE_DEADLINE_MS = 10_000;

/** Resolve `fallback` if `p` has not settled within `ms` (never keeps the process alive). */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * The set of service ids a non-operator may see: services they own, plus
 * services tagged into a workspace they belong to. Used by the dashboard
 * (and reusable by other "list everything" endpoints) to keep the same
 * scoping rules that `loadServiceForUser` enforces one-row-at-a-time.
 */

interface HealthStatus {
  serviceId: number;
  name: string;
  slug: string;
  type: string;
  status: string;
  /** true/false = probed from the panel; null = not probed here (the runtime
   * lives on a remote node — the panel has no route to its container IP and
   * must not report a healthy service as down, the r228 lesson from Doctor). */
  healthy: boolean | null;
  responseMs: number | null;
  port: number | null;
  runtimeId: string | null;
  commitSha: string | null;
  lastDeploy: string | null;
}

/** Probe a URL with a short per-attempt timeout (never blocks the request). */
async function probeUrl(url: string, timeoutMs = 3000): Promise<{ healthy: boolean; responseMs: number | null }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { healthy: res.status < 500, responseMs: Date.now() - start };
  } catch {
    return { healthy: false, responseMs: null };
  }
}

/**
 * Probe from INSIDE the docker network by exec'ing wget in the Traefik
 * container (alpine base, always running on the shared `ninedeploy` network).
 * This is the portable fallback: hosts that cannot route bridge IPs directly
 * (Docker Desktop / macOS / Windows) would otherwise mark every container
 * unhealthy even though it serves fine on the mesh.
 */
async function probeViaMesh(runtimeId: string, port: number, path: string): Promise<boolean> {
  try {
    await capture('docker', [
      'exec', TRAEFIK_CONTAINER,
      'wget', '-q', '-O', '/dev/null', '-T', '3',
      `http://${runtimeId}:${port}${path}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Last-resort probe for containers that are NOT on the shared mesh (e.g.
 * compose projects run their own network): a throwaway curl container shares
 * the target's network namespace, so 127.0.0.1:<port> lands directly on the
 * app regardless of how the container is networked.
 */
async function probeViaNetns(runtimeId: string, port: number, path: string): Promise<boolean> {
  try {
    await ensureDockerImage(NETNS_PROBE_IMAGE, () => undefined);
    const out = await capture('docker', [
      'run', '--rm', '--network', `container:${runtimeId}`, NETNS_PROBE_IMAGE,
      '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '3',
      `http://127.0.0.1:${port}${path}`,
    ]);
    const code = Number(out.trim());
    return code > 0 && code < 500;
  } catch {
    return false;
  }
}

/**
 * Probe a running service's health endpoint. Docker services publish no host
 * ports (Traefik is the only ingress, per the container-security model), so
 * they are probed on their container network IP first — the fast path on
 * Linux hosts that can route bridge IPs — and via the Traefik mesh fallback
 * on hosts that cannot. PM2 services are host processes, so they are probed
 * on loopback like before.
 */
async function probeService(svc: {
  type: string;
  serverId: number | null | undefined;
  runtimeId: string | null;
  port: number;
  healthPath: string;
}): Promise<{ healthy: boolean | null; responseMs: number | null }> {
  // Never concatenate a stored healthPath onto an origin — see lib/probeUrl.ts.
  const path = safeProbePath(svc.healthPath);
  if (svc.type === 'pm2') return probeUrl(buildProbeUrl('127.0.0.1', svc.port, path));
  const runtimeId = svc.runtimeId;
  if (!runtimeId) return { healthy: false, responseMs: null };
  // A node-pinned runtime's container lives on the NODE's daemon: inspecting
  // the local one answers null and used to paint every remote service red.
  // The node's own agent health-checked the deploy; report "unknown" here.
  if (svc.serverId != null) return { healthy: null, responseMs: null };
  // ── 0.16 T7 swarm ── a Swarm service has no container of its own name; Traefik reaches its VIP on the overlay.
  if (isSwarmRuntimeId(runtimeId)) return { healthy: await probeViaMesh(runtimeId, svc.port, path), responseMs: null };
  // ── end 0.16 T7 ──
  const ip = await containerIp(runtimeId);
  if (!ip) return { healthy: false, responseMs: null }; // container not running
  // Race the transports: the direct fetch and the mesh probe run CONCURRENTLY
  // and the first healthy answer wins. Waiting for the doomed 1.2s direct
  // timeout before even starting the mesh probe is what made the dashboard
  // slow on hosts that cannot route bridge IPs (Docker Desktop).
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: { healthy: boolean; responseMs: number | null }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    void probeUrl(buildProbeUrl(ip, svc.port, path), 1200).then((direct) => {
      if (direct.healthy) {
        settle(direct);
      } else if (!settled) {
        // Direct failed — containers outside the mesh need the netns probe.
        // F584: skip it once the mesh already answered; the throwaway
        // `docker run` would only produce a discarded result.
        void probeViaNetns(runtimeId, svc.port, path).then((ok) => settle({ healthy: ok, responseMs: null }));
      }
    });
    void probeViaMesh(runtimeId, svc.port, path).then((ok) => {
      if (ok) settle({ healthy: true, responseMs: null });
    });
  });
}

/** Dashboard overview: stats + per-service health + recent deploys. */
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const user = req.user!;
    // Scope every list/count to what the caller may see — operators get the
    // whole instance, members only their own services PLUS services tagged
    // into workspaces they belong to. Without this, any member's dashboard
    // mapped every other tenant's services, databases, domains, webhooks and
    // recent deployments.
    const [allServices, allDbs, visibleDbIds] = await Promise.all([
      app.db.select().from(services),
      app.db.select().from(databases),
      visibleDatabaseIds(app.db, user),
    ]);
    // Services the user can see: owned by them, or tagged into a workspace they
    // belong to, or (for operators) everything. Single source of truth, shared
    // with `GET /v1/services` and `/v1/domains` (see lib/resourceAccess.ts).
    const visible = await visibleServiceIdSet(app.db, user);
    const visibleServiceIds = visible ?? new Set(allServices.map((s) => s.id));
    const scopedServices = allServices.filter((s) => visibleServiceIds.has(s.id));
    const scopedDbs = visibleDbIds === null ? allDbs : allDbs.filter((d) => visibleDbIds.includes(d.id));
    const svcIds = Array.from(visibleServiceIds);

    // Aggregate counts. Service/database totals come from the scoped arrays;
    // the rest are queried restricted to the scoped service ids (an empty
    // scope short-circuits to zero rather than issuing an `IN ()` query).
    const operatorScope = user.isOperator;
    const emptyScope = !operatorScope && svcIds.length === 0;
    const [depCount, domCount, hookCount] = emptyScope
      ? [[{ n: 0 }], [{ n: 0 }], [{ n: 0 }]]
      : await Promise.all([
          operatorScope
            ? app.db.select({ n: count() }).from(deployments)
            : app.db.select({ n: count() }).from(deployments).where(inArray(deployments.serviceId, svcIds)),
          operatorScope
            ? app.db.select({ n: count() }).from(domains)
            : app.db.select({ n: count() }).from(domains).where(inArray(domains.serviceId, svcIds)),
          operatorScope
            ? app.db.select({ n: count() }).from(webhooks)
            : app.db.select({ n: count() }).from(webhooks).where(inArray(webhooks.serviceId, svcIds)),
        ]);

    // Running/stopped/error counts
    const running = scopedServices.filter((s) => s.status === 'running').length;
    const stopped = scopedServices.filter((s) => s.status === 'stopped').length;
    const errored = scopedServices.filter((s) => s.status === 'error').length;
    const dbRunning = scopedDbs.filter((d) => d.status === 'running').length;

    // Recent deployments (last 5) — ordered by id (monotonic; createdAt is
    // second-precision and would tie for same-second deploys).
    const recentDeploys = emptyScope
      ? []
      : await app.db.query.deployments.findMany({
          ...(operatorScope ? {} : { where: inArray(deployments.serviceId, svcIds) }),
          orderBy: desc(deployments.id),
          limit: 5,
        });
    const svcById = new Map(scopedServices.map((s) => [s.id, s]));
    const recent = recentDeploys.map((d) => {
      const svc = svcById.get(d.serviceId);
      return {
        id: d.id,
        serviceId: d.serviceId,
        serviceName: svc?.name ?? 'unknown',
        status: d.status,
        commitSha: d.commitSha?.slice(0, 7) ?? null,
        message: d.message,
        trigger: d.trigger,
        finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      };
    });

    // Health probe each running service — all services IN PARALLEL. Probes
    // chain through up to three transports (direct fetch → mesh → netns) and
    // each hop can cost seconds on hosts that cannot route bridge IPs; a
    // sequential loop multiplied that delay by the service count and made the
    // dashboard take 5-7s to render.
    const healthStatuses = await Promise.all(
      scopedServices.map(async (svc): Promise<HealthStatus> => {
        const lastDep = await app.db.query.deployments.findFirst({
          where: eq(deployments.serviceId, svc.id),
          orderBy: desc(deployments.id),
        });

        let healthy: boolean | null = false;
        let responseMs: number | null = null;

        if (svc.status === 'running' && svc.port) {
          const probe = await withDeadline(
            probeService({
              type: svc.type,
              serverId: svc.serverId,
              runtimeId: svc.runtimeId,
              port: svc.port,
              healthPath: svc.healthPath,
            }),
            PROBE_DEADLINE_MS,
            { healthy: false, responseMs: null },
          );
          healthy = probe.healthy;
          responseMs = probe.responseMs;
        } else if (svc.status === 'stopped') {
          healthy = false;
        } else if (!svc.port) {
          healthy = svc.status === 'running';
        }

        return {
          serviceId: svc.id,
          name: svc.name,
          slug: svc.slug,
          type: svc.type,
          status: svc.status,
          healthy,
          responseMs,
          port: svc.port,
          runtimeId: svc.runtimeId,
          commitSha: svc.commitSha?.slice(0, 7) ?? null,
          lastDeploy: lastDep?.createdAt.toISOString() ?? null,
        };
      }),
    );

    // Whole-node container count is infrastructure telemetry — it counts
    // EVERY tenant's containers and used to ride along to members. Operators
    // only (same gating as the host block in stats.ts); members get null and
    // the docker round-trip is skipped entirely.
    let containerCount: number | null = null;
    if (user.isOperator) {
      try {
        containerCount = (await capture('docker', ['ps', '-q'], { timeoutMs: PROBE_DEADLINE_MS })).split('\n').filter(Boolean).length;
      } catch { /* ignore */ }
    }

    return {
      stats: {
        services: scopedServices.length,
        databases: scopedDbs.length,
        deployments: depCount[0]?.n ?? 0,
        domains: domCount[0]?.n ?? 0,
        webhooks: hookCount[0]?.n ?? 0,
        running,
        stopped,
        errored,
        dbRunning,
        containers: containerCount,
      },
      health: healthStatuses,
      recentDeploys: recent,
    };
  });
};
