import { randomUUID } from 'node:crypto';
import { and, eq, exists, gt, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { deployments, services, swarmTransitions, type DB, type Service, type SwarmTransition } from '@ninedeploy/db';
import { z } from 'zod';
import { encrypt, decrypt } from '../lib/crypto.js';
import { dockerEngineRequest } from '../lib/dockerEngineApi.js';
import { localSwarmInfo, RE_SWARM_NODE_ID } from '../lib/swarm.js';
import { sleep } from '../lib/exec.js';
import { audit } from '../lib/audit.js';
import type { StackSpec } from '../kernel/types.js';
import { managedSwarmServiceSpec, swarmSpecFingerprint, type ManagedSwarmSpec } from './swarmServiceSpec.js';
import { verifySwarmTaskImages } from './swarmArtifact.js';
import { writeDynamicConfig } from './proxy.js';
import { logBus } from './logs.js';
import type { Builder, DeployRuntime } from './types.js';
import { capturePreviousDocker, previousDockerHealthy, previousDockerRetired, previousDockerSchema, retirePreviousDocker } from './previousDocker.js';

const LEASE_MS = 90_000;
const EPOCH = 'ninedeploy.recovery.epoch';
const NONCE = 'ninedeploy.transition';
const ACTIVE = ['building', 'deploying'] as const;
const CONFIG_KEYS = ['slug', 'type', 'orchestrator', 'serverId', 'repoUrl', 'image', 'replicas', 'healthPath', 'healthCheck', 'healthCommand', 'healthTimeoutSeconds', 'cpuLimitMilli', 'memLimitMb', 'cmd', 'dockerLabels'] as const;
const specSchema = z.record(z.string(), z.unknown());
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const snapshotSchema = z.object({
  spec: specSchema, imageId: imageId.nullable(), knownImageIds: z.array(imageId).max(10),
  port: z.number().int().min(1).max(65535).nullable(), healthPath: z.string(), healthCheck: z.string().nullable(),
  commitSha: z.string().nullable(), deploymentId: z.number().int().positive(), epochs: z.array(z.string().nullable()).max(32),
});
const payloadSchema = z.object({
  version: z.literal(1), nonce: z.string().uuid(), nativeId: z.string().regex(/^[a-z0-9]{25}$/).nullable(),
  config: z.record(z.string(), z.unknown()), dbPort: z.number().nullable(), dbRuntimeId: z.string().nullable(),
  candidate: snapshotSchema, previous: snapshotSchema.nullable(), previousDocker: previousDockerSchema.optional(), selected: z.enum(['candidate', 'previous', 'stopped']),
  registryAuth: z.object({ username: z.string(), password: z.string(), server: z.string().optional() }).optional(),
});
type Payload = z.infer<typeof payloadSchema>;
type Snapshot = Payload['candidate'];
type NativeService = { ID: string; Version: { Index: number }; Spec: ManagedSwarmSpec; PreviousSpec?: ManagedSwarmSpec; UpdateStatus?: { State?: string } };
class SwarmDeploymentUnhealthy extends Error { constructor() { super('The owned Swarm candidate did not pass readiness; restore its known previous spec'); } }
export class SwarmRecoveryPending extends Error { constructor(message = 'Swarm runtime recovery is pending; the service is retained for review') { super(message); } }
export class SwarmRecoveryOwnershipLost extends Error { constructor() { super('Swarm recovery ownership changed; native service retained'); } }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function labels(spec: ManagedSwarmSpec): Record<string, unknown> { return record(spec.Labels); }
function specImage(spec: ManagedSwarmSpec): string { const value = record(record(spec.TaskTemplate).ContainerSpec).Image; if (typeof value !== 'string') throw new SwarmRecoveryPending('Swarm image reference is unconfirmed'); return value; }
function replicas(spec: ManagedSwarmSpec): number { const n = record(record(spec.Mode).Replicated).Replicas; if (!Number.isInteger(n) || Number(n) < 0 || Number(n) > 10) throw new SwarmRecoveryPending('Swarm replica shape is unconfirmed'); return Number(n); }
function baseHash(spec: ManagedSwarmSpec) { const values = { ...labels(spec) }; delete values[EPOCH]; return swarmSpecFingerprint({ ...spec, Labels: values }); }
function withEpoch(spec: ManagedSwarmSpec, epoch: string): ManagedSwarmSpec { return { ...spec, Labels: { ...labels(spec), [EPOCH]: epoch } }; }
function reservation(spec: ManagedSwarmSpec): ManagedSwarmSpec { return { ...spec, Mode: { Replicated: { Replicas: 0 } } }; }
function decode(row: SwarmTransition): Payload { try { return payloadSchema.parse(JSON.parse(decrypt(row.payloadEncrypted))); } catch { throw new SwarmRecoveryPending('Swarm recovery journal cannot be read; review required'); } }
function configOf(service: Service) { return Object.fromEntries(CONFIG_KEYS.map(key => [key, service[key] ?? null])); }
function configFence(value: Payload): SQL | undefined {
  return and(...CONFIG_KEYS.map(key => value.config[key] == null ? isNull(services[key]) : sql`${services[key]} = ${typeof value.config[key] === 'object' ? JSON.stringify(value.config[key]) : value.config[key]}`),
    or(value.dbPort == null ? isNull(services.port) : eq(services.port, value.dbPort), value.candidate.port == null ? isNull(services.port) : eq(services.port, value.candidate.port), value.previous?.port != null ? eq(services.port, value.previous.port) : isNull(services.port)),
    or(value.dbRuntimeId == null ? isNull(services.runtimeId) : eq(services.runtimeId, value.dbRuntimeId), eq(services.runtimeId, String(value.candidate.spec.Name)), and(isNull(services.runtimeId), inArray(services.status, ['stopped', 'idle', 'error']))));
}
async function nativeService(name: string): Promise<NativeService | null> {
  const result = await dockerEngineRequest('GET', `/services/${name}`);
  if (result.status === 404) return null;
  const value = result.body as NativeService;
  if (result.status !== 200 || !value || !RE_SWARM_NODE_ID.test(value.ID) || !Number.isSafeInteger(value.Version?.Index) || value.Version.Index < 0 || typeof value.Spec?.Name !== 'string') throw new SwarmRecoveryPending('Native Swarm service state is unconfirmed');
  return value;
}
function matches(current: NativeService, group: Snapshot, zero = false) {
  return baseHash(current.Spec) === baseHash(zero ? reservation(group.spec) : group.spec) && group.epochs.includes(typeof labels(current.Spec)[EPOCH] === 'string' ? labels(current.Spec)[EPOCH] as string : null);
}

function lease(db: DB, initial: SwarmTransition, token: string, signal?: AbortSignal) {
  const row = { ...initial }; let payload = decode(row), lost = false, closed = false, confirmed = false;
  let renewal: Promise<unknown> | undefined;
  const held = () => and(eq(swarmTransitions.id, row.id), eq(swarmTransitions.ownerToken, token), gt(swarmTransitions.leaseUntil, new Date()));
  const noNewer = () => sql`NOT EXISTS (SELECT 1 FROM deployments AS newer WHERE newer.service_id = ${row.serviceId} AND newer.id > ${row.deploymentId} AND newer.status IN ('building','deploying','running'))`;
  const fence = () => and(exists(db.select({ id: swarmTransitions.id }).from(swarmTransitions).where(held())), noNewer(), exists(db.select({ id: services.id }).from(services).where(and(eq(services.id, row.serviceId), configFence(payload)))))!;
  const patch = async (values: Partial<typeof swarmTransitions.$inferInsert>, savePayload = false) => {
    const update = { ...values, ...(savePayload ? { payloadEncrypted: encrypt(JSON.stringify(payload)) } : {}), updatedAt: new Date() };
    const changed = await db.update(swarmTransitions).set(update).where(held()).returning({ id: swarmTransitions.id });
    if (!changed.length) { lost = true; throw new SwarmRecoveryOwnershipLost(); }
    Object.assign(row, update);
  };
  const check = async () => {
    if (signal?.aborted) throw new SwarmRecoveryPending('Swarm recovery shutdown requested; service retained');
    if (closed || lost || !(await db.select({ id: swarmTransitions.id }).from(swarmTransitions).where(held()).limit(1)).length) { lost = true; throw new SwarmRecoveryOwnershipLost(); }
    if (!(await db.select({ id: services.id }).from(services).where(and(eq(services.id, row.serviceId), fence())).limit(1)).length) throw new SwarmRecoveryPending('Service configuration, placement or a newer deployment changed; retained for review');
    const info = await localSwarmInfo();
    if (!info.controlAvailable || info.nodeId !== row.managerNodeId) throw new SwarmRecoveryPending('Swarm manager identity changed or is unavailable');
  };
  const timer = setInterval(() => { if (closed || renewal) return; renewal = patch({ leaseUntil: new Date(Date.now() + LEASE_MS) }).catch(() => { lost = true; }).finally(() => { renewal = undefined; }); }, 15_000); timer.unref();
  const context = async () => {
    await check();
    const service = await db.query.services.findFirst({ where: eq(services.id, row.serviceId) });
    const deployment = await db.query.deployments.findFirst({ where: eq(deployments.id, row.deploymentId) });
    if (!service || !deployment || deployment.serviceId !== service.id) throw new SwarmRecoveryPending('Swarm deployment history is unavailable');
    if (!['building', 'deploying', 'running', 'cancelled', 'failed'].includes(deployment.status)) throw new SwarmRecoveryPending('Swarm deployment history changed; retained for review');
    return { service, deployment };
  };
  const currentOwned = async () => {
    await check(); const current = await nativeService(row.runtimeId);
    if (!current) return null;
    if (payload.nativeId && current.ID !== payload.nativeId || labels(current.Spec)['ninedeploy.service'] !== String(row.serviceId)) throw new SwarmRecoveryPending('Native Swarm service identity changed; retained for review');
    const stoppedPrevious = payload.previous && matches(current, payload.previous, true) && (await context()).service.status === 'stopped';
    if (!matches(current, payload.candidate) && !matches(current, payload.candidate, true) && !(payload.previous && matches(current, payload.previous)) && !stoppedPrevious) throw new SwarmRecoveryPending('Native Swarm spec or recovery owner changed; retained for review');
    return current;
  };
  const update = async (current: NativeService, spec: ManagedSwarmSpec, candidateAuth = false) => {
    await check();
    const changedRegistryRef = specImage(current.Spec) !== specImage(spec);
    const auth = candidateAuth && payload.registryAuth ? payload.registryAuth : changedRegistryRef ? { username: '', password: '', server: '' } : undefined;
    const result = await dockerEngineRequest('POST', `/services/${current.ID}/update?version=${current.Version.Index}`, spec, auth);
    if (result.status !== 200) throw new SwarmRecoveryPending('Swarm revision update was not confirmed; no newer revision will be overwritten');
    await check();
  };
  const createReservation = async () => {
    const { service, deployment } = await context();
    if (service.status === 'stopped' || deployment.status === 'cancelled') return null;
    if (payload.previous) throw new SwarmRecoveryPending('The previous native Swarm service is missing; no replacement is adopted');
    await check();
    const result = await dockerEngineRequest('POST', '/services/create', reservation(payload.candidate.spec), payload.registryAuth);
    if (result.status !== 201) throw new SwarmRecoveryPending('Swarm reservation creation was not confirmed; review the service before retrying');
    const id = record(result.body).ID;
    if (typeof id !== 'string' || !RE_SWARM_NODE_ID.test(id)) throw new SwarmRecoveryPending('Swarm reservation identity is unconfirmed');
    payload.nativeId = id; await patch({}, true);
    const current = await currentOwned(); if (!current || current.ID !== id) throw new SwarmRecoveryPending(); return current;
  };
  const fenceNative = async () => {
    let current = await currentOwned();
    if (!current) current = await createReservation();
    if (!current) return null;
    const group = matches(current, payload.candidate) || matches(current, payload.candidate, true) ? payload.candidate : payload.previous!;
    const epoch = randomUUID();
    if (group.epochs.length >= 32) throw new SwarmRecoveryPending('Too many unconfirmed Swarm owner epochs; operator review required');
    group.epochs.push(epoch); await patch({}, true);
    await update(current, withEpoch(current.Spec, epoch));
    const observed = await currentOwned();
    if (!observed || labels(observed.Spec)[EPOCH] !== epoch) throw new SwarmRecoveryPending('Swarm owner fence is unconfirmed');
    group.spec = withEpoch(group.spec, epoch); group.epochs = [epoch];
    payload.nativeId = observed.ID; await patch({}, true);
    return observed;
  };
  const submit = async (observed?: NativeService) => {
    const { service, deployment } = await context();
    if (service.status === 'stopped' || !ACTIVE.includes(deployment.status as typeof ACTIVE[number])) throw new SwarmRecoveryPending('Deployment was stopped or cancelled before Swarm submission');
    let current = observed ?? await currentOwned();
    if (!current) current = await createReservation();
    if (!current) throw new SwarmRecoveryPending();
    if (!matches(current, payload.candidate)) {
      const epoch = randomUUID(); payload.candidate.spec = withEpoch(payload.candidate.spec, epoch); payload.candidate.epochs.push(epoch);
      await patch({ phase: 'submitted' }, true);
      await update(current, payload.candidate.spec, true);
      const applied = await currentOwned();
      if (!applied || !matches(applied, payload.candidate) || labels(applied.Spec)[EPOCH] !== epoch) throw new SwarmRecoveryPending('Swarm candidate apply is unconfirmed');
      payload.candidate.epochs = [epoch]; await patch({}, true);
    }
    await patch({ phase: 'submitted' });
  };
  const ready = async (group = payload.candidate) => {
    const ctx = await context(), deadline = Date.now() + (ctx.service.healthTimeoutSeconds ?? 300) * 1000;
    for (;;) {
      const current = await currentOwned();
      if (!current || !matches(current, group) || replicas(current.Spec) !== replicas(group.spec)) throw new SwarmRecoveryPending('Selected Swarm spec has not converged');
      const state = current.UpdateStatus?.State;
      if (state === 'paused' || state === 'rollback_paused') throw new SwarmDeploymentUnhealthy();
      if (!replicas(group.spec)) return;
      if (state === 'updating' || state === 'rollback_started') {
        if (Date.now() >= deadline) throw new SwarmRecoveryPending('Native Swarm update has not settled');
        await sleep(500); continue;
      }
      let ids: string[];
      try {
        ids = await verifySwarmTaskImages(db, { runtimeId: row.runtimeId, imageRef: specImage(group.spec), imageId: group.imageId, replicas: replicas(group.spec), serviceId: row.serviceId,
          deploymentId: group.deploymentId, panelNodeId: row.managerNodeId, nativeServiceId: current.ID, knownImageIds: group.knownImageIds, freshHealth: true,
          requireHealthy: !!record(record(group.spec.TaskTemplate).ContainerSpec).Healthcheck });
      } catch {
        if (Date.now() >= deadline) throw new SwarmRecoveryPending('Swarm task health or image identity is unconfirmed');
        await sleep(500); continue;
      }
      const { swarmHealthy } = await import('./swarmDeploy.js');
      const runtime: DeployRuntime = { runtimeId: row.runtimeId, port: group.port, healthPath: group.healthPath, ...(group.healthCheck === 'command' ? { healthCheck: 'command' } : {}) };
      if (await swarmHealthy(runtime, Math.min(10_000, Math.max(1, deadline - Date.now())), () => undefined)) {
        group.knownImageIds = ids; await patch({}, true); await check(); return;
      }
      if (Date.now() >= deadline) throw new SwarmDeploymentUnhealthy();
      await sleep(500);
    }
  };
  const confirm = async () => {
    await ready(); await check();
    const { service, deployment } = await context();
    if (service.status === 'stopped' || !['building', 'deploying', 'running'].includes(deployment.status)) throw new SwarmRecoveryPending('Stop or cancellation won before Swarm routing confirmation');
    await writeDynamicConfig(db, { confirmServiceId: row.serviceId }); await check(); await ready(); confirmed = true;
  };
  const completeIfSafe = async () => {
    if (closed) return false;
    await check(); const { service, deployment } = await context();
    if (!confirmed || deployment.status !== 'running' || service.status !== 'running' || service.runtimeId !== row.runtimeId) return false;
    await ready(); await check();
    if (payload.previousDocker) {
      await sleep(2000); await ready(); await check();
      await retirePreviousDocker(db, payload.previousDocker, check);
      if (!await previousDockerRetired(payload.previousDocker)) return false;
    }
    clearInterval(timer); await renewal; await check();
    const removed = await db.delete(swarmTransitions).where(and(held(), fence())).returning({ id: swarmTransitions.id });
    if (!removed.length) throw new SwarmRecoveryOwnershipLost(); closed = true; clearInterval(timer); return true;
  };
  const finishSelected = async () => {
    const ctx = await context();
    const stopped = ctx.service.status === 'stopped', cancelled = ctx.deployment.status === 'cancelled';
    if (stopped) payload.selected = 'stopped'; else if (cancelled || ctx.deployment.status === 'failed') payload.selected = 'previous';
    const observed = await currentOwned();
    if (payload.selected === 'candidate' && observed && payload.previous && matches(observed, payload.previous) && observed.PreviousSpec && baseHash(observed.PreviousSpec) === baseHash(payload.candidate.spec)) payload.selected = 'previous';
    await patch({}, true);
    const current = await fenceNative();
    if (!current && (stopped || cancelled) && !payload.previousDocker) {
      await db.update(deployments).set({ status: 'cancelled', finishedAt: new Date() }).where(and(eq(deployments.id, row.deploymentId), inArray(deployments.status, [...ACTIVE]), fence()));
      clearInterval(timer); await renewal; await check();
      const removed = await db.delete(swarmTransitions).where(and(held(), fence())).returning({ id: swarmTransitions.id });
      if (!removed.length) throw new SwarmRecoveryOwnershipLost(); closed = true; clearInterval(timer); return;
    }
    if (!current && !(payload.previousDocker && (stopped || cancelled))) throw new SwarmRecoveryPending();
    if (current && payload.selected === 'candidate') {
      try { if (!matches(current, payload.candidate)) await submit(current); await ready(); }
      catch (error) { if (!(error instanceof SwarmDeploymentUnhealthy)) throw error; payload.selected = 'previous'; await patch({}, true); await finishSelected(); return; }
    } else if (current) {
      const group = payload.selected === 'previous' && payload.previous ? payload.previous : payload.candidate;
      const target = payload.selected === 'previous' && payload.previous ? group.spec : reservation(group.spec);
      const epoch = randomUUID(); group.epochs.push(epoch); group.spec = withEpoch(group.spec, epoch); await patch({}, true);
      await update(current, withEpoch(target, epoch));
      if (payload.selected === 'previous' && payload.previous) await ready(payload.previous);
    }
    await check();
    const fresh = await context(); const success = payload.selected === 'candidate' && fresh.service.status !== 'stopped' && fresh.deployment.status !== 'cancelled';
    const selected = success ? payload.candidate : payload.previous;
    const selectedDocker = !success && fresh.service.status !== 'stopped' ? payload.previousDocker : undefined;
    if (selectedDocker && !await previousDockerHealthy(selectedDocker)) throw new SwarmRecoveryPending('Previous Docker readiness is unconfirmed; both generations retained');
    const desiredStatus = fresh.service.status === 'stopped' ? 'stopped' : selectedDocker || selected && replicas(selected.spec) > 0 ? 'running' : 'error';
    const previousDeployment = payload.previousDocker?.deploymentId ?? payload.previous?.deploymentId;
    const updated = await db.update(services).set({ status: desiredStatus, runtimeId: selectedDocker ? selectedDocker.runtimeId : desiredStatus !== 'stopped' && selected && replicas(selected.spec) > 0 ? row.runtimeId : null,
      runtimeReplicas: selectedDocker ? selectedDocker.replicas : desiredStatus !== 'stopped' && selected && replicas(selected.spec) > 0 ? 1 : 0,
      ...(selectedDocker ? { port: selectedDocker.port, commitSha: selectedDocker.commitSha } : desiredStatus !== 'stopped' && selected ? { port: selected.port, commitSha: selected.commitSha } : {}) })
      .where(and(eq(services.id, row.serviceId), eq(services.status, fresh.service.status), fence())).returning({ id: services.id });
    if (!updated.length) throw new SwarmRecoveryPending('Service state changed during Swarm recovery');
    await writeDynamicConfig(db, { confirmServiceId: row.serviceId }); await check();
    if (payload.previousDocker && !selectedDocker) {
      await sleep(2000); await check();
      if (success) await ready();
      await retirePreviousDocker(db, payload.previousDocker, check);
      if (!await previousDockerRetired(payload.previousDocker)) throw new SwarmRecoveryPending('Previous Docker cleanup is unconfirmed');
    }
    const outcome = success || fresh.service.status === 'stopped' && fresh.deployment.status === 'running' ? 'running' : fresh.service.status === 'stopped' || cancelled ? 'cancelled' : 'failed';
    const done = await db.update(deployments).set({ status: outcome, finishedAt: fresh.deployment.status === outcome && fresh.deployment.finishedAt ? fresh.deployment.finishedAt : new Date(), ...(success ? { imageDigest: payload.candidate.imageId ?? specImage(payload.candidate.spec), ...(row.finalizeSnapshot ? { configSnapshot: row.finalizeSnapshot } : {}) } : {}) })
      .where(and(eq(deployments.id, row.deploymentId), eq(deployments.status, fresh.deployment.status), success ? inArray(deployments.status, [...ACTIVE, 'running']) : inArray(deployments.status, [...ACTIVE, 'running', 'cancelled', 'failed']),
        success ? exists(db.select({ id: services.id }).from(services).where(and(eq(services.id, row.serviceId), eq(services.status, 'running'), eq(services.runtimeId, row.runtimeId)))) : undefined, fence())).returning({ id: deployments.id });
    if (!done.length) throw new SwarmRecoveryPending('Deployment state changed during Swarm recovery');
    if (success) await db.update(deployments).set({ status: 'superseded' }).where(and(eq(deployments.serviceId, row.serviceId), eq(deployments.status, 'running'), ne(deployments.id, row.deploymentId), fence()));
    else if (previousDeployment != null && desiredStatus === 'running') await db.update(deployments).set({ status: 'running' }).where(and(eq(deployments.id, previousDeployment), fence()));
    clearInterval(timer); await renewal; await check();
    const removed = await db.delete(swarmTransitions).where(and(held(), fence())).returning({ id: swarmTransitions.id });
    if (!removed.length) throw new SwarmRecoveryOwnershipLost(); closed = true; clearInterval(timer);
    logBus.publish(row.deploymentId, `Swarm recovery confirmed service ${desiredStatus}, deployment ${outcome}; no checkout, build or lifecycle hooks were replayed`);
    if (success) logBus.publish(row.deploymentId, '✓ Deployment successful (recovered Swarm update)');
    await audit(db, fresh.service.ownerUserId ?? null, success ? 'deploy.success' : outcome === 'cancelled' ? 'deploy.cancelled' : 'deploy.failed', `${fresh.service.name} #${row.deploymentId}`,
      { serviceId: row.serviceId, deploymentId: row.deploymentId, recoveredAfterRestart: row.interrupted }).catch(() => undefined);
    logBus.end(row.deploymentId);
  };
  return {
    row, payload, check, fence, lost: () => lost, submit, ready, confirm, completeIfSafe,
    async intentCandidate(snapshot?: string) { await check(); await patch({ phase: 'routing', finalizeSnapshot: snapshot ?? row.finalizeSnapshot }); },
    async fail(cancelled = false) { payload.selected = 'previous'; if (cancelled) await db.update(deployments).set({ status: 'cancelled', finishedAt: new Date() }).where(and(eq(deployments.id, row.deploymentId), inArray(deployments.status, [...ACTIVE]), fence())); await patch({ interrupted: true }, true); await finishSelected(); },
    async recover() { await finishSelected(); },
    wrap(builder: Builder): Builder { return { ...builder,
      isHealthy: (runtime, ...args) => runtime.runtimeId === payload.previousDocker?.runtimeId ? previousDockerHealthy(payload.previousDocker) : builder.isHealthy(runtime, ...args),
      async stop(name, opts) {
        if (name === row.runtimeId) throw new SwarmRecoveryPending('Native Swarm retirement requires journalled recovery');
        if (name !== payload.previousDocker?.runtimeId) return builder.stop(name, opts);
        const ctx = await context();
        if (!confirmed || ctx.service.status !== 'running' || ctx.service.runtimeId !== row.runtimeId || ctx.deployment.status !== 'running') throw new SwarmRecoveryPending('Swarm cutover is unconfirmed; previous Docker retained');
        await ready(); await check();
        await retirePreviousDocker(db, payload.previousDocker, check, opts?.graceSeconds);
      },
    }; },
    async release(reason?: string) {
      clearInterval(timer); await renewal;
      if (closed || lost) return;
      await db.update(swarmTransitions).set({ ownerToken: null, leaseUntil: null, interrupted: true, phase: reason ? 'retained' : row.phase,
        ...(reason ? { reason, nextAttemptAt: new Date(Date.now() + 60_000) } : {}), updatedAt: new Date() }).where(and(eq(swarmTransitions.id, row.id), eq(swarmTransitions.ownerToken, token)));
      closed = true;
    },
  };
}
export type SwarmRecoveryLease = ReturnType<typeof lease>;

export async function beginSwarmTransition(db: DB, service: Service, deploymentId: number, stack: StackSpec, runtime: DeployRuntime, commitSha: string, registryAuth?: Payload['registryAuth'], initialSnapshot?: string) {
  const info = await localSwarmInfo();
  if (!info.controlAvailable || !info.nodeId) throw new SwarmRecoveryPending('Swarm manager identity is unconfirmed');
  const previousDocker = service.runtimeId && service.runtimeId !== runtime.runtimeId ? await capturePreviousDocker(db, service) : undefined;
  const token = randomUUID(), nonce = randomUUID();
  const spec = await managedSwarmServiceSpec(stack); spec.Labels = { ...labels(spec), [NONCE]: nonce, [EPOCH]: token };
  const current = await nativeService(runtime.runtimeId);
  let previous: Snapshot | null = null;
  if (current) {
    if (labels(current.Spec)['ninedeploy.managed'] !== 'service' || labels(current.Spec)['ninedeploy.service'] !== String(service.id) || current.Spec.Name !== runtime.runtimeId) throw new SwarmRecoveryPending('An unowned Swarm service exists; no update submitted');
    const priorId = Number(labels(current.Spec)['ninedeploy.deployment']);
    if (!Number.isSafeInteger(priorId) || priorId <= 0) throw new SwarmRecoveryPending('Previous Swarm deployment ownership is unconfirmed');
    const prior = await db.query.deployments.findFirst({ where: eq(deployments.id, priorId) });
    let priorPort = service.port;
    try { const snap = JSON.parse(prior?.configSnapshot ?? '{}'); if (Number.isInteger(snap.port)) priorPort = snap.port; } catch { /* current port is validated again by readiness */ }
    if (replicas(current.Spec) > 0 && priorPort !== runtime.port) throw new SwarmRecoveryPending('Stop the active Swarm service before changing its routed container port');
    previous = { spec: current.Spec, imageId: prior?.imageDigest?.match(/^sha256:[a-f0-9]{64}$/) ? prior.imageDigest : null, knownImageIds: [], port: priorPort,
      healthPath: service.healthPath, healthCheck: record(record(current.Spec.TaskTemplate).ContainerSpec).Healthcheck ? 'command' : null,
      commitSha: service.commitSha, deploymentId: priorId, epochs: [typeof labels(current.Spec)[EPOCH] === 'string' ? labels(current.Spec)[EPOCH] as string : null] };
    if (replicas(current.Spec)) previous.knownImageIds = await verifySwarmTaskImages(db, { runtimeId: runtime.runtimeId, imageRef: specImage(current.Spec), imageId: previous.imageId, replicas: replicas(current.Spec), serviceId: service.id, deploymentId: priorId, panelNodeId: info.nodeId, nativeServiceId: current.ID });
  }
  const payload: Payload = { version: 1, nonce, nativeId: current?.ID ?? null, config: configOf(service), dbPort: service.port, dbRuntimeId: service.runtimeId,
    previous, ...(previousDocker ? { previousDocker } : {}), selected: 'candidate', candidate: { spec, imageId: runtime.imageDigest?.match(/^sha256:[a-f0-9]{64}$/) ? runtime.imageDigest : null, knownImageIds: [], port: runtime.port, healthPath: runtime.healthPath,
      healthCheck: runtime.healthCheck ?? null, commitSha, deploymentId, epochs: [token] }, ...(registryAuth ? { registryAuth } : {}) };
  const [row] = await db.insert(swarmTransitions).values({ serviceId: service.id, deploymentId, managerNodeId: info.nodeId, runtimeId: runtime.runtimeId,
    payloadEncrypted: encrypt(JSON.stringify(payload)), finalizeSnapshot: initialSnapshot ?? JSON.stringify({ port: runtime.port }), ownerToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) }).onConflictDoNothing().returning();
  if (!row) throw new SwarmRecoveryPending();
  return lease(db, row, token);
}

