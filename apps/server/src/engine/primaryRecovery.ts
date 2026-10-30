import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { and, eq, exists, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { deployments, nodeAutoscaleCapacity, primaryTransitions, services, serviceTargets, type DB, type PrimaryRuntimeSnapshot, type PrimaryTransition, type Service } from '@ninedeploy/db';
import { containerIdentityOps } from '../agentOps/containerIdentity.js';
import { observabilityOps } from '../agentOps/observability.js';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { agentVersionAtLeast, capabilityRefusal, parseAgentCapabilities } from '../lib/agentCapabilities.js';
import { verifyNodeReadiness } from '../lib/nodeReadiness.js';
import { createNodeDeploymentAuthority } from '../lib/nodeDeploymentOwner.js';
import { createNodeRuntimeMutationClient } from '../lib/nodeRuntimeMutationClient.js';
import { retireNodeDeploymentGeneration } from '../lib/nodeDeploymentRetirement.js';
import { serviceRuntimeRevision } from '../lib/serviceRuntimeOwner.js';
import { handoffNodeDeploymentPreparation } from '../lib/nodeDeploymentPreparation.js';
import { capture, run, sleep } from '../lib/exec.js';
import { audit } from '../lib/audit.js';
import { portProxyDir, restrictedMappings } from '../lib/portProxy.js';
import { dockerBuilder } from './builders/docker.js';
import { createRemoteDockerBuilder } from './builders/remoteDocker.js';
import { endCanary } from './canaryState.js';
import { MAX_REPLICAS, replicaNames } from './dockerNames.js';
import { writeDynamicConfig } from './proxy.js';
import { logBus } from './logs.js';
import { swarmRuntimeOf, isSwarmRuntimeId } from '../lib/swarm.js';
import { capturePreviousNative, previousNativeHealthy, previousNativeRetired, retirePreviousNative } from './previousNative.js';
import type { Builder, DeployRuntime } from './types.js';

const LEASE_MS = 90_000;
/** Longest a pending transition waits between attempts while its service has a queued deploy. */
const QUEUED_RETRY_MS = 60_000;
const ACTIVE = ['building', 'deploying'] as const;
interface Identity { id: string; name: string; managed: string | null; serviceId: string | null; deploymentId: string | null }
export class PrimaryRecoveryOwnershipLost extends Error {
  constructor() { super('Primary recovery ownership changed; runtime generations retained'); }
}
export class PrimaryRecoveryPending extends Error {
  constructor() { super('Primary runtime recovery is pending; wait for recovery or retry it from Settings'); }
}
export class PrimaryIdentityUnconfirmed extends Error {
  constructor() { super('Container identity is unconfirmed; generations retained for recovery'); }
}
const sameHost = (column: typeof services.serverId, serverId: number | null) => serverId == null ? isNull(column) : eq(column, serverId);
const fingerprint = (svc: Service) => JSON.stringify([svc.runtimeId, svc.status, svc.serverId, svc.port, svc.runtimeReplicas, svc.healthPath, svc.healthCheck, svc.healthCommand, svc.portMappings, svc.publishedPort, svc.asleepAt]);

/** The local controller uses the same operand-validated Docker primitives; no agent transport is involved. */
async function localOp(op: string, params: Record<string, unknown>, sink: (line: string) => void) {
  const def = containerIdentityOps.ops[op] ?? observabilityOps.ops[op];
  if (def) return def.run(params, sink, { sealed: true, lifecycleJournalRoot: join(config.paths.dataDir, 'local-lifecycle') });
  if (op === 'docker.inspect' && params.format === 'health' && /^[a-f0-9]{64}$/.test(String(params.name))) {
    sink(await capture('docker', ['inspect', String(params.name), '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{if .State.Health}}{{.State.Health.FailingStreak}}{{else}}0{{end}}|{{.RestartCount}}'], { timeoutMs: 10_000 }));
    return 0;
  }
  throw new Error('Unsupported local recovery operation');
}
function caller(db: DB, serverId: number | null) {
  return async (op: string, params: Record<string, unknown>, sink: (line: string) => void, options?: { timeoutMs?: number; signal?: AbortSignal }) => {
    if (serverId != null) return agentOp(db, serverId, op, params, sink, options);
    const lines: string[] = [];
    const exitCode = await localOp(op, params, line => { lines.push(line); sink(line); });
    return { exitCode, lines };
  };
}
async function identity(db: DB, serverId: number | null, name: string): Promise<Identity | null> {
  const reply = await caller(db, serverId)('docker.identity', { name }, () => {});
  const lines = reply.lines.filter(l => l.startsWith('ND-CONTAINER '));
  if (reply.exitCode !== 0 || lines.length !== 1 || Buffer.byteLength(lines[0]!) > 16_384) throw new Error('Container identity was not confirmed');
  const value = JSON.parse(lines[0]!.slice(13)) as Identity | null;
  if (value !== null && (typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.name !== 'string')) throw new Error('Invalid container identity receipt');
  return value;
}
async function requireCapabilities(db: DB, serverId: number | null, probe = false) {
  const features = { batchReadiness: false, retirementGrace: false };
  if (serverId == null) return features;
  const agent = caller(db, serverId);
  const why = await capabilityRefusal(async (op, params, sink) => {
    const result = await agent(op, params, sink);
    if (op === 'agent.ping') {
      const info = parseAgentCapabilities(result.lines);
      features.batchReadiness = info.caps.has('docker.readiness');
      features.retirementGrace = info.caps.has('docker.lifecycle') || agentVersionAtLeast(info.version, '0.19.0');
    }
    return result;
  }, `#${serverId}`, await agentTransportSealed(db, serverId), {
    cap: ['docker.recovery', 'proxy.routingAck', ...(probe ? ['docker.probe' as const] : [])], feature: 'recover primary runtime transitions', sealedRequired: true,
  });
  if (why) throw new Error(why.message);
  return features;
}
async function mapFour<T>(values: T[], fn: (value: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => { while (next < values.length) await fn(values[next++]!); }));
}
function snapshot(runtime: DeployRuntime, commitSha: string | null): PrimaryRuntimeSnapshot {
  const names = replicaNames(runtime.runtimeId, runtime.replicas ?? 1);
  const targets = runtime.nodeTargets;
  const capacity = runtime.nodeCapacityTargets, allNames = replicaNames(runtime.runtimeId, MAX_REPLICAS);
  if (targets && (targets.length !== names.length || targets.some((target, index) => target.name !== names[index] || !/^[a-f0-9]{64}$/.test(target.id)) ||
    new Set(targets.map(target => target.id)).size !== targets.length)) throw new Error('Invalid candidate creation identities');
  if (capacity && (capacity.length < names.length || capacity.length > MAX_REPLICAS || capacity.some((target, index) =>
    target.name !== allNames[index] || !/^[a-f0-9]{64}$/.test(target.id)) || new Set(capacity.map(target => target.id)).size !== capacity.length ||
    targets?.some((target, index) => target.id !== capacity[index]?.id) || runtime.nodeReadinessId && runtime.nodeReadinessId !== capacity[0]?.id)) {
    throw new Error('Invalid candidate capacity creation identities');
  }
  if (runtime.nodeReadinessId && (!/^[a-f0-9]{64}$/.test(runtime.nodeReadinessId) || names.length !== 1 || targets && targets[0]?.id !== runtime.nodeReadinessId)) {
    throw new Error('Invalid candidate creation identity');
  }
  return { runtimeId: runtime.runtimeId, port: runtime.port, healthPath: runtime.healthPath, healthCheck: runtime.healthCheck ?? null,
    replicas: names.length, commitSha, containers: names.map((name, index) => ({ name, id: targets?.[index]?.id ?? capacity?.[index]?.id ?? runtime.nodeReadinessId ?? null, observed: false })),
    spares: allNames.slice(names.length).map((name, index) => ({ name, id: capacity?.[names.length + index]?.id ?? null, observed: false })) };
}
const identities = (group: PrimaryRuntimeSnapshot) => [...group.containers, ...(group.spares ?? [])];
function validateSnapshot(value: PrimaryRuntimeSnapshot) {
  if (!value || typeof value.runtimeId !== 'string' || !Number.isInteger(value.replicas) || value.replicas < 1 || value.replicas > MAX_REPLICAS || !Array.isArray(value.containers)) throw new Error('Invalid recovery snapshot; review required');
  if (value.native) {
    if (!isSwarmRuntimeId(value.runtimeId) || value.containers.length || value.spares?.length) throw new Error('Invalid native recovery snapshot; review required');
    return;
  }
  const expected = replicaNames(value.runtimeId, value.replicas);
  if (value.containers.length !== expected.length || value.containers.some((c, i) => c.name !== expected[i] || typeof c.observed !== 'boolean' || (c.id !== null && !/^[a-f0-9]{64}$/.test(c.id)))) throw new Error('Invalid recovery identities; review required');
  const spareNames = replicaNames(value.runtimeId, MAX_REPLICAS).slice(value.replicas);
  if (value.spares !== undefined && (!Array.isArray(value.spares) || value.spares.length > spareNames.length || value.spares.some((c, i) => c.name !== spareNames[i] || typeof c.observed !== 'boolean' || (c.id !== null && !/^[a-f0-9]{64}$/.test(c.id))))) throw new Error('Invalid spare identities; review required');
}

