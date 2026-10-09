import fp from 'fastify-plugin';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { services } from '@ninedeploy/db';
import { pm2Resurrect, pm2Start, pm2Status } from '../engine/builders/pm2.js';
import { audit } from '../lib/audit.js';
import { capture } from '../lib/exec.js';
import { replicaNames } from '../engine/dockerNames.js';
import { agentOp } from '../lib/agentClient.js';
import { serviceTargets } from '@ninedeploy/db';
import { swarmRuntimeOf } from '../lib/swarm.js';

// A tight loop matters for the boot promise ("everything comes back on its
// own"): the first pass runs at startup, and anything it cannot fix — e.g. a
// Docker daemon still warming up — is retried a minute later, not five.
const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Self-healing runtime reconciliation. `services.status` records desired
 * lifecycle state (the lifecycle endpoints persist their real outcome), so a
 * row claiming `running` while its runtime is down — after a reboot, a daemon
 * crash, or an external `docker stop` — is drift to repair, not just to
 * report:
 *
 *   - runtime running              → nothing to do
 *   - runtime present but stopped  → START it (docker start / pm2 restart;
 *     compose sidecars sharing the project label come along)
 *   - PM2 process gone             → pm2 resurrect (the dump the server keeps
 *     fresh restores it; panel-stopped processes stay stopped) then re-check
 *   - runtime gone (deleted)       → only a redeploy can recreate it: mark
 *     `error` so the panel says so
 *
 * Never touches non-running rows (a deploy in progress). Skips the round —
 * without judging — when the Docker daemon is unreachable.
 *
 * r525: node-pinned docker services are patrolled too, through their node's
 * agent (`docker.inspect` / `docker.start`, both shipped with the remote
 * builder, so every agent that can run such a service answers them). They
 * used to be filtered out entirely, so a container that died on a node stayed
 * `running` in the panel forever and `alert.service_down` never fired. An
 * UNREACHABLE node is never read as "service down": its services are skipped
 * for the round and the node itself is recorded as unreachable instead.
 *
 * r591: node-pinned COMPOSE services too. Their runtimeId is the stack's main
 * container (the remote compose builder resolves the name the stack really
 * runs), so the same `docker.inspect` / `docker.start` pair patrols it. An
 * agent that answers `unknown_op` (a build older than the op) skips that
 * service — never read as "down", never as an unreachable node.
 */

/**
 * r591: the node's agent refused the operation as unknown (an older agent
 * build). agentOp surfaces the agent's 400 `unknown_op` as a thrown error —
 * that is a capability gap, not an unreachable node and not a dead service.
 */
function isUnknownAgentOp(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\(400\)/.test(msg) && /unknown_op|Unknown operation/.test(msg);
}

/** Service types patrolled on their node (r525 docker, r591 compose). */
const NODE_PATROLLED_TYPES = ['docker', 'compose'] as const;

/** The daemon cannot be reached at all — reconciliation must skip, not judge. */
class DaemonUnavailableError extends Error {}

/** Run docker and surface daemon-outage distinctly from command failures. */
async function execDocker(args: string[]): Promise<string> {
  try {
    return await capture('docker', args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cannot connect to the docker daemon|docker daemon is not running|error during connect/i.test(msg)) {
      throw new DaemonUnavailableError(msg);
    }
    throw err;
  }
}

async function containerState(runtimeId: string): Promise<'running' | 'stopped' | 'gone'> {
  let state: string;
  try {
    state = (await execDocker(['inspect', '--format', '{{.State.Status}}', runtimeId])).trim();
  } catch (err) {
    if (err instanceof DaemonUnavailableError) throw err;
    // "No such container/object" — the runtime was destroyed.
    return 'gone';
  }
  // 'restarting' is on its way back up — treat as running, not as drift.
  if (state === 'running' || state === 'restarting') return 'running';
  // exited/created/paused/dead: the container exists but is not serving.
  return 'stopped';
}

/**
 * Why a container was last down — read from the pre-revive inspect. Docker
 * restarts or we revive the process, so an OOM kill is otherwise invisible:
 * the panel never sees the down state and the operator keeps hitting the same
 * memory ceiling. `exitCode` rides along because 137 (SIGKILL) frequently
 * means OOM even when the OOMKilled flag is false (cgroup v2 kernel kills).
 */
