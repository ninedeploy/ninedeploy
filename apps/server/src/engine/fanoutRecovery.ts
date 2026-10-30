import { randomUUID } from 'node:crypto';
import { and, eq, exists, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { fanoutTransitions, services, serviceTargets, type DB, type FanoutTransition } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { capabilityRefusal } from '../lib/agentCapabilities.js';
import { audit } from '../lib/audit.js';
import { createRemoteDockerBuilder } from './builders/remoteDocker.js';
import { writeDynamicConfig } from './proxy.js';
import type { FanoutContext, FanoutTarget } from './fanout.js';

const LEASE_MS = 90_000;
interface Identity { id: string; name: string; managed: string | null; serviceId: string | null; deploymentId: string | null }
export async function containerIdentity(db: DB, serverId: number, name: string): Promise<Identity | null> {
  const reply = await agentOp(db, serverId, 'docker.identity', { name }, () => {});
  const receipts = reply.lines.filter(line => line.startsWith('ND-CONTAINER '));
  if (reply.exitCode !== 0 || receipts.length !== 1 || Buffer.byteLength(receipts[0]!) > 16_384) throw new Error('Container identity was not confirmed; update the node agent');
  const value = JSON.parse(receipts[0]!.slice(13)) as Identity | null;
  if (value && (!/^[a-f0-9]{64}$/.test(value.id) || typeof value.name !== 'string')) throw new Error('Invalid container identity receipt');
  return value;
}

function recoveryLease(db: DB, row: FanoutTransition, token: string) {
  let stopped = false, lost = false, renewal: Promise<unknown> | undefined;
  const held = () => and(eq(fanoutTransitions.id, row.id), eq(fanoutTransitions.ownerToken, token), gt(fanoutTransitions.leaseUntil, new Date()));
  const patch = async (values: Partial<typeof fanoutTransitions.$inferInsert>) => {
    const updated = await db.update(fanoutTransitions).set({ ...values, updatedAt: new Date() }).where(held()).returning();
    if (updated.length === 0) { lost = true; throw new Error('Fan-out recovery ownership changed; runtimes retained'); }
    Object.assign(row, updated[0]);
  };
  const heartbeat = setInterval(() => {
    if (stopped || renewal) return;
    renewal = patch({ leaseUntil: new Date(Date.now() + LEASE_MS) }).catch(() => { lost = true; }).finally(() => { renewal = undefined; });
  }, 15_000); heartbeat.unref();
  const check = async () => {
    if (lost || stopped || !(await db.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(held()).limit(1)).length) throw new Error('Fan-out recovery ownership changed; runtimes retained');
  };
  const captureCandidate = async (createdId?: string) => {
    if (createdId !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(createdId) || row.candidateContainerId && row.candidateContainerId !== createdId) throw new Error('Candidate creation identity changed; retained');
      if (!row.candidateContainerId) await patch({ candidateContainerId: createdId });
    }
    const identity = await containerIdentity(db, row.serverId, row.candidateRuntimeId);
    if (!identity || identity.name !== row.candidateRuntimeId || identity.managed !== 'service' || identity.serviceId !== String(row.serviceId) || identity.deploymentId !== String(row.deploymentId)) throw new Error('Candidate ownership was not confirmed; runtimes retained');
    if (row.candidateContainerId && row.candidateContainerId !== identity.id) throw new Error('Candidate container identity changed; retained');
    await patch({ candidateContainerId: identity.id, ...(createdId ? { phase: 'preparing' as const, reason: null } : {}) });
  };
  const retire = async (name: string) => {
    await check();
    if (row.phase === 'retiring' && row.desiredRuntimeId === name) throw new Error('The selected serving generation cannot be retired');
    const referenced = await db.select({ id: serviceTargets.id }).from(serviceTargets).where(and(eq(serviceTargets.serverId, row.serverId), eq(serviceTargets.runtimeId, name))).limit(1);
    const primary = await db.select({ id: services.id }).from(services).where(and(eq(services.serverId, row.serverId), eq(services.runtimeId, name))).limit(1);
    if (referenced.length || primary.length) throw new Error('Container is still referenced by a placement; retained');
    if (row.phase !== 'retiring' && name !== row.candidateRuntimeId) throw new Error('Retirement has not been committed');
    if (name === row.candidateRuntimeId && !row.candidateContainerId) {
      if (!await containerIdentity(db, row.serverId, name)) return;
      await captureCandidate();
    }
    const id = name === row.candidateRuntimeId ? row.candidateContainerId : name === row.previousRuntimeId ? row.previousContainerId : null;
    if (!id) {
      if (!await containerIdentity(db, row.serverId, name)) return;
      throw new Error('Container identity is unknown; retained for review');
    }
    const actual = await containerIdentity(db, row.serverId, id);
    if (!actual) return;
    if (actual.name !== name) throw new Error('Container was renamed; retained for review');
    await check();
    const result = await agentOp(db, row.serverId, 'docker.retire', { id, name }, () => {});
    if (!result.lines.includes(`ND-RETIRED ${id}`)) throw new Error('Container retirement was not confirmed');
  };
  const stopHeartbeat = async () => { clearInterval(heartbeat); await renewal; };
  return {
    row, check, patch, captureCandidate, retire,
    async blockUnknownCreation() { await patch({ phase: 'blocked', reason: 'Candidate creation identity is unconfirmed; runtimes retained for review' }); },
    fence: () => exists(db.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(held())),
    async complete() {
      await check(); await stopHeartbeat();
      const deleted = await db.delete(fanoutTransitions).where(held()).returning({ id: fanoutTransitions.id });
      if (!deleted.length) throw new Error('Fan-out recovery ownership changed');
      stopped = true;
    },
    async release(reason = 'Routing or cleanup needs confirmation') {
      await stopHeartbeat();
      if (!stopped && !lost) await patch({ phase: row.phase === 'retiring' || row.phase === 'blocked' ? row.phase : 'retained', reason: reason.slice(0, 300), ownerToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6)) * 1000) }).catch(() => {});
      stopped = true;
    },
  };
}
export type FanoutRecoveryLease = ReturnType<typeof recoveryLease>;