function primaryLease(db: DB, initial: PrimaryTransition, token: string, features = { batchReadiness: false, retirementGrace: false }) {
  const row = { ...initial };
  const orderedAuthority = row.orderedOwner ? createNodeDeploymentAuthority(db, row.orderedOwner) : undefined;
  let lost = false, stopped = false, completed = false, renewal: Promise<unknown> | undefined;
  let loaded: string | null | undefined;
  let loadedFingerprint: string | undefined;
  const held = () => and(eq(primaryTransitions.id, row.id), eq(primaryTransitions.ownerToken, token), gt(primaryTransitions.leaseUntil, new Date()), orderedAuthority?.fence());
  const patch = async (values: Partial<typeof primaryTransitions.$inferInsert>) => {
    const changed = await db.update(primaryTransitions).set({ ...values, updatedAt: new Date() }).where(held()).returning({ id: primaryTransitions.id });
    if (!changed.length) { lost = true; throw new PrimaryRecoveryOwnershipLost(); }
    Object.assign(row, values);
  };
  const heartbeat = setInterval(() => {
    if (stopped || renewal) return;
    renewal = patch({ leaseUntil: new Date(Date.now() + LEASE_MS) }).catch(() => { lost = true; }).finally(() => { renewal = undefined; });
  }, 15_000); heartbeat.unref();
  const check = async () => {
    if (completed) return;
    if (lost || stopped || !(await db.select({ id: primaryTransitions.id }).from(primaryTransitions).where(held()).limit(1)).length) { lost = true; throw new PrimaryRecoveryOwnershipLost(); }
  };
  const noNewer = () => sql`NOT EXISTS (SELECT 1 FROM deployments AS newer WHERE newer.service_id = ${row.serviceId} AND newer.id > ${row.deploymentId} AND newer.status IN ('building','deploying','running','superseded'))`;
  const owner = () => and(eq(services.id, row.serviceId), eq(services.type, 'docker'), or(isNull(services.orchestrator), ne(services.orchestrator, 'swarm')), sameHost(services.serverId, row.serverId), noNewer());
  const current = async () => {
    await check();
    await orderedAuthority?.check();
    const [svc] = await db.select().from(services).where(owner()).limit(1);
    if (!svc || (svc.runtimeId !== row.previous?.runtimeId && svc.runtimeId !== row.candidate.runtimeId && !(svc.runtimeId == null && !row.previous))) throw new Error('Service placement or runtime owner changed; retained for review');
    return svc;
  };
  const captureIdentities = async () => {
    for (const kind of ['previous', 'candidate'] as const) {
      const group = row[kind]; if (!group) continue; validateSnapshot(group);
      if (group.native) {
        if (kind !== 'previous' || row.serverId != null) throw new Error('Invalid native recovery placement; review required');
        continue;
      }
      // Persist each completed observation. A crash cannot turn an unknown ID into permission to delete by name.
      for (const [index, item] of identities(group).entries()) {
        if (item.observed) continue;
        const actual = await identity(db, row.serverId, item.name);
        const svc = await current();
        if (item.id && actual?.id !== item.id) throw new Error('Container creation identity changed; retained');
        if (actual && actual.name !== item.name) throw new Error('Container generation changed; retained');
        if (actual && kind === 'candidate' && (actual.managed !== 'service' || actual.serviceId !== String(row.serviceId) || actual.deploymentId !== String(row.deploymentId))) throw new Error('Candidate ownership was not confirmed');
        if (actual && kind === 'previous' && svc.runtimeId !== group.runtimeId && (actual.managed !== 'service' || actual.serviceId !== String(row.serviceId))) throw new Error('Unobserved previous identity is not owned; review required');
        if (actual && index >= group.containers.length) {
          const baseId = group.containers[0]?.id;
          const base = baseId ? await identity(db, row.serverId, baseId) : null;
          if (!base?.deploymentId || actual.serviceId !== String(row.serviceId) || actual.deploymentId !== base.deploymentId
            || (actual.managed !== 'service' && !(row.serverId == null && actual.managed == null))) throw new Error('Spare container ownership is unconfirmed; retained for review');
        }
        item.id = actual?.id ?? null; item.observed = true;
        await patch({ [kind]: { ...group, containers: group.containers.map(c => ({ ...c })), ...(group.spares ? { spares: group.spares.map(c => ({ ...c })) } : {}) } });
      }
    }
  };
  const confirm = async () => {
    const before = await current();
    const selected = before.runtimeId;
    await writeDynamicConfig(db, row.serverId == null ? { confirmLocalRouting: true } : { requireNode: row.serverId, confirmNodeRouting: true });
    const after = await current();
    if (fingerprint(after) !== fingerprint(before)) throw new Error('Service changed during routing confirmation');
    loaded = selected;
    loadedFingerprint = fingerprint(after);
  };
  const stopId = async (id: string, grace: number) => {
    if (row.serverId == null) await run('docker', ['stop', '-t', String(grace), id], { timeoutMs: (grace + 10) * 1000 }, () => {});
    else await caller(db, row.serverId)('docker.stop', { name: id, graceSeconds: String(grace) }, () => {});
  };
  const retire = async (name: string, opts?: { graceSeconds?: number }) => {
    const svc = await current();
    const group = row.previous?.runtimeId === name ? row.previous : row.candidate.runtimeId === name ? row.candidate : null;
    if (!group || svc.runtimeId === name) throw new Error('The selected serving generation cannot be retired');
    if (restrictedMappings(svc.portMappings).length || (row.serverId == null && existsSync(portProxyDir(svc.slug)))) throw new Error('Restricted TCP port proxy needs separate routing confirmation; generations retained for review');
    if (row.phase === 'retiring' && row.desiredRuntimeId !== svc.runtimeId) throw new Error('Committed serving generation changed; retained');
    if (row.routingTouched && (loaded !== svc.runtimeId || loadedFingerprint !== fingerprint(svc))) throw new Error('Routing is not confirmed; runtime generations retained');
    if (row.phase !== 'retiring') await patch({ phase: 'retiring', desiredRuntimeId: svc.runtimeId });
    const names = group.native ? [group.runtimeId] : identities(group).map(c => c.name);
    const referenced = await db.select({ id: services.id }).from(services).where(and(sameHost(services.serverId, row.serverId), inArray(services.runtimeId, names))).limit(1);
    const targeted = row.serverId == null ? [] : await db.select({ id: serviceTargets.id }).from(serviceTargets).where(and(eq(serviceTargets.serverId, row.serverId), inArray(serviceTargets.runtimeId, names))).limit(1);
    if (referenced.length || targeted.length) throw new Error('Container generation is referenced by a placement; retained');
    if (group.native) {
      await retirePreviousNative(group.native, group.runtimeId, current, encoded => patch({ previous: { ...group, native: encoded } }));
      return;
    }
    const grace = Math.max(0, Math.min(300, Math.floor(opts?.graceSeconds ?? 5)));
    if (row.orderedOwner) {
      if (row.serverId == null || row.orderedOwner.serverId !== row.serverId || row.orderedOwner.serviceId !== row.serviceId ||
        row.orderedOwner.deploymentId !== row.deploymentId) throw new Error('Node deployment recovery authority changed');
      for (const item of identities(group)) {
        await current();
        if (!item.observed) throw new Error('Container identity is unknown; retained for review');
        if (!item.id && await identity(db, row.serverId, item.name)) throw new Error('Container name was reused; retained for review');
      }
      const intent = { runtimeId: name, graceSeconds: grace };
      if (row.orderedRetirement && JSON.stringify(row.orderedRetirement) !== JSON.stringify(intent)) throw new Error('Node deployment retirement intent changed');
      if (!row.orderedRetirement) await patch({ orderedRetirement: intent });
      const checkpoint = async () => {
        const selected = await current();
        if (selected.runtimeId !== svc.runtimeId || row.routingTouched && (loaded !== selected.runtimeId || loadedFingerprint !== fingerprint(selected))) {
          throw new Error('Node deployment retirement routing changed');
        }
      };
      const client = createNodeRuntimeMutationClient(db, row.serverId, { checkpoint });
      await retireNodeDeploymentGeneration(client, { owner: row.orderedOwner, group, selectedRuntimeId: svc.runtimeId, graceSeconds: grace, checkpoint });
      return;
    }
    for (const item of identities(group)) {
      await current();
      if (!item.observed) throw new Error('Container identity is unknown; retained for review');
      if (!item.id) {
        if (await identity(db, row.serverId, item.name)) throw new Error('Container name was reused; retained for review');
        continue;
      }
      const actual = await identity(db, row.serverId, item.id);
      if (!actual) continue;
      if (actual.name !== item.name) throw new Error('Container was renamed; retained for review');
      await current();
      // New agents retire the generation atomically by ID; their legacy Stop is deliberately fenced.
      // Older agents retain the separate Stop so a configured grace is still honored.
      if (!features.retirementGrace) { await stopId(item.id, grace); await current(); }
      const reply = features.retirementGrace
        ? await caller(db, row.serverId)('docker.retire', { id: item.id, name: item.name, graceSeconds: String(grace) }, () => {}, { timeoutMs: Math.max(35_000, (grace + 30) * 1000) })
        : await caller(db, row.serverId)('docker.retire', { id: item.id, name: item.name }, () => {});
      await current();
      if (!reply.lines.includes(`ND-RETIRED ${item.id}`)) throw new Error('Container retirement was not confirmed');
    }
  };
  const completeIfSafe = async () => {
    const svc = await current();
    if (row.routingTouched && (loaded !== svc.runtimeId || loadedFingerprint !== fingerprint(svc))) return false;
    for (const group of [row.previous, row.candidate]) {
      if (!group || group.runtimeId === svc.runtimeId) continue;
      if (group.native) {
        if (!await previousNativeRetired(group.native, group.runtimeId)) return false;
        continue;
      }
      for (const item of identities(group)) {
        if (!item.observed) return false;
        if (item.id ? await identity(db, row.serverId, item.id) : await identity(db, row.serverId, item.name)) return false;
      }
    }
    if (row.orderedOwner && row.serverId != null) {
      const capacity = await db.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, row.deploymentId) });
      if (capacity) {
        const owner = row.orderedOwner;
        if (capacity.serviceId !== row.serviceId || capacity.serverId !== row.serverId || capacity.runtimeId !== row.candidate.runtimeId ||
          capacity.imageId !== row.imageDigest || owner.deploymentId !== row.deploymentId || owner.serviceId !== row.serviceId || owner.serverId !== row.serverId ||
          !Array.isArray(capacity.targets) || capacity.targets.length < row.candidate.replicas || capacity.targets.some((item, index) => {
            const observed = identities(row.candidate)[index];
            return !observed || !observed.observed || observed.name !== item.name || observed.id !== item.id;
          })) throw new Error('Node autoscale handoff capacity is unconfirmed');
        const checkpoint = async () => {
          const currentService = await current();
          if (currentService.runtimeId !== svc.runtimeId || row.routingTouched && (loaded !== currentService.runtimeId || loadedFingerprint !== fingerprint(currentService))) {
            throw new Error('Node autoscale handoff routing changed');
          }
        };
        const client = createNodeRuntimeMutationClient(db, row.serverId, { checkpoint });
        const requestId = createHash('sha256').update(`${owner.requestId}:primary-handoff`).digest('hex').slice(0, 32);
        const revision = serviceRuntimeRevision(owner.epoch, 3);
        await client.retire({ requestId, serviceId: row.serviceId, revision, timeoutMs: 30_000, graceSeconds: 0, targets: [] });
        await client.legacyHandoff({ requestId, serviceId: row.serviceId, revision, timeoutMs: 30_000, deploymentWatermark: row.deploymentId });
        await checkpoint();
      }
    }
    clearInterval(heartbeat); await renewal; await check();
    const removed = await db.delete(primaryTransitions).where(held()).returning({ id: primaryTransitions.id });
    if (!removed.length) { lost = true; throw new PrimaryRecoveryOwnershipLost(); }
    completed = true; stopped = true; return true;
  };
  return { row, check, patch, current, captureIdentities, confirm, retire, completeIfSafe,
    async verifyCandidate(builder: Builder, runtime: DeployRuntime, timeoutMs: number, log: (line: string) => void, checkpoint: () => Promise<void> = async () => undefined) {
      const deadline = Date.now() + timeoutMs;
      const readinessCheckpoint = async () => { await check(); await checkpoint(); await check(); };
      if (features.batchReadiness && row.serverId != null) {
        await readinessCheckpoint();
        const group = row.candidate;
        validateSnapshot(group);
        if (group.native || group.port !== runtime.port || group.containers.some(item => !item.observed || !item.id)) throw new Error('Candidate readiness identities are unconfirmed');
        const mode = runtime.healthCheck;
        const ready = await verifyNodeReadiness(caller(db, row.serverId), {
          targets: group.containers.map(item => ({ id: item.id!, name: item.name })),
          mode: mode === 'http-strict' || mode === 'tcp' || mode === 'running' || mode === 'command' ? mode : runtime.port ? 'tcp' : 'auto',
          port: runtime.port, path: runtime.healthPath,
        }, timeoutMs, readinessCheckpoint, log);
        await readinessCheckpoint();
        if (!ready) throw new Error('Candidate replicas did not pass node readiness');
        return;
      }
      await mapFour(row.candidate.containers, async item => {
        await readinessCheckpoint();
        if (!item.id) throw new Error(`Candidate ${item.name} is missing`);
        const probe = row.serverId == null ? { ...runtime, runtimeId: item.id }
          : { ...runtime, runtimeId: item.name, nodeReadinessId: item.id };
        const remaining = Math.max(1, deadline - Date.now());
        const healthy = row.serverId == null ? await builder.isHealthy(probe, remaining, 10_000, log)
          : await builder.isHealthy(probe, remaining, 10_000, log, { checkpoint: readinessCheckpoint });
        await readinessCheckpoint();
        if (!healthy || probe.port !== runtime.port) throw new Error(`Candidate ${item.name} did not pass readiness`);
      });
    },
    fence: () => completed ? sql`1` : and(exists(db.select({ id: primaryTransitions.id }).from(primaryTransitions).where(held())),
      exists(db.select({ id: services.id }).from(services).where(and(owner(), or(eq(services.runtimeId, row.candidate.runtimeId), row.previous ? eq(services.runtimeId, row.previous.runtimeId) : isNull(services.runtimeId))))),
    ),
    lost: () => lost,
    async intentCandidate(finalizeSnapshot?: string) { await patch({ phase: 'routing', routingTouched: true, desiredRuntimeId: row.candidate.runtimeId, ...(finalizeSnapshot !== undefined ? { finalizeSnapshot } : {}) }); loaded = undefined; },
    async beforeCanaryRouting() { await patch({ phase: 'routing', routingTouched: true, desiredRuntimeId: row.previous?.runtimeId ?? null }); loaded = undefined; },
    wrap(builder: Builder): Builder { return { ...builder,
      isHealthy: (runtime, ...args) => runtime.runtimeId === row.previous?.runtimeId && row.previous.native
        ? previousNativeHealthy(db, row.previous.native, row.serviceId, runtime) : builder.isHealthy(runtime, ...args),
      stop: (name, opts) => retire(name, opts) }; },
    async release(reason?: string) {
      clearInterval(heartbeat); await renewal;
      if (!stopped && !lost) {
        await patch({ reason: (reason ?? row.reason ?? 'Routing or obsolete-container cleanup needs confirmation').slice(0, 300), ownerToken: null, leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6)) * 1000) }).catch(() => {});
      }
      stopped = true;
    },
  };
}
export type PrimaryRecoveryLease = ReturnType<typeof primaryLease>;