async function downReason(runtimeId: string): Promise<{ oomKilled: boolean; exitCode: number } | null> {
  try {
    const raw = (await execDocker(['inspect', '--format', '{{.State.OOMKilled}}|{{.State.ExitCode}}', runtimeId])).trim();
    const [oom, code] = raw.split('|');
    return { oomKilled: oom === 'true', exitCode: Number(code) || 0 };
  } catch {
    // The daemon hiccuped between the two inspects — downgrade to "unknown",
    // never let diagnostics break the revive.
    return null;
  }
}

/**
 * Best-effort revive of a service's extra replicas (`-r2..-rN`). The main
 * container being healthy says nothing about its clones — one OOM-killed
 * replica halves capacity while the service row reads `running`. A replica
 * that no longer exists (service scaled down between deploys) reports gone
 * and is recreated on the next deploy; that is not drift to repair here.
 */
async function reviveReplicas(
  runtimeId: string,
  replicas: number,
  log: (line: string) => void,
  stillOwned: () => Promise<boolean>,
): Promise<void> {
  for (const name of replicaNames(runtimeId, replicas).slice(1)) {
    try {
      const state = (await execDocker(['inspect', '--format', '{{.State.Status}}', name])).trim();
      if (state === 'running' || state === 'restarting') continue;
      // F940: a replica found down may be one the user is stopping right now.
      if (!(await stillOwned())) return;
      await execDocker(['start', name]);
      log(`revived replica ${name}`);
    } catch {
      /* replica gone (scaled down generation) — next deploy recreates it */
    }
  }
}

/** Start a stopped container; returns whether it ended up running. */
async function reviveContainer(runtimeId: string): Promise<boolean> {  try {
    await execDocker(['start', runtimeId]);
    // Compose projects are multi-container: starting only the main container
    // would leave sidecars (DBs, workers) dead. Starting already-running
    // containers is a successful no-op, so start the whole project at once.
    try {
      const project = (
        await execDocker([
          'inspect',
          '--format',
          '{{ index .Config.Labels "com.docker.compose.project" }}',
          runtimeId,
        ])
      ).trim();
      if (project) {
        const ids = (await execDocker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]))
          .trim()
          .split(/\r?\n/)
          .map((id) => id.trim())
          .filter(Boolean);
        if (ids.length > 0) await execDocker(['start', ...ids]);
      }
    } catch {
      /* sibling discovery is best-effort */
    }
    const state = (await execDocker(['inspect', '--format', '{{.State.Status}}', runtimeId])).trim();
    return state === 'running' || state === 'restarting';
  } catch (err) {
    if (err instanceof DaemonUnavailableError) throw err;
    return false;
  }
}

