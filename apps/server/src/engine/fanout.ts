import { and, eq } from 'drizzle-orm';
import { serviceTargets, servers, type DB } from '@ninedeploy/db';
import { agentOp } from '../lib/agentClient.js';

/**
 * Multi-server fan-out (phase 1): push an IMAGE-based release to additional
 * nodes after the primary deployment succeeds.
 *
 * Scope, stated honestly:
 *   - docker services with a pre-built IMAGE only. A source build's image
 *     exists solely in the building node's docker cache — fanning those out
 *     needs the build-server/registry story, which is a separate feature.
 *   - Additive, never blocking: a node that fails to pull or start keeps the
 *     primary release serving everywhere; the per-target row records the
 *     error for the panel.
 *   - Routing is node-local: every node runs its own Traefik and reaches its
 *     own container by name (`renderDynamicConfig` renders the service into
 *     every node that holds a target). Pointing a domain at several nodes is
 *     the operator's DNS decision — exactly Coolify's model.
 *   - Reconcile does not patrol targets yet: the phase-2 note lives in
 *     runtimeState.ts. A dead extra node serves stale traffic until its next
 *     deploy; the per-node Traefik healthCheck bounds the damage.
 */

const HEALTH_POLL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 60_000;

export type AgentCaller = (
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
) => Promise<{ exitCode: number; lines: string[] }>;

export interface FanoutTarget {
  serverId: number;
  runtimeId: string | null;
}

/** The extra nodes (beyond the primary placement) a release is pushed to. */
export async function targetsForService(db: DB, serviceId: number): Promise<FanoutTarget[]> {
  const rows = await db
    .select({ serverId: serviceTargets.serverId, runtimeId: serviceTargets.runtimeId })
    .from(serviceTargets)
    .where(eq(serviceTargets.serviceId, serviceId));
  return rows;
}

function parseState(lines: string[]): { status: string } {
  const raw = lines.filter((l) => l.trim() !== '').at(-1) ?? '';
  return { status: raw.trim().split('|')[0] ?? '' };
}