export async function beginPrimaryTransition(db: DB, service: Service, deploymentId: number, candidate: DeployRuntime, previous: DeployRuntime | undefined, commitSha: string | null) {
  if (candidate.nodeDeploymentOwner) {
    if (candidate.nodeDeploymentOwner.serviceId !== service.id || candidate.nodeDeploymentOwner.serverId !== service.serverId || candidate.nodeDeploymentOwner.deploymentId !== deploymentId) throw new Error('Node deployment recovery authority changed');
    await createNodeDeploymentAuthority(db, candidate.nodeDeploymentOwner).check();
  }
  const features = await requireCapabilities(db, service.serverId ?? null, candidate.healthCheck === 'http-strict' || candidate.healthCheck === 'tcp');
  const token = randomUUID();
  const prior = previous ? snapshot({ ...previous, replicas: service.runtimeReplicas ?? 1 }, service.commitSha) : null;
  if (prior) {
    prior.healthCheck = service.healthCheck;
    if (swarmRuntimeOf(service)) {
      prior.native = await capturePreviousNative(db, service);
      prior.containers = []; prior.spares = [];
    }
  }
  const [row] = await db.insert(primaryTransitions).values({ serviceId: service.id, serverId: service.serverId, deploymentId,
    previous: prior, orderedOwner: candidate.nodeDeploymentOwner ?? null,
    candidate: snapshot(candidate, commitSha), desiredRuntimeId: previous?.runtimeId ?? null, imageDigest: candidate.imageDigest ?? null,
    ownerToken: token, leaseUntil: new Date(Date.now() + LEASE_MS),
  }).onConflictDoNothing().returning();
  if (!row) throw new Error('Primary runtime recovery is pending; resolve it before another deployment');
  const lease = primaryLease(db, row, token, features);
  try {
    await lease.captureIdentities();
    if (candidate.nodeDeploymentOwner && candidate.nodeCapacityTargets) await handoffNodeDeploymentPreparation(db, candidate.nodeDeploymentOwner, token);
    return lease;
  }
  catch { await lease.release('Container identities could not be captured'); throw new PrimaryIdentityUnconfirmed(); }
}

