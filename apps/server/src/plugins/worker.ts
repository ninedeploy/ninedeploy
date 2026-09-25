import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { deployments, services } from '@ninedeploy/db';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { runDeployment } from '../engine/pipeline.js';

/**
 * The `IBuildCache` the deploy pipeline should use, per the operator's
 * `plugin:build-cache:enabled` + `cache_name` settings. Best-effort: a missing kernel, an
 * unreadable config row or a name nothing registered all degrade to the first
 * registered cache (and finally to `undefined`, the legacy `docker build`
 * path) rather than failing the deploy.
 */
async function resolveBuildCache(
  fastify: FastifyInstance,
): Promise<import('../kernel/types.js').IBuildCache | undefined> {
  const registry = fastify.kernel?.registry;
  if (!registry?.listBuildCaches) return undefined;
  const all = registry.listBuildCaches();
  if (all.length === 0) return undefined;

  const cfg = fastify.kernel?.configCenter;
  // The plugin's master switch. Off = the pipeline gets no cache at all, which
  // is exactly the legacy `docker build` path.
  const enabled = cfg
    ? await cfg.get<boolean>('plugin:build-cache:enabled', true).catch(() => true)
    : true;
  if (!enabled) return undefined;

  const name = cfg
    ? await cfg.get<string>('plugin:build-cache:cache_name', 'inline').catch(() => 'inline')
    : 'inline';
  return (name ? registry.getBuildCache(name) : undefined) ?? all[0];
}

const POLL_MS = 2000;
/** How often the stale-`building` sweep re-runs after boot (r169). */
export const STALE_SWEEP_EVERY_MS = 5 * 60 * 1000;
/** Bounded grace period for an in-flight deploy during graceful shutdown. The
 *  exec layer already tree-kills hung subprocesses on their own timeouts, so
 *  this is a backstop, not the primary guard against stuck deploys. */
const STOP_GRACE_MS = 60_000;

declare module 'fastify' {
  interface FastifyInstance {
    worker: { stop: () => Promise<void> };
  }
}

/** Background worker: polls for `queued` deployments and runs the pipeline.
 *
 * Concurrency model:
 *   • `NINEDEPLOY_DEPLOY_CONCURRENCY` independent claim loops (default 1).
 *   • Each loop claims atomically (queued→building UPDATE guarded by
 *     rowsAffected === 1), so loops — and any future second process sharing
 *     the database — can never double-run a deployment.
 *   • The claim query skips services with a `building` deployment (or, r272,
 *     a pipeline still running here after its row was cancelled), so the
 *     same service is never deployed concurrently.
 *   • A slot does not wait for the run it launched (r238): the per-server
 *     partition counts, not the loop count, bound how many builds run.
 */