/** Poll `docker.inspect` until the container settles, like remoteDocker but short. */
async function waitRunning(
  agent: AgentCaller,
  name: string,
  log: (line: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await agent('docker.inspect', { name, format: 'state' }, () => undefined);
      const { status } = parseState(res.lines);
      if (status === 'running') return true;
      if (status === 'exited' || status === 'dead' || status === 'removing') {
        log(`target container ${name} reached state "${status}"`);
        return false;
      }
    } catch (err) {
      log(`waiting for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  log(`${name} did not reach a running state in time`);
  return false;
}

export interface FanoutContext {
  service: { id: number; slug: string; type: string; image: string | null; port: number | null; healthPath?: string | null; cpuShares: number; cpuLimitMilli: number; memLimitMb: number; volumeMount: string | null; publishedPort: number | null };
  deploymentId: number;
  /** The resolved release (digest-pinned on rollback), already pulled on the primary. */
  image: string;
  env: Record<string, string>;
  registryAuth?: { username: string; password: string; server?: string };
  /** The PRIMARY placement — targets equal to it are skipped. */
  primaryServerId: number | null;
}

/**
 * Push the release to every extra target node. Best-effort per node; returns
 * the per-target outcome so the caller can persist `service_targets`.
 */
export async function deployToTargets(
  db: DB,
  ctx: FanoutContext,
  log: (line: string) => void,
): Promise<Array<{ serverId: number; runtimeId: string | null; ok: boolean; error?: string }>> {
  const rows = await db
    .select({ serverId: serviceTargets.serverId, runtimeId: serviceTargets.runtimeId })
    .from(serviceTargets)
    .where(eq(serviceTargets.serviceId, ctx.service.id));
  const results: Array<{ serverId: number; runtimeId: string | null; ok: boolean; error?: string }> = [];

  for (const target of rows) {
    if (ctx.primaryServerId !== null && target.serverId === ctx.primaryServerId) continue;
    const name = `${ctx.service.slug}-t${target.serverId}-${ctx.deploymentId}`;
    const agent: AgentCaller = (op, params, sink) => agentOp(db, target.serverId, op, params, sink);
    try {
      if (ctx.registryAuth) {
        await agent(
          'docker.login',
          { username: ctx.registryAuth.username, password: ctx.registryAuth.password, ...(ctx.registryAuth.server ? { server: ctx.registryAuth.server } : {}) },
          log,
        );
      }
      try {
        await agent('docker.pull', { image: ctx.image }, log);
      } finally {
        if (ctx.registryAuth) {
          await agent('docker.logout', ctx.registryAuth.server ? { server: ctx.registryAuth.server } : {}, log).catch(() => undefined);
        }
      }
      // Retire the previous generation first — docker.runEnv would refuse a
      // duplicate name otherwise.
      if (target.runtimeId) {
        await agent('docker.stop', { name: target.runtimeId }, () => undefined).catch(() => undefined);
        await agent('docker.rm', { name: target.runtimeId }, () => undefined).catch(() => undefined);
      }
      const envName = `${ctx.service.slug}-t${target.serverId}-${ctx.deploymentId}`;
      const wrote = await agent('file.writeEnv', { name: envName, env: ctx.env }, log);
      const envFile = wrote.lines.find((l) => l.startsWith('wrote '))?.slice('wrote '.length) ?? `.agent-env/${envName}.env`;
      const runParams: Record<string, unknown> = { name, image: ctx.image, envFile };
      if (ctx.service.cpuShares > 0) runParams['cpuShares'] = String(ctx.service.cpuShares);
      if (ctx.service.cpuLimitMilli > 0) runParams['cpuLimitMilli'] = String(ctx.service.cpuLimitMilli);
      if (ctx.service.memLimitMb > 0) runParams['memLimitMb'] = String(ctx.service.memLimitMb);
      if (ctx.service.volumeMount) {
        runParams['volume'] = `nd-svc-${ctx.service.slug}-data`;
        runParams['mount'] = ctx.service.volumeMount;
      }
      if (ctx.service.publishedPort && ctx.service.port) {
        runParams['publish'] = `${ctx.service.publishedPort}:${ctx.service.port}`;
      }
      try {
        await agent('docker.runEnv', runParams, log);
      } finally {
        await agent('file.deleteEnv', { name: envName }, log).catch(() => undefined);
      }
      const ok = await waitRunning(agent, name, log);
      results.push({ serverId: target.serverId, runtimeId: name, ok, error: ok ? undefined : 'container did not reach running state' });
      log(ok ? `✓ target node #${target.serverId} is serving ${name}` : `✗ target node #${target.serverId}: ${name} failed its container-state check`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ serverId: target.serverId, runtimeId: target.runtimeId, ok: false, error: message });
      log(`✗ target node #${target.serverId}: ${message} — the primary release is unaffected`);
    }
  }
  return results;
}

/** Tear every target container down (service delete / targets cleared). */
export async function teardownTargets(db: DB, serviceId: number, log: (line: string) => void): Promise<void> {
  const rows = await targetsForService(db, serviceId);
  for (const target of rows) {
    if (!target.runtimeId) continue;
    const agent: AgentCaller = (op, params, sink) => agentOp(db, target.serverId, op, params, sink);
    await agent('docker.stop', { name: target.runtimeId }, () => undefined).catch(() => undefined);
    await agent('docker.rm', { name: target.runtimeId }, () => undefined).catch(() => undefined);
    log(`target node #${target.serverId}: removed ${target.runtimeId}`);
  }
  await db.delete(serviceTargets).where(eq(serviceTargets.serviceId, serviceId));
}

/** Persist fan-out outcomes onto the target rows (upsert by (service, server)). */
export async function recordFanoutResults(
  db: DB,
  serviceId: number,
  results: Array<{ serverId: number; runtimeId: string | null; ok: boolean; error?: string }>,
): Promise<void> {
  for (const r of results) {
    const [existing] = await db
      .select({ id: serviceTargets.id })
      .from(serviceTargets)
      .where(and(eq(serviceTargets.serviceId, serviceId), eq(serviceTargets.serverId, r.serverId)))
      .limit(1);
    const values = {
      runtimeId: r.runtimeId,
      status: r.ok ? ('running' as const) : ('error' as const),
      updatedAt: new Date(),
    };
    if (existing) {
      await db.update(serviceTargets).set(values).where(eq(serviceTargets.id, existing.id));
    } else {
      await db.insert(serviceTargets).values({ serviceId, serverId: r.serverId, ...values });
    }
  }
}

/** Server rows (operator UI) that a service may fan out to. */
export async function listFanoutCandidates(db: DB): Promise<Array<{ id: number; name: string }>> {
  return db.select({ id: servers.id, name: servers.name }).from(servers);
}