export async function beginFanoutTransition(db: DB, ctx: FanoutContext, target: FanoutTarget, candidate: string): Promise<FanoutRecoveryLease> {
  const token = randomUUID();
  const [entry] = await db.insert(fanoutTransitions).values({
    serviceId: ctx.service.id, serverId: target.serverId, targetId: target.id!, deploymentId: ctx.deploymentId,
    primaryRuntimeId: ctx.primaryRuntimeId!, previousRuntimeId: target.runtimeId, candidateRuntimeId: candidate,
    port: ctx.service.port!, healthPath: ctx.service.healthPath ?? '/', healthCheck: ctx.service.healthCheck,
    ownerToken: token, leaseUntil: new Date(Date.now() + LEASE_MS),
  }).onConflictDoNothing().returning();
  if (!entry) throw new Error('This target has pending recovery; wait for reconciliation or retry it from Settings');
  const lease = recoveryLease(db, entry, token);
  try {
    if (target.runtimeId) {
      const previous = await containerIdentity(db, target.serverId, target.runtimeId);
      if (previous && previous.name !== target.runtimeId) throw new Error('Previous container identity changed');
      await lease.patch({ previousContainerId: previous?.id ?? null });
    }
    return lease;
  } catch (error) { await lease.release('Previous container identity unavailable'); throw error; }
}

