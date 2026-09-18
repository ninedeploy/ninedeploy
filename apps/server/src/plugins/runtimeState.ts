import fp from 'fastify-plugin';
import { and, eq, isNull } from 'drizzle-orm';
import { services } from '@ninedeploy/db';
import { pm2Resurrect, pm2Start, pm2Status } from '../engine/builders/pm2.js';
import { audit } from '../lib/audit.js';
import { capture } from '../lib/exec.js';
import { replicaNames } from '../engine/dockerNames.js';
import { agentOp } from '../lib/agentClient.js';
import { serviceTargets } from '@ninedeploy/db';

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
 * Never touches non-running rows (a deploy in progress) or services owned by
 * remote agents. Skips the round — without judging — when the Docker daemon
 * is unreachable.
 */

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
async function reviveReplicas(runtimeId: string, replicas: number, log: (line: string) => void): Promise<void> {
  for (const name of replicaNames(runtimeId, replicas).slice(1)) {
    try {
      const state = (await execDocker(['inspect', '--format', '{{.State.Status}}', name])).trim();
      if (state === 'running' || state === 'restarting') continue;
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
      await fastify.db
        .update(services)
        .set({ status })
        .where(and(eq(services.id, svc.id), eq(services.runtimeId, svc.runtimeId)));
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
     * Best-effort patrol of a service's fan-out targets through their node
     * agents: a target container that died stays dead — the reconcile's
     * local execDocker cannot see another machine — until its next deploy.
     * A node that is unreachable is skipped (not judged): the node being
     * down is not the service's fault, and starting a container on a dead
     * agent is impossible anyway. Targets whose container is GONE (scaled
     * down generation) get their row marked error so the panel says so;
     * the next deploy recreates them.
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
        const agent = (op: string, params: Record<string, unknown>) =>
          agentOp(fastify.db, target.serverId, op, params, () => undefined);
        try {
          const state = (
            await agent('docker.inspect', { name: target.runtimeId, format: 'state' })
          ).lines
            .filter((l) => l.trim() !== '')
            .at(-1)
            ?.split('|')[0];
          if (state === 'running' || state === 'restarting') continue;
          if (state === undefined) continue; // container gone — next deploy recreates
          await agent('docker.start', { name: target.runtimeId });
          log(`revived fan-out target ${target.runtimeId} on node #${target.serverId}`);
          if (target.status !== 'running') {
            await fastify.db
              .update(serviceTargets)
              .set({ status: 'running' })
              .where(eq(serviceTargets.id, target.id));
          }
        } catch {
          // node unreachable or inspect refused — skip, never judge
        }
      }
      void name;
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
              if (live === 'running') {
                // Main healthy ≠ replicas healthy — a single dead clone
                // quietly halves capacity while the row reads `running`.
                await reviveReplicas(runtimeId, svc.replicas ?? 1, (line) =>
                  fastify.log.warn({ serviceId: svc.id, name: svc.name, runtimeId }, line),
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
                  await reviveReplicas(runtimeId, svc.replicas ?? 1, (line) =>
                    fastify.log.warn({ serviceId: svc.id, name: svc.name, runtimeId }, line),
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