export async function primaryRecoveryPending(db: DB, serviceId: number) {
  return (await db.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, serviceId))).length > 0;
}
export async function listPrimaryRecovery(db: DB, serviceId: number) {
  const [r] = await db.select().from(primaryTransitions).where(eq(primaryTransitions.serviceId, serviceId)).limit(1);
  return r ? { id: r.id, serverId: r.serverId, deploymentId: r.deploymentId, phase: r.phase, previousRuntimeId: r.previous?.runtimeId ?? null,
    candidateRuntimeId: r.candidate.runtimeId, desiredRuntimeId: r.desiredRuntimeId, interrupted: r.interrupted,
    reason: r.reason, busy: r.leaseUntil != null && r.leaseUntil.getTime() > Date.now(), attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt.toISOString(), updatedAt: r.updatedAt.toISOString() } : null;
}

async function healthy(db: DB, row: PrimaryTransition, group: PrimaryRuntimeSnapshot) {
  validateSnapshot(group);
  if (group.native) {
    if (row.serverId != null || group.runtimeId !== row.previous?.runtimeId) throw new Error('Invalid native recovery placement');
    return previousNativeHealthy(db, group.native, row.serviceId, group);
  }
  let ready = true;
  await mapFour(group.containers, async item => {
    if (!item.id || !item.observed) { ready = false; return; }
    const actual = await identity(db, row.serverId, item.id);
    if (!actual || actual.name !== item.name) { ready = false; return; }
    const mode = group.healthCheck;
    const runtime: DeployRuntime = { runtimeId: item.id, port: group.port, healthPath: group.healthPath,
      ...(mode === 'http-strict' || mode === 'tcp' || mode === 'running' || mode === 'command' ? { healthCheck: mode } : {}) };
    if (row.serverId == null && mode !== 'running' && mode !== 'command' && mode !== 'http-strict' && mode !== 'tcp') {
      for (let i = 0; i < 3; i++) {
        const probe = { ...runtime };
        if (!await dockerBuilder.isHealthy(probe, 5000, 0) || probe.port !== group.port) { ready = false; break; }
        if (i < 2) await sleep(1000);
      }
    } else if (mode === 'command' && !(await caller(db, row.serverId)('docker.inspect', { name: item.id, format: 'health' }, () => {})).lines.some(line => /^running\|healthy\|/.test(line))) ready = false;
    else if (!await createRemoteDockerBuilder(caller(db, row.serverId), { pollMs: 1000 }).isHealthy(runtime, 10_000, 10_000)) ready = false;
  });
  return ready;
}