export async function swarmRecoveryPending(db: DB, serviceId: number) { return (await db.select({ id: swarmTransitions.id }).from(swarmTransitions).where(eq(swarmTransitions.serviceId, serviceId))).length > 0; }
export async function listSwarmRecovery(db: DB, serviceId: number) {
  const [row] = await db.select().from(swarmTransitions).where(eq(swarmTransitions.serviceId, serviceId)).limit(1);
  return row ? { id: row.id, deploymentId: row.deploymentId, phase: row.phase, interrupted: row.interrupted, reason: row.reason, busy: row.leaseUntil != null && row.leaseUntil.getTime() > Date.now(), attempts: row.attempts, nextAttemptAt: row.nextAttemptAt.toISOString(), updatedAt: row.updatedAt.toISOString() } : null;
}
export async function reconcileSwarmTransitions(db: DB, opts: { serviceId?: number; force?: boolean; signal?: AbortSignal; log?: (line: string) => void } = {}) {
  const now = new Date(), rows = await db.select().from(swarmTransitions).where(and(or(isNull(swarmTransitions.leaseUntil), lte(swarmTransitions.leaseUntil, now)), opts.force ? undefined : lte(swarmTransitions.nextAttemptAt, now), opts.serviceId == null ? undefined : eq(swarmTransitions.serviceId, opts.serviceId))).limit(10);
  let recovered = 0, held = 0;
  for (const row of rows) {
    if (opts.signal?.aborted) break;
    const token = randomUUID();
    const [claimed] = await db.update(swarmTransitions).set({ ownerToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), attempts: sql`${swarmTransitions.attempts} + 1` }).where(and(eq(swarmTransitions.id, row.id), or(isNull(swarmTransitions.leaseUntil), lte(swarmTransitions.leaseUntil, now)))).returning();
    if (!claimed) continue;
    let controller: SwarmRecoveryLease | undefined;
    try { controller = lease(db, claimed, token, opts.signal); await controller.recover(); recovered++; }
    catch (error) {
      held++; const reason = error instanceof SwarmRecoveryPending || error instanceof SwarmRecoveryOwnershipLost ? error.message : 'Swarm recovery could not be confirmed; service retained for review';
      opts.log?.(`Swarm recovery #${row.deploymentId}: ${reason}`);
      if (controller) await controller.release(reason);
      else await db.update(swarmTransitions).set({ ownerToken: null, leaseUntil: null, interrupted: true, reason, nextAttemptAt: new Date(Date.now() + 60_000), updatedAt: new Date() }).where(and(eq(swarmTransitions.id, row.id), eq(swarmTransitions.ownerToken, token)));
    }
    finally { await controller?.release(); }
  }
  return { recovered, held };
}