export default fp(
  async (fastify) => {
    // A crash-looping service dies every round — alert at most once per
    // window per service so notifications stay useful, not noisy. In-memory
    // is deliberate: a panel restart re-alerting once is fine, persistence
    // for a throttle is not worth a table.
    const OOM_ALERT_COOLDOWN_MS = 10 * 60_000;
    const lastOomAlertAt = new Map<number, number>();

    const setStatus = async (
      svc: { id: number; name: string; runtimeId: string },
      status: 'stopped' | 'error',
    ) => {
      // Also match on runtimeId: if a deploy swapped the runtime between our
      // read and this write, the stale reconcile must not clobber it.
      // F164: and on status — a row deleted, stopped or put mid-deploy
      // (compose redeploys keep the runtimeId) while we were inspecting is
      // not ours to judge; no row changed means no outage to report.
      const changed = await fastify.db
        .update(services)
        .set({ status })
        .where(and(eq(services.id, svc.id), eq(services.runtimeId, svc.runtimeId), eq(services.status, 'running')))
        .returning({ id: services.id });
      if (changed.length === 0) return;
      fastify.log.warn(
        { serviceId: svc.id, name: svc.name, runtimeId: svc.runtimeId, status },
        'service runtime is down and could not be revived — status reconciled from live state (a redeploy recreates it)',
      );
      // r242: a service going down was only a log line: no activity entry, no
      // notification, and the kernel's `service.health_changed` (which the
      // notifications plugin alerts on) was never emitted with a failure
      // status. Once per outage: the reconcile only visits `running` rows. An
      // `alert.*` action, so per-service alert subscriptions receive it too.
      void audit(fastify.db, null, 'alert.service_down', `${svc.name} #${svc.id}`, { serviceId: svc.id, runtimeId: svc.runtimeId, status });
    };

    /**
     * F889/F940: a pass acts on the rows it listed at its start, with docker /
     * pm2 / agent round-trips in between, so a row may since have been stopped
     * by its user, redeployed (new runtimeId, or `deploying` for a compose
     * in-place redeploy) or deleted. Re-read it right before every start with
     * the predicate setStatus uses (F164); a row that no longer matches is not
     * ours to revive. Residual: a stop whose `stopped` write lands AFTER this
     * read and whose own `docker stop` reaches the daemon before our start is
     * still undone — one read and one CLI spawn wide (it was the whole pass);
     * closing it needs a lock shared with the lifecycle routes.
     */
    const stillRunning = async (svc: { id: number; runtimeId: string }): Promise<boolean> => {
      const rows = await fastify.db
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.id, svc.id), eq(services.runtimeId, svc.runtimeId), eq(services.status, 'running')))
        .limit(1);
      return rows.length > 0;
    };

    /**
     * Best-effort patrol of a service's fan-out targets through their node
     * agents: a target container that died stays dead — the reconcile's
     * local execDocker cannot see another machine — until its next deploy.
     * A node that is unreachable is skipped (not judged): the node being
     * down is not the service's fault, and starting a container on a dead
     * agent is impossible anyway. Targets whose container is GONE (scaled
     * down generation, removed behind our back) get their row marked error
     * so the panel says so; the next deploy recreates them. (r471: "gone"
     * arrives as `docker inspect` exit 1 — the agentOp contract throws on
     * that unless the probe tolerates exits, so the marking below used to
     * be unreachable and the docstring a promise the code never kept.)
     */
    const patrolTargets = async (
      serviceId: number,
      name: string,
      log: (line: string) => void,
    ): Promise<void> => {
      const rows = await fastify.db
        .select()
        .from(serviceTargets)
        .where(eq(serviceTargets.serviceId, serviceId));
      for (const target of rows) {
        if (!target.runtimeId) continue;
        // opts is spread only when set: an explicit undefined 6th argument
        // would change the call shape every existing assertion pins.
        const agent = (op: string, params: Record<string, unknown>, opts?: { tolerateExit?: boolean }) =>
          opts === undefined
            ? agentOp(fastify.db, target.serverId, op, params, () => undefined)
            : agentOp(fastify.db, target.serverId, op, params, () => undefined, opts);
        try {
          const res = await agent('docker.inspect', { name: target.runtimeId, format: 'state' }, { tolerateExit: true });
          if (res.exitCode !== 0) {
            // Container GONE on the node — mark the row so the panel says so
            // instead of showing a stale running status. Never judged if the
            // state cannot be asked for below; a missing container is certain.
            if (target.status !== 'error') {
              await fastify.db
                .update(serviceTargets)
                .set({ status: 'error' })
                .where(eq(serviceTargets.id, target.id));
            }
            continue;
          }
          const state = res.lines
            .filter((l) => l.trim() !== '')
            .at(-1)
            ?.split('|')[0];
          if (state === 'running' || state === 'restarting') continue;
          if (state === undefined) continue; // empty answer — skip, never judge
          await agent('docker.start', { name: target.runtimeId });
          log(`revived fan-out target ${target.runtimeId} on node #${target.serverId}`);
          if (target.status !== 'running') {
            await fastify.db
              .update(serviceTargets)
              .set({ status: 'running' })
              .where(eq(serviceTargets.id, target.id));
          }
        } catch {
          // node unreachable — skip, never judge
        }
      }
      void name;
    };

    /**
     * r525: nodes whose agent did not answer the last patrol, so the
     * unreachable audit fires once per outage rather than every minute.
     * In-memory like the OOM throttle — a restart re-alerting once is fine.
     */
    const unreachableNodes = new Set<number>();

    /**
     * Patrol one node's docker and compose services through its agent
     * (compose: the stack's main container — a stopped one is started on its
     * own; its siblings keep the unless-stopped policy the deploy applied).
     * Batched per node:
     * the first transport failure (agent down, auth, timeout) stops the batch
     * and marks the node unreachable — none of its services is judged. A
     * container is only declared gone when the node's docker SAYS so ("No
     * such object"); any other inspect failure (the node's daemon restarting)
     * skips the service for this round.
     */
    const patrolNode = async (
      serverId: number,
      rows: Array<{ id: number; name: string; runtimeId: string }>,
    ): Promise<void> => {
      const agent = (op: string, params: Record<string, unknown>) =>
        agentOp(fastify.db, serverId, op, params, () => undefined, { tolerateExit: true });
      const stateOf = async (runtimeId: string): Promise<'running' | 'stopped' | 'gone' | 'unknown'> => {
        const res = await agent('docker.inspect', { name: runtimeId, format: 'state' });
        if (res.exitCode !== 0) {
          return res.lines.some((l) => /no such (object|container)/i.test(l)) ? 'gone' : 'unknown';
        }
        const state = res.lines.filter((l) => l.trim() !== '').at(-1)?.split('|')[0]?.trim();
        if (state === undefined || state === '') return 'unknown';
        return state === 'running' || state === 'restarting' ? 'running' : 'stopped';
      };
      for (const svc of rows) {
        let live: Awaited<ReturnType<typeof stateOf>>;
        try {
          live = await stateOf(svc.runtimeId);
        } catch (err) {
          // r591: an agent that predates the op answered — it is reachable,
          // so neither the node nor the service is judged; skip quietly.
          if (isUnknownAgentOp(err)) {
            fastify.log.debug({ serverId, serviceId: svc.id }, 'node agent lacks the patrol op — upgrade the agent; service skipped');
            continue;
          }
          if (!unreachableNodes.has(serverId)) {
            unreachableNodes.add(serverId);
            const reason = err instanceof Error ? err.message : String(err);
            fastify.log.warn({ serverId, err }, 'node agent unreachable — its services are not judged this round');
            void audit(fastify.db, null, 'alert.node_unreachable', `node #${serverId}`, {
              serverId,
              reason: reason.slice(0, 500),
            });
          }
          return;
        }
        unreachableNodes.delete(serverId);
        if (live === 'running' || live === 'unknown') continue;
        if (live === 'stopped') {
          // F940: not `running` (or not this runtime) any more — leave it.
          if (!(await stillRunning(svc))) continue;
          try {
            const started = await agent('docker.start', { name: svc.runtimeId });
            if (started.exitCode === 0 && (await stateOf(svc.runtimeId)) === 'running') {
              fastify.log.warn({ serviceId: svc.id, name: svc.name, runtimeId: svc.runtimeId, serverId }, 'revived stopped container on its node');
              continue;
            }
          } catch (err) {
            // r591: an older agent without the op — skip, never judge.
            if (isUnknownAgentOp(err)) continue;
            // The node went away mid-revive — not the service's fault.
            return;
          }
        }
        await setStatus(svc, 'error');
      }
    };

    /** Record an OOM kill in the activity trail + notification fan-out. */
    const alertOom = (serviceId: number, name: string, runtimeId: string, exitCode: number) => {
      const now = Date.now();
      const last = lastOomAlertAt.get(serviceId) ?? 0;
      if (now - last < OOM_ALERT_COOLDOWN_MS) return;
      lastOomAlertAt.set(serviceId, now);
      // 'alert.*' lands in the alert-scope notification subscriptions; the
      // entity format matches the other service audit entries.
      void audit(fastify.db, null, 'alert.oom', name, { serviceId, runtimeId, exitCode });
    };

    const reconcile = async () => {
      try {
        const rows = await fastify.db.query.services.findMany({
          where: and(eq(services.status, 'running'), isNull(services.serverId)),
        });
        let daemonDown = false;
        let pm2Resurrected = false;
        for (const svc of rows) {
          const runtimeId = svc.runtimeId;
          if (!runtimeId) continue;
          // ── 0.16 T7 swarm ── Swarm restarts its own tasks; a Swarm service has no container to inspect or revive here.
          if (swarmRuntimeOf(svc)) continue;
          // ── end 0.16 T7 ──
          try {
            if (svc.type === 'pm2') {
              let live = await pm2Status(runtimeId);
              if (live === 'gone' && !pm2Resurrected) {
                // The PM2 daemon died or rebooted: restore the dumped process
                // list once per round, then look again.
                pm2Resurrected = true;
                await pm2Resurrect();
                live = await pm2Status(runtimeId);
              }
              if (live === 'online') continue;
              if (live === 'stopped') {
                // F940: a PM2 process found stopped may be one its user just stopped.
                if (!(await stillRunning({ id: svc.id, runtimeId }))) continue;
                await pm2Start(runtimeId);
                if ((await pm2Status(runtimeId)) === 'online') {
                  fastify.log.warn(
                    { serviceId: svc.id, name: svc.name, runtimeId },
                    'revived stopped PM2 process',
                  );
                  continue;
                }
              }
              await setStatus({ ...svc, runtimeId }, 'error');
            } else if (svc.type === 'docker' || svc.type === 'compose') {
              if (daemonDown) continue;
              const live = await containerState(runtimeId);
              const owned = () => stillRunning({ id: svc.id, runtimeId });
              if (live === 'running') {
                // Main healthy ≠ replicas healthy — a single dead clone
                // quietly halves capacity while the row reads `running`.
                await reviveReplicas(
                  runtimeId,
                  svc.replicas ?? 1,
                  (line) => fastify.log.warn({ serviceId: svc.id, name: svc.name, runtimeId }, line),
                  owned,
                );
                // Healthy local ≠ healthy targets: fan-out containers live on
                // other machines and only the agent can see them.
                await patrolTargets(svc.id, svc.name, (line) =>
                  fastify.log.warn({ serviceId: svc.id, name: svc.name, runtimeId }, line),
                );
                continue;
              }
              if (live === 'stopped') {
                // Read why it died BEFORE starting it — the restart wipes the
                // OOMKilled flag's meaning (it reports the *last* exit, so a
                // healthy post-revive exit would mask the crash).
                const reason = await downReason(runtimeId);
                // F889: the user may have stopped (or a deploy replaced) it
                // since the list was read — a stale row is not ours to start.
                if (!(await owned())) continue;
                if (await reviveContainer(runtimeId)) {
                  fastify.log.warn(
                    { serviceId: svc.id, name: svc.name, runtimeId, exitCode: reason?.exitCode, oomKilled: reason?.oomKilled ?? false },
                    reason?.oomKilled || reason?.exitCode === 137
                      ? 'revived container that died from memory exhaustion — consider raising the memory limit in Service → Settings'
                      : 'revived stopped container',
                  );
                  if (reason?.oomKilled || reason?.exitCode === 137) {
                    void alertOom(svc.id, svc.name, runtimeId, reason.exitCode);
                  }
                  await reviveReplicas(
                    runtimeId,
                    svc.replicas ?? 1,
                    (line) => fastify.log.warn({ serviceId: svc.id, name: svc.name, runtimeId }, line),
                    owned,
                  );
                  continue;
                }
              }
              await setStatus({ ...svc, runtimeId }, 'error');
            }
          } catch (err) {
            if (err instanceof DaemonUnavailableError) {
              daemonDown = true;
              fastify.log.debug('docker daemon unreachable; skipping runtime reconciliation this round');
              continue;
            }
            fastify.log.warn({ err, serviceId: svc.id }, 'runtime state check failed');
          }
        }
      } catch (err) {
        fastify.log.warn({ err }, 'runtime state reconciliation failed');
      }
      // r525: node-pinned docker services, one batch per node. Isolated from
      // the local pass above: a node problem must never cost the panel host
      // its reconcile, nor the other way round. r591: compose services too.
      try {
        const remote = await fastify.db.query.services.findMany({
          where: and(
            eq(services.status, 'running'),
            isNotNull(services.serverId),
            inArray(services.type, [...NODE_PATROLLED_TYPES]),
          ),
        });
        const byNode = new Map<number, Array<{ id: number; name: string; runtimeId: string }>>();
        for (const svc of remote) {
          if (svc.serverId == null || !svc.runtimeId) continue;
          if (!(NODE_PATROLLED_TYPES as readonly string[]).includes(svc.type)) continue;
          const batch = byNode.get(svc.serverId) ?? [];
          batch.push({ id: svc.id, name: svc.name, runtimeId: svc.runtimeId });
          byNode.set(svc.serverId, batch);
        }
        for (const [serverId, batch] of byNode) await patrolNode(serverId, batch);
      } catch (err) {
        fastify.log.warn({ err }, 'remote runtime state reconciliation failed');
      }
    };

    // Fire-and-forget on boot: reconcile must not delay readiness, and the
    // rows it inspects are by definition not mid-deploy (status = 'running').
    fastify.addHook('onReady', () => {
      void reconcile();
    });

    const timer = setInterval(() => {
      void reconcile();
    }, RECONCILE_INTERVAL_MS);
    timer.unref();

    fastify.addHook('onClose', () => {
      clearInterval(timer);
    });
  },
  { name: 'ninedeploy-runtime-state' },
);