export async function reconcilePrimaryTransitions(db: DB, opts: { serviceId?: number; force?: boolean; signal?: AbortSignal; log?: (line: string) => void } = {}) {
  const now = new Date();
  // The backoff grows to an hour, and the worker holds every queued deploy of
  // the service while its transition is pending — so a service with a queued
  // deploy is retried at most a minute after its last attempt instead.
  const eligible = (at: Date) => or(lte(primaryTransitions.nextAttemptAt, at),
    and(lte(primaryTransitions.updatedAt, new Date(at.getTime() - QUEUED_RETRY_MS)),
      exists(db.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, primaryTransitions.serviceId), eq(deployments.status, 'queued'))))));
  const rows = await db.select().from(primaryTransitions).where(and(or(isNull(primaryTransitions.leaseUntil), lte(primaryTransitions.leaseUntil, now)),
    opts.force ? undefined : eligible(now), opts.serviceId == null ? undefined : eq(primaryTransitions.serviceId, opts.serviceId))).limit(10);
  let recovered = 0, held = 0;
  for (const pending of rows) {
    if (opts.signal?.aborted) break;
    const token = randomUUID();
    const [claimed] = await db.update(primaryTransitions).set({ ownerToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), attempts: sql`${primaryTransitions.attempts} + 1` })
      .where(and(eq(primaryTransitions.id, pending.id), or(isNull(primaryTransitions.leaseUntil), lte(primaryTransitions.leaseUntil, new Date())),
        opts.force ? undefined : eligible(new Date()))).returning();
    if (!claimed) continue;
    const entry = claimed;
    const features = { batchReadiness: false, retirementGrace: false };
    const lease = primaryLease(db, claimed, token, features);
    try {
      const check = async () => { if (opts.signal?.aborted) throw new Error('Recovery stopped; generations retained'); await lease.check(); };
      await check();
      Object.assign(features, await requireCapabilities(db, entry.serverId, [entry.previous, entry.candidate].some(g => g?.healthCheck === 'http-strict' || g?.healthCheck === 'tcp')));
      let svc = await lease.current();
      const observedService = fingerprint(svc);
      const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, entry.deploymentId) });
      if (!dep || dep.serviceId !== entry.serviceId) throw new Error('Deployment history unavailable; review retained generations');
      await lease.captureIdentities();
      if (entry.orderedOwner) await handoffNodeDeploymentPreparation(db, entry.orderedOwner, token, false);
      endCanary(entry.serviceId);
      const interruptedActive = entry.interrupted && (ACTIVE as readonly string[]).includes(dep.status);
      let selected = svc.runtimeId === entry.candidate.runtimeId ? lease.row.candidate : lease.row.previous;
      const view = (group: PrimaryRuntimeSnapshot) => {
        if (group.runtimeId !== svc.runtimeId) return group;
        if ((svc.runtimeReplicas ?? 1) !== group.replicas) throw new Error('Serving replica ownership changed; review required');
        return { ...group, port: svc.port, healthPath: svc.healthPath ?? '/', healthCheck: svc.healthCheck };
      };
      if (entry.phase === 'retiring') {
        if (svc.runtimeId !== entry.desiredRuntimeId) throw new Error('Committed serving generation changed; retained for review');
        if (svc.status !== 'stopped' && (!selected || !await healthy(db, lease.row, view(selected)))) throw new Error('Committed generation is not healthy; obsolete runtimes retained');
      } else if (svc.status !== 'stopped') {
        if (interruptedActive && entry.desiredRuntimeId === entry.candidate.runtimeId) selected = lease.row.candidate;
        if (!selected && !lease.row.previous && interruptedActive) selected = lease.row.candidate;
        if (dep.status === 'cancelled' && lease.row.previous && await healthy(db, lease.row, view(lease.row.previous))) selected = lease.row.previous;
        if (!selected || !await healthy(db, lease.row, view(selected))) {
          if (interruptedActive && lease.row.previous && selected?.runtimeId === entry.candidate.runtimeId && await healthy(db, lease.row, view(lease.row.previous))) selected = lease.row.previous;
          else throw new Error('No confirmed healthy generation; runtimes retained');
        }
      }
      await check(); svc = await lease.current();
      if (fingerprint(svc) !== observedService) throw new Error('Service changed during readiness checks');
      if (svc.status !== 'stopped' && selected) {
        const before = svc.runtimeId;
        const changed = await db.update(services).set({ status: 'running', ...(before !== selected.runtimeId ? { runtimeId: selected.runtimeId, port: selected.port,
          commitSha: selected.commitSha, runtimeReplicas: selected.replicas, asleepAt: null } : {}),
        }).where(and(eq(services.id, entry.serviceId), before == null ? isNull(services.runtimeId) : eq(services.runtimeId, before), sameHost(services.serverId, entry.serverId), eq(services.status, svc.status), lease.fence(),
          exists(db.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.id, dep.id), eq(deployments.status, dep.status)))),
        )).returning();
        if (!changed.length) throw new Error('Service changed during recovery');
        svc = changed[0]!;
      }
      const desired = svc.runtimeId;
      let settledStatus: string | undefined;
      const stillCurrent = async () => {
        await check(); const current = await lease.current();
        if (current.runtimeId !== desired || current.status !== svc.status || current.port !== svc.port || current.runtimeReplicas !== svc.runtimeReplicas) throw new Error('Service changed during recovery');
        const job = await db.query.deployments.findFirst({ where: eq(deployments.id, dep.id) });
        if (job?.status !== (settledStatus ?? dep.status)) throw new Error('Deployment changed during recovery; generations retained');
        return current;
      };
      await lease.confirm(); await stillCurrent();
      if (interruptedActive) {
        const successful = desired === entry.candidate.runtimeId && svc.status !== 'stopped';
        const result = await db.update(deployments).set({ status: successful ? 'running' : svc.status === 'stopped' ? 'cancelled' : 'failed', finishedAt: new Date(),
          ...(successful ? { imageDigest: entry.imageDigest, ...(entry.finalizeSnapshot != null ? { configSnapshot: entry.finalizeSnapshot } : {}) } : {}),
        }).where(and(eq(deployments.id, entry.deploymentId), inArray(deployments.status, [...ACTIVE]), lease.fence())).returning();
        if (!result.length) throw new Error('Deployment was cancelled or changed during recovery; retained');
        settledStatus = result[0]!.status;
        if (successful) await db.update(deployments).set({ status: 'superseded' }).where(and(eq(deployments.serviceId, entry.serviceId), eq(deployments.status, 'running'), ne(deployments.id, entry.deploymentId)));
        const action = successful ? 'deploy.success' : svc.status === 'stopped' ? 'deploy.cancelled' : 'deploy.failed';
        await audit(db, svc.ownerUserId ?? null, action, `${svc.name} #${entry.deploymentId}`, { serviceId: svc.id, recoveredAfterRestart: true }).catch(() => {});
      }
      await sleep(2000); await stillCurrent();
      await lease.patch({ phase: 'retiring', desiredRuntimeId: desired });
      for (const group of [lease.row.previous, lease.row.candidate]) {
        if (!group || group.runtimeId === desired) continue;
        await stillCurrent(); await lease.retire(group.runtimeId);
      }
      await stillCurrent();
      if (!await lease.completeIfSafe()) throw new Error('Obsolete runtime cleanup remains pending');
      recovered++;
      logBus.publish(entry.deploymentId, `Primary recovery confirmed ${desired ?? 'no serving runtime'}; obsolete generations removed`);
      logBus.publish(entry.deploymentId, 'Recovery does not re-run lifecycle hooks, canary observation or additional-node fan-out; inspect per-target state before another rollout');
      logBus.end(entry.deploymentId);
      await audit(db, null, 'service.primary_recovered', `service #${entry.serviceId}`, { serviceId: entry.serviceId, deploymentId: entry.deploymentId }).catch(() => {});
    } catch (err) {
      held++; const reason = err instanceof Error ? err.message : 'Primary recovery unavailable';
      opts.log?.(`primary recovery service #${entry.serviceId}: ${reason}`); await lease.release(reason);
    } finally { await lease.release(); }
  }
  return { recovered, held };
}