export async function listFanoutRecovery(db: DB, serviceId: number) {
  const rows = await db.select().from(fanoutTransitions).where(eq(fanoutTransitions.serviceId, serviceId)).limit(100);
  return rows.map(row => ({ id: row.id, serverId: row.serverId, deploymentId: row.deploymentId, phase: row.phase,
    previousRuntimeId: row.previousRuntimeId, candidateRuntimeId: row.candidateRuntimeId, reason: row.reason,
    busy: row.leaseUntil != null && row.leaseUntil.getTime() > Date.now(), attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
}

export async function reconcileFanoutTransitions(db: DB, opts: { serviceId?: number; force?: boolean; signal?: AbortSignal; log?: (line: string) => void } = {}) {
  const log = opts.log ?? (() => {}), now = new Date();
  const entries = await db.select().from(fanoutTransitions).where(and(
    or(isNull(fanoutTransitions.leaseUntil), lte(fanoutTransitions.leaseUntil, now)),
    opts.force ? undefined : lte(fanoutTransitions.nextAttemptAt, now),
    opts.serviceId == null ? undefined : eq(fanoutTransitions.serviceId, opts.serviceId),
  )).limit(10);
  let recovered = 0, heldCount = 0;
  for (const selected of entries) {
    if (opts.signal?.aborted) break;
    const token = randomUUID();
    const [claimed] = await db.update(fanoutTransitions).set({ ownerToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), attempts: sql`${fanoutTransitions.attempts} + 1` })
      .where(and(eq(fanoutTransitions.id, selected.id), or(isNull(fanoutTransitions.leaseUntil), lte(fanoutTransitions.leaseUntil, new Date())))).returning();
    if (!claimed) continue;
    const entry = claimed;
    const lease = recoveryLease(db, claimed, token);
    try {
      const check = async () => { if (opts.signal?.aborted) throw new Error('Recovery stopped; runtimes retained'); await lease.check(); };
      await check();
      if (claimed.phase === 'blocked' && !claimed.candidateContainerId) throw new Error('Candidate creation identity is unconfirmed; runtimes retained for review');
      const refusal = await capabilityRefusal((op, params, sink) => agentOp(db, entry.serverId, op, params, sink), `#${entry.serverId}`,
        await agentTransportSealed(db, entry.serverId), { cap: ['docker.recovery', 'proxy.routingAck'], feature: 'reconcile container generations', sealedRequired: true });
      if (refusal) throw new Error(refusal.message);
      if (claimed.phase === 'blocked') {
        const id = claimed.candidateContainerId!;
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Candidate creation identity is invalid; runtimes retained');
        const byId = await containerIdentity(db, entry.serverId, id); await check();
        const byName = await containerIdentity(db, entry.serverId, entry.candidateRuntimeId); await check();
        const matches = (value: Identity | null) => value?.id === id && value.name === entry.candidateRuntimeId && value.managed === 'service' &&
          value.serviceId === String(entry.serviceId) && value.deploymentId === String(entry.deploymentId);
        if (!matches(byId) || !matches(byName)) throw new Error('Candidate creation identity changed; runtimes retained');
        await lease.patch({ phase: 'retained', reason: null });
      }
      const svc = await db.query.services.findFirst({ where: eq(services.id, entry.serviceId) });
      if (!svc || svc.status !== 'running' || !svc.runtimeId) throw new Error('Service is stopped or unavailable; no runtime was started or removed');
      const primaryRuntimeId = svc.runtimeId;
      let target = await db.query.serviceTargets.findFirst({ where: and(eq(serviceTargets.serviceId, entry.serviceId), eq(serviceTargets.serverId, entry.serverId)) });
      if (target && (target.id !== entry.targetId || (target.runtimeId !== entry.previousRuntimeId && target.runtimeId !== entry.candidateRuntimeId))) throw new Error('Target ownership changed; review the retained generations');
      if (!target && svc.serverId === entry.serverId) throw new Error('This node became the primary placement; review the retained generations');
      if (entry.phase === 'retiring' && (target?.runtimeId ?? null) !== entry.desiredRuntimeId) throw new Error('Committed serving generation changed; runtimes retained for review');
      if (!lease.row.candidateContainerId) {
        const candidate = await containerIdentity(db, entry.serverId, entry.candidateRuntimeId);
        if (candidate) await lease.captureCandidate();
      }
      const healthy = async (name: string, id: string | null) => {
        if (!id) return false;
        const actual = await containerIdentity(db, entry.serverId, id);
        if (!actual || actual.name !== name) return false;
        const mode = entry.healthCheck === 'http-strict' || entry.healthCheck === 'tcp' || entry.healthCheck === 'running' || entry.healthCheck === 'command' ? entry.healthCheck : undefined;
        if (mode === 'http-strict' || mode === 'tcp' || !mode && entry.port) {
          const why = await capabilityRefusal((op, p, sink) => agentOp(db, entry.serverId, op, p, sink), `#${entry.serverId}`, true,
            { cap: 'docker.probe', feature: 'probe application readiness', sealedRequired: true });
          if (why) throw new Error(why.message);
        }
        return createRemoteDockerBuilder((op, p, sink, options) => agentOp(db, entry.serverId, op, p, sink, options), { pollMs: 1000 }).isHealthy(
          { runtimeId: id, port: entry.port, healthPath: entry.healthPath, ...(mode ? { healthCheck: mode } : {}) }, 10_000, 10_000, log);
      };
      const primaryOwner = exists(db.select({ id: services.id }).from(services).where(and(eq(services.id, svc.id), eq(services.status, 'running'), eq(services.runtimeId, primaryRuntimeId))));
      const targetOwned = (runtimeId: string | null) => and(eq(serviceTargets.id, entry.targetId), runtimeId == null ? isNull(serviceTargets.runtimeId) : eq(serviceTargets.runtimeId, runtimeId), primaryOwner, lease.fence());
      if (target?.runtimeId) {
        const desiredId = target.runtimeId === entry.candidateRuntimeId ? lease.row.candidateContainerId : entry.previousContainerId;
        if (!await healthy(target.runtimeId, desiredId)) {
          if (entry.phase === 'retiring' || target.runtimeId !== entry.candidateRuntimeId || !entry.previousRuntimeId || !await healthy(entry.previousRuntimeId, entry.previousContainerId)) throw new Error('No confirmed healthy generation; both runtimes retained');
          await check();
          const restored = await db.update(serviceTargets).set({ runtimeId: entry.previousRuntimeId, status: 'error', updatedAt: new Date() })
            .where(targetOwned(target.runtimeId)).returning();
          if (!restored.length) throw new Error('Target or service changed during recovery');
          target = restored[0];
        }
      }
      const stillCurrent = async () => {
        await check();
        if (target) return (await db.select({ id: serviceTargets.id }).from(serviceTargets).where(targetOwned(target.runtimeId)).limit(1)).length > 0;
        const [owner] = await db.select({ id: services.id }).from(services).where(and(eq(services.id, svc.id), eq(services.status, 'running'), eq(services.runtimeId, primaryRuntimeId)));
        const present = await db.query.serviceTargets.findFirst({ where: and(eq(serviceTargets.serviceId, entry.serviceId), eq(serviceTargets.serverId, entry.serverId)) });
        return !!owner && !present;
      };
      if (!await stillCurrent()) throw new Error('Target or service changed before routing recovery');
      await writeDynamicConfig(db, { requireNode: entry.serverId, confirmNodeRouting: true });
      if (!await stillCurrent()) throw new Error('Target or service changed during routing recovery');
      if (target) await db.update(serviceTargets).set({ status: target.runtimeId ? 'running' : 'error', updatedAt: new Date() }).where(targetOwned(target.runtimeId));
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!await stillCurrent()) throw new Error('Target or service changed before retirement commitment');
      await lease.patch({ phase: 'retiring', desiredRuntimeId: target?.runtimeId ?? null });
      for (const name of [...new Set([entry.previousRuntimeId, entry.candidateRuntimeId])]) {
        if (!name || name === target?.runtimeId) continue;
        if (!await stillCurrent()) throw new Error('Target or service changed during recovery drain');
        const referenced = await db.select({ id: serviceTargets.id }).from(serviceTargets).where(and(eq(serviceTargets.serverId, entry.serverId), eq(serviceTargets.runtimeId, name))).limit(1);
        const primary = await db.select({ id: services.id }).from(services).where(and(eq(services.serverId, entry.serverId), eq(services.runtimeId, name))).limit(1);
        if (referenced.length || primary.length) throw new Error('Retained container is referenced by a live placement; review required');
        const id = name === entry.candidateRuntimeId ? lease.row.candidateContainerId : entry.previousContainerId;
        if (!id && !await containerIdentity(db, entry.serverId, name)) continue;
        await lease.retire(name);
      }
      if (!await stillCurrent()) throw new Error('Recovery ownership changed');
      await lease.complete(); recovered++;
      await audit(db, null, 'service.fanout_recovered', `service #${entry.serviceId}, node #${entry.serverId}`, { serviceId: entry.serviceId, serverId: entry.serverId, deploymentId: entry.deploymentId }).catch(() => {});
    } catch (error) {
      heldCount++;
      const reason = error instanceof Error ? error.message : 'Fan-out recovery unavailable';
      log(`fan-out recovery node #${entry.serverId}: ${reason}`);
      await lease.release(reason);
    } finally { await lease.release(); }
  }
  return { recovered, held: heldCount };
}