export default fp(
  async (fastify) => {
    let running = true;
    const currents: Array<Promise<void>> = [];
    /** Deployment ids this process is running right now — never "stale". */
    const inFlight = new Set<number>();
    /**
     * r272: service ids whose pipeline is still running in this process,
     * whatever its row says. Cancelling a `building` deploy flips the row to
     * `cancelled` at once, but the pipeline only notices at its next
     * checkpoint — up to the build timeout later. The claim guard below only
     * looks at `building` rows, so a redeploy was claimed while the old
     * pipeline still ran in the same reposDir/<serviceId>, and the old run
     * later overwrote services.status. Such a service's queued rows wait here
     * until the old pipeline actually exits.
     */
    const inFlightServices = new Set<number>();
    /**
     * Pending poll timers, one per concurrency slot.
     *
     * A Set that each timer removes itself from as it fires. It used to be an
     * append-only array: every 2-second tick pushed another settled Timeout
     * that was only ever released by `stop()`, so a panel left running
     * accumulated ~43 000 dead handles per slot per day.
     */
    const timers = new Set<NodeJS.Timeout>();

    /** Queue the next poll, self-removing so the set only holds live timers. */
    const schedule = (delayMs: number): void => {
      const t = setTimeout(() => {
        timers.delete(t);
        void tick();
      }, delayMs);
      t.unref?.();
      timers.add(t);
    };

    // Crash recovery: a deploy interrupted by a restart is left stranded in
    // `building`. Requeue rows that can no longer be genuinely running —
    // a second process sharing this DB may have live in-flight deploys, and
    // failing those out from under it would break the multi-process story.
    // 45 min comfortably covers the 30-min exec timeout + 5-min healthcheck.
    const STALE_BUILDING_MS = 45 * 60 * 1000;
    const sweepStaleBuilding = async (): Promise<void> => {
      const staleCutoff = new Date(Date.now() - STALE_BUILDING_MS);
      try {
        const buildingRows = (await fastify.db.select().from(deployments).where(eq(deployments.status, 'building'))) as Array<{
          id: number;
          message: string | null;
          startedAt: Date | null;
          createdAt: Date | null;
        }>;
        const stale = buildingRows
          .filter((r) => {
            // v0.2.34 let the browser own dependency provisioning and left this
            // marker behind if that request was interrupted. No worker can be
            // running such a row, so migrate it immediately regardless of age.
            if (r.message?.startsWith('Provisioning template dependencies:')) return true;
            if (inFlight.has(r.id)) return false;
            const ts = r.startedAt ?? r.createdAt;
            return !!ts && ts.getTime() < staleCutoff.getTime();
          })
          .map((r) => r.id);
        if (stale.length) {
          await fastify.db
            .update(deployments)
            .set({ status: 'queued', startedAt: null, finishedAt: null, message: 'Automatically resumed after interrupted worker' })
            .where(inArray(deployments.id, stale));
        }
      } catch (err) {
        fastify.log.warn({ err }, 'could not sweep stale building deployments');
      }
    };
    await sweepStaleBuilding();
    // r169: the sweep used to run ONCE, at boot. A restart 5 minutes into a
    // build left that row `building` forever — its service could never be
    // claimed again (nextClaimable skips services with a build in flight) and,
    // at the default concurrency of 1, it held the local partition's only
    // slot. Re-run it so such rows resume once they cross the stale cutoff.
    const sweepTimer = setInterval(() => void sweepStaleBuilding(), STALE_SWEEP_EVERY_MS);
    sweepTimer.unref?.();

    /** The oldest queued deployment of a service with nothing in `building`,
     * whose SERVER partition still has a free concurrency slot. Deploys are
     * partitioned by the service's target server (null = this host): each
     * partition independently gets `deployConcurrency` build slots, so a long
     * build on a remote server never starves local deployments. */
    const nextClaimable = async (): Promise<{ id: number; serviceId: number } | undefined> => {
      const buildingServices = fastify.db
        .select({ serviceId: deployments.serviceId })
        .from(deployments)
        .where(eq(deployments.status, 'building'));
      // Build counts per partition (serverId; null → 0 = local).
      const buildingRows = await fastify.db
        .select({ serverId: services.serverId })
        .from(deployments)
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .where(eq(deployments.status, 'building'));
      const perPartition = new Map<string, number>();
      for (const r of buildingRows) {
        const key = String(r.serverId ?? 0);
        perPartition.set(key, (perPartition.get(key) ?? 0) + 1);
      }
      // Candidate queue, oldest first.
      const queued = await fastify.db
        .select({ id: deployments.id, serverId: services.serverId, serviceId: deployments.serviceId })
        .from(deployments)
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .where(and(eq(deployments.status, 'queued'), notInArray(deployments.serviceId, buildingServices)))
        .orderBy(asc(deployments.createdAt));
      for (const row of queued) {
        if (inFlightServices.has(row.serviceId)) continue; // r272
        const key = String(row.serverId ?? 0);
        if ((perPartition.get(key) ?? 0) < config.deployConcurrency) return { id: row.id, serviceId: row.serviceId };
      }
      return undefined;
    };

    let claimChain: Promise<unknown> = Promise.resolve();
    const withClaimLock = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = claimChain.then(fn, fn);
      claimChain = next.catch(() => undefined);
      return next;
    };

    const tick = async () => {
      if (!running) return;
      try {
        // r238: selection + claim are serialized across slots, so two slots
        // can never both read a partition as having a free seat and overfill
        // it now that a slot no longer waits for its run to finish.
        const picked = await withClaimLock(async () => {
          const queued = await nextClaimable();
          if (!queued) return undefined;
          // Atomically claim: only flip queued→building if still queued, then
          // verify we won the claim via rowsAffected. A single-row update
          // affects exactly 1 row on success, so `=== 1` is a precise win test.
          // This keeps multiple loops / workers from double-running a deploy.
          const claimed = (await fastify.db
            .update(deployments)
            .set({ status: 'building' })
            .where(and(
              eq(deployments.id, queued.id),
              eq(deployments.status, 'queued'),
              // Selection and update are separate statements. Re-check the
              // service invariant inside the atomic write so two slots that
              // selected different queued rows for one service cannot both win.
              sql`NOT EXISTS (
                SELECT 1 FROM deployments AS active
                WHERE active.service_id = ${deployments.serviceId}
                  AND active.status = 'building'
              )`,
            ))) as
            | { rowsAffected?: number }
            | undefined;
          if (claimed?.rowsAffected === 1) return queued;
          fastify.log.info({ deploymentId: queued.id }, 'deployment already claimed, skipping');
          return undefined;
        });
        if (picked) {
          const queued = picked;
            fastify.log.info({ deploymentId: queued.id }, 'processing deployment');
            // Sprint 4 G-01 PR-B: surface the engine.use_buildkit flag
            // and the first registered build cache to the pipeline so
            // the Docker builder can route through `docker buildx`.
            // The lookup is best-effort: a missing kernel / no cache =
            // legacy `docker build` path.
            const useBuildKit = fastify.kernel?.configCenter
              ? await fastify.kernel.configCenter
                  .get<boolean>('engine:use_buildkit', false)
                  .catch(() => false)
              : false;
            // Honour the operator's `plugin:build-cache:cache_name` choice.
            // Taking `listBuildCaches()[0]` unconditionally meant a panel set
            // to `s3` or `registry` still built against the in-memory LRU —
            // the setting was accepted and silently ignored. An unknown or
            // unset name still falls back to the first registered cache, which
            // is the behaviour the plugin's own contract documents.
            const buildCache = await resolveBuildCache(fastify);
            const kernelEvents = fastify.kernel?.events;
            const run = runDeployment(fastify.db, queued.id, {
              useBuildKit,
              buildCache,
              hooks: fastify.kernel?.hooks,
              events: kernelEvents,
              // Publish the build's REAL cache observation. Best-effort: a
              // bus that throws must not fail the deploy.
              onBuildCacheEvent: kernelEvents
                ? (event) => {
                    try {
                      const { kind, ...rest } = event;
                      kernelEvents.emitCustom(`build.cache.${kind}`, { ...rest, ts: Date.now() });
                    } catch {
                      /* the bus is observability, never a deploy dependency */
                    }
                  }
                : undefined,
            });
            // r238: the run is NOT awaited by the slot. A slot that sat on a
            // 20-minute remote build could not claim anything else, so at the
            // default concurrency of 1 a build on another server blocked every
            // local deploy — the per-partition limits below were never reached.
            // Concurrency is bounded by those partition counts (the claimed
            // row is `building` before the next selection runs).
            const tracked: Promise<void> = run
              .catch((err: unknown) => {
                fastify.log.error({ err, deploymentId: queued.id }, 'deployment run failed');
              })
              .finally(() => {
                // Drop the settled entry so stop() waits only on live work.
                currents.splice(currents.indexOf(tracked), 1);
                inFlight.delete(queued.id);
                inFlightServices.delete(queued.serviceId);
              });
            currents.push(tracked);
            inFlight.add(queued.id);
            inFlightServices.add(queued.serviceId);
        }
      } catch (err) {
        fastify.log.error({ err }, 'worker tick failed');
      } finally {
        if (running) schedule(POLL_MS);
      }
    };

    fastify.decorate('worker', {
      stop: async () => {
        running = false;
        clearInterval(sweepTimer);
        for (const t of timers) clearTimeout(t);
        timers.clear();
        // Wait for in-flight deploys, but only up to a bounded grace period.
        // The grace timer is unref'd so it can never keep the process alive.
        const grace = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, STOP_GRACE_MS);
          t.unref();
        });
        await Promise.race([
          Promise.allSettled([...currents]).then(() => undefined),
          grace,
        ]);
      },
    });
    fastify.addHook('onClose', async () => {
      await fastify.worker.stop();
    });

    // One loop per concurrency slot; all loops share the same claim guard.
    for (let slot = 0; slot < config.deployConcurrency; slot++) {
      schedule(POLL_MS + slot * 100);
    }
    fastify.log.info({ concurrency: config.deployConcurrency }, 'deploy worker started');
  },
  { name: 'ninedeploy-worker' },
);
