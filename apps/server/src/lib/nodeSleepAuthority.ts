import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { databaseAttachments, databases, deployments, domains, fanoutTransitions, nodeAutoscaleCapacity, nodeAutoscaleTransitions, nodeDeploymentPreparations,
  nodeLifecycleIntents, nodeSleepTransitions, primaryTransitions, serviceTargets, services, type DB, type NodeProxyWriteHead, type NodeSleepTransition, type Service, type ServiceRuntimeOwner } from '@ninedeploy/db';
import { containerStartSetReply, containerStopSetReply, SLEEP_AFTER_MAX, SLEEP_AFTER_MIN } from '@ninedeploy/schemas';
import { canaryActive } from '../engine/canaryState.js';
import { replicaNames } from '../engine/dockerNames.js';
import { spendNodeIdleEvidence, type NodeIdleEvidence } from './nodeIdleCoverage.js';
import { nodeServingTrafficContext, readNodeServingTrafficState } from './nodeServingTrafficContext.js';
import { readServiceRuntimeOwner, reserveServiceRuntimeOwnerInTransaction, sameRuntimeOwner, serviceRuntimeRevision } from './serviceRuntimeOwner.js';
import { registerNodeWakeRoutePromotion } from './nodeWakeRoutePromotion.js';
import { nodeWakeMaintenancePending } from './nodeWakeMaintenanceBlock.js';
import { validNodeCatcherName, type CatcherIdentity } from './nodeCatcherIdentity.js';
import { assertNodeProxyAcknowledgement } from './nodeProxyAuthority.js';

type ReadDB = Pick<DB, 'query' | 'select'>;
export type NodeSleepAdmission = { serviceId: number; owner: ServiceRuntimeOwner; workerToken: string; binding: string };
export const NODE_SLEEP_LEASE_MS = 90_000;
const terminal = ['completed', 'superseded'] as const;
const phases = { sleep: ['accepted', 'fencing', 'prepared', 'routing', 'routed', 'stopping', 'asleep', 'restoring'], wake: ['accepted', 'fencing', 'starting', 'readiness', 'publishing'] };
const unpublished = ['accepted', 'fencing', 'prepared'];
const staleUnpublished = (row: NodeSleepTransition) => row.action === 'sleep' && unpublished.includes(row.phase) &&
  (!Number.isSafeInteger(row.idleEvidence.sampledAt) || row.idleEvidence.sampledAt > Date.now() || Date.now() - row.idleEvidence.sampledAt >= 30_000);
const nonce = () => randomBytes(16).toString('hex');
const changed = () => new Error('Node sleep/wake authority, configuration or worker lease changed');
type Binding = Pick<NodeSleepTransition, 'serviceId' | 'serverId' | 'deploymentId' | 'runtimeId' | 'ownerEpoch' | 'requestId' | 'action' | 'configuration' | 'watermark' | 'wakeToken' | 'targets' | 'idleEvidence'>;
const binding = (row: Binding) => createHash('sha256').update(JSON.stringify([row.serviceId, row.serverId, row.deploymentId, row.runtimeId,
  row.ownerEpoch, row.requestId, row.action, row.configuration, row.watermark, row.wakeToken, row.targets, row.idleEvidence])).digest('hex');
const eligible = (svc: Service) => {
  const deploymentId = Number(/-([1-9]\d*)$/.exec(svc.runtimeId ?? '')?.[1]);
  return svc.type === 'docker' && svc.orchestrator !== 'swarm' && Number.isSafeInteger(svc.serverId) && svc.serverId! > 0 && svc.status === 'running' &&
    Number.isSafeInteger(deploymentId) && deploymentId > 0 && svc.runtimeId === `${svc.slug}-${deploymentId}` &&
    Number.isSafeInteger(svc.runtimeReplicas) && svc.runtimeReplicas >= 1 && svc.runtimeReplicas <= 10;
};

async function configuration(db: ReadDB, service: Service): Promise<string> {
  // Cosmetic fields and next-deploy replica/autoscale preferences do not change
  // the immutable serving generation a visitor is allowed to wake.
  const config = [service.type, service.orchestrator, service.slug, service.serverId, service.runtimeId, service.runtimeReplicas, service.port,
    service.healthCheck, service.healthPath, service.healthCommand, service.healthTimeoutSeconds, service.cpuShares, service.cpuLimitMilli, service.memLimitMb];
  const [attached, routes, capacity] = await Promise.all([
    db.select({ attachmentId: databaseAttachments.id, id: databases.id, slug: databases.slug, serverId: databases.serverId, status: databases.status }).from(databaseAttachments)
      .innerJoin(databases, eq(databases.id, databaseAttachments.databaseId)).where(eq(databaseAttachments.serviceId, service.id)).orderBy(databaseAttachments.id),
    db.select().from(domains).where(eq(domains.serviceId, service.id)).orderBy(domains.id),
    db.query.nodeAutoscaleCapacity.findFirst({ where: eq(nodeAutoscaleCapacity.deploymentId, Number(/-([1-9]\d*)$/.exec(service.runtimeId ?? '')?.[1])) }),
  ]);
  if (attached.some(item => item.serverId !== service.serverId || item.status !== 'running') || !routes.some(route => route.status === 'active')) throw changed();
  return createHash('sha256').update(JSON.stringify([config, attached, routes, capacity])).digest('hex');
}

async function unblocked(db: ReadDB, serviceId: number): Promise<boolean> {
  const conflicts = await Promise.all([
    db.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ['queued', 'building', 'deploying']))).limit(1),
    db.select({ id: nodeLifecycleIntents.id }).from(nodeLifecycleIntents).where(and(eq(nodeLifecycleIntents.serviceId, serviceId), notInArray(nodeLifecycleIntents.phase, ['completed', 'superseded']))).limit(1),
    db.select({ id: primaryTransitions.id }).from(primaryTransitions).where(eq(primaryTransitions.serviceId, serviceId)).limit(1),
    db.select({ id: fanoutTransitions.id }).from(fanoutTransitions).where(eq(fanoutTransitions.serviceId, serviceId)).limit(1),
    db.select({ id: nodeAutoscaleTransitions.serviceId }).from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, serviceId)).limit(1),
    db.select({ id: nodeDeploymentPreparations.deploymentId }).from(nodeDeploymentPreparations).where(eq(nodeDeploymentPreparations.serviceId, serviceId)).limit(1),
    db.select({ id: serviceTargets.id }).from(serviceTargets).where(eq(serviceTargets.serviceId, serviceId)).limit(1),
  ]);
  return conflicts.every(rows => rows.length === 0) && !canaryActive(serviceId);
}

/** Consume an opaque, current scheduler proof and reserve sleep in the same eligibility transaction. */
export async function admitNodeSleep(db: DB, expected: Service, token: NodeIdleEvidence): Promise<NodeSleepAdmission | null> {
  const proof = spendNodeIdleEvidence(token);
  if (!proof || !Number.isSafeInteger(proof.idleMs) || !eligible(expected) || expected.asleepAt != null || !Number.isInteger(expected.sleepAfterMinutes) ||
    expected.sleepAfterMinutes! < SLEEP_AFTER_MIN || expected.sleepAfterMinutes! > SLEEP_AFTER_MAX || proof.idleMs < expected.sleepAfterMinutes! * 60_000 ||
    proof.window.input.serviceId !== expected.id || proof.window.input.nodeId !== expected.serverId) return null;
  const freshProof = () => proof.current() && Number.isSafeInteger(proof.sampledAt) && proof.sampledAt <= Date.now() && Date.now() - proof.sampledAt < 30_000;
  if (!freshProof()) return null;
  try {
    if (await nodeServingTrafficContext(db, proof.window.input) !== proof.window.context) return null;
    return await db.transaction(async tx => {
      const fresh = await tx.query.services.findFirst({ where: eq(services.id, expected.id) });
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(expected) || await nodeWakeMaintenancePending(tx, fresh.serverId!) || !await unblocked(tx, fresh.id) || !freshProof() ||
        await readNodeServingTrafficState(tx, proof.window.input) !== proof.window.context) return null;
      const current = await tx.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, fresh.id) });
      if (current && !terminal.includes(current.phase as typeof terminal[number])) return null;
      const config = await configuration(tx, fresh), previous = await readServiceRuntimeOwner(tx, fresh.id);
      const owner = await reserveServiceRuntimeOwnerInTransaction(tx, fresh.id, 'sleep', nonce(), previous);
      const [sequence] = await tx.select({ value: sql<number>`COALESCE((SELECT seq FROM sqlite_sequence WHERE name='deployments'), 0)` }).from(services).where(eq(services.id, fresh.id)).limit(1);
      const input = proof.window.input, receipt = proof.window.finished, workerToken = nonce();
      const values = { serviceId: fresh.id, serverId: input.nodeId, deploymentId: input.deploymentId, runtimeId: fresh.runtimeId!, ownerEpoch: owner.epoch,
        requestId: owner.requestId!, action: 'sleep' as const, phase: 'accepted' as const, configuration: config, watermark: Math.max(input.deploymentId, Number(sequence?.value ?? 0)),
        wakeToken: nonce(), fallbackRouting: false, targets: input.serving.map(target => ({ ...target, deploymentId: input.deploymentId })),
        idleEvidence: { idleMs: proof.idleMs, sampledAt: proof.sampledAt, windowId: receipt.windowId, sourceId: receipt.sourceId,
          proxyId: receipt.proxyId, epoch: receipt.epoch, routingGeneration: receipt.routingGeneration, targetHash: receipt.targetHash },
        catcherId: null, catcherImage: null, catcherName: 'ninedeploy-wake', workerToken, leaseUntil: new Date(Date.now() + NODE_SLEEP_LEASE_MS), reason: null };
      const stamp = binding(values);
      const inserted = await tx.insert(nodeSleepTransitions).values({ ...values, binding: stamp }).onConflictDoUpdate({ target: nodeSleepTransitions.serviceId,
        set: { ...values, binding: stamp }, setWhere: inArray(nodeSleepTransitions.phase, ['completed', 'superseded']) }).returning();
      if (inserted.length !== 1 || !freshProof() || canaryActive(fresh.id)) throw changed();
      return { serviceId: fresh.id, owner, workerToken, binding: stamp };
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Node proxy traffic unavailable:')) return null;
    throw error;
  }
}

async function assertCurrent(db: ReadDB, admission: NodeSleepAdmission, requireLease = true, unwinding = false) {
  const row = await db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, admission.serviceId) });
  const service = await db.query.services.findFirst({ where: eq(services.id, admission.serviceId) });
  if (!row || !service || !eligible(service) || !phases[row.action].includes(row.phase) || terminal.includes(row.phase as typeof terminal[number]) ||
    row.binding !== admission.binding || binding(row) !== row.binding || row.serverId !== service.serverId || row.runtimeId !== service.runtimeId ||
    row.runtimeId !== `${service.slug}-${row.deploymentId}` || row.ownerEpoch !== admission.owner.epoch || row.requestId !== admission.owner.requestId ||
    admission.owner.kind !== row.action || !unwinding && staleUnpublished(row) || !sameRuntimeOwner(await readServiceRuntimeOwner(db, service.id), admission.owner) ||
    !unwinding && row.action === 'sleep' && !['asleep', 'restoring'].includes(row.phase) && (!Number.isInteger(service.sleepAfterMinutes) || service.sleepAfterMinutes! < SLEEP_AFTER_MIN ||
      service.sleepAfterMinutes! > SLEEP_AFTER_MAX || row.idleEvidence.idleMs < service.sleepAfterMinutes! * 60_000) ||
    requireLease && (row.workerToken !== admission.workerToken || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now()) ||
    (row.action === 'sleep' ? (row.phase === 'asleep') !== (service.asleepAt !== null) : service.asleepAt === null) ||
    !Number.isSafeInteger(row.watermark) || row.watermark < row.deploymentId ||
    row.catcherId !== null && !/^[a-f0-9]{64}$/.test(row.catcherId) || row.catcherImage !== null && !/^sha256:[a-f0-9]{64}$/.test(row.catcherImage) ||
    (row.catcherId === null) !== (row.catcherImage === null) || !validNodeCatcherName(row.catcherName) ||
    (row.action === 'wake' || ['prepared', 'routing', 'routed', 'stopping', 'asleep', 'restoring'].includes(row.phase)) && !row.catcherId ||
    row.fallbackRouting !== (row.action === 'wake' || ['routing', 'routed', 'stopping', 'asleep', 'restoring'].includes(row.phase)) ||
    await configuration(db, service) !== row.configuration || !await unblocked(db, service.id)) throw changed();
  const names = replicaNames(service.runtimeId!, service.runtimeReplicas);
  if (!Array.isArray(row.targets) || row.targets.length !== names.length || new Set(row.targets.map(target => target.id)).size !== names.length ||
    names.some(name => !row.targets.some(target => target.name === name && target.deploymentId === row.deploymentId && target.port === service.port && /^[a-f0-9]{64}$/.test(target.id)))) throw changed();
  return { row, service };
}

export async function checkpointNodeSleep(db: DB, admission: NodeSleepAdmission): Promise<NodeSleepTransition> {
  return db.transaction(async tx => {
    const { row } = await assertCurrent(tx, admission);
    await tx.update(nodeSleepTransitions).set({ leaseUntil: new Date(Date.now() + NODE_SLEEP_LEASE_MS) }).where(and(eq(nodeSleepTransitions.serviceId, admission.serviceId), eq(nodeSleepTransitions.workerToken, admission.workerToken)));
    return row;
  });
}

/** The ordered controller must reach publishing only after fresh stable readiness. */
export async function prepareNodeWakeRouting(db: DB, admission: NodeSleepAdmission) {
  const verify = async () => {
    const row = await checkpointNodeSleep(db, admission);
    if (row.action !== 'wake' || row.phase !== 'publishing') throw changed();
    return row;
  };
  const row = await verify();
  return registerNodeWakeRoutePromotion(row.serverId, row.serviceId, async () => { await verify(); });
}

/** Before any Stop attempt, a failed sleep must restore the app instead of resuming an old idle decision. */
export async function abortNodeSleep(db: DB, admission: NodeSleepAdmission, reason: string): Promise<'completed' | 'restoring'> {
  return db.transaction(async tx => {
    const { row } = await assertCurrent(tx, admission, true, true);
    if (row.action !== 'sleep' || ['stopping', 'asleep'].includes(row.phase)) throw changed();
    const phase = row.fallbackRouting ? 'restoring' as const : 'completed' as const;
    await tx.update(nodeSleepTransitions).set({ phase, reason: reason.slice(0, 1000), ...(phase === 'completed' ? { workerToken: null, leaseUntil: null } : {}) })
      .where(eq(nodeSleepTransitions.serviceId, admission.serviceId));
    return phase;
  });
}

export async function prepareNodeSleepRestoration(db: DB, admission: NodeSleepAdmission) {
  const verify = async () => {
    const row = await checkpointNodeSleep(db, admission);
    if (row.action !== 'sleep' || row.phase !== 'restoring') throw changed();
    return row;
  };
  const row = await verify();
  return registerNodeWakeRoutePromotion(row.serverId, row.serviceId, async () => { await verify(); });
}

export async function completeNodeSleepRestoration(db: DB, admission: NodeSleepAdmission) {
  await db.transaction(async tx => {
    const { row } = await assertCurrent(tx, admission);
    if (row.action !== 'sleep' || row.phase !== 'restoring') throw changed();
    await tx.update(nodeSleepTransitions).set({ phase: 'completed', fallbackRouting: false, workerToken: null, leaseUntil: null })
      .where(eq(nodeSleepTransitions.serviceId, admission.serviceId));
  });
}

/** Request identity stays fixed across worker recovery; a newer service command uses a higher epoch. */
export function nodeSleepCommand(admission: NodeSleepAdmission, operation: 'fence' | 'stop' | 'start') {
  return { serviceId: admission.serviceId, requestId: createHash('sha256').update(`${admission.owner.requestId}:node-${admission.owner.kind}-${operation}`).digest('hex').slice(0, 32),
    revision: serviceRuntimeRevision(admission.owner.epoch, operation === 'fence' ? 0 : 1) };
}

const steps: Record<'sleep' | 'wake', Partial<Record<NodeSleepTransition['phase'], NodeSleepTransition['phase']>>> = {
  sleep: { accepted: 'fencing', fencing: 'prepared', prepared: 'routing', routing: 'routed', routed: 'stopping' },
  wake: { accepted: 'fencing', fencing: 'starting', readiness: 'publishing' },
};
export async function advanceNodeSleep(db: DB, admission: NodeSleepAdmission, from: NodeSleepTransition['phase'], to: NodeSleepTransition['phase']) {
  await db.transaction(async tx => {
    const { row } = await assertCurrent(tx, admission);
    if (row.phase !== from || steps[row.action][from] !== to || ['prepared', 'routing'].includes(to) && (!row.catcherId || !row.catcherImage)) throw changed();
    await tx.update(nodeSleepTransitions).set({ phase: to, ...(to === 'routing' ? { fallbackRouting: true } : {}), leaseUntil: new Date(Date.now() + NODE_SLEEP_LEASE_MS) }).where(eq(nodeSleepTransitions.serviceId, admission.serviceId));
  });
}

export async function bindNodeSleepCatcher(db: DB, admission: NodeSleepAdmission, catcher: CatcherIdentity) {
  const name = catcher.name ?? 'ninedeploy-wake';
  if (!/^[a-f0-9]{64}$/.test(catcher.id) || !/^sha256:[a-f0-9]{64}$/.test(catcher.image) || !validNodeCatcherName(name)) throw changed();
  await db.transaction(async tx => {
    const { row } = await assertCurrent(tx, admission);
    if (row.phase !== 'fencing' || row.action !== 'sleep' || row.catcherId !== null && (row.catcherId !== catcher.id || row.catcherImage !== catcher.image || row.catcherName !== name)) throw changed();
    await tx.update(nodeSleepTransitions).set({ catcherId: catcher.id, catcherImage: catcher.image, catcherName: name }).where(eq(nodeSleepTransitions.serviceId, admission.serviceId));
  });
}

/** Rebind a recreated, separately confirmed catcher without reviving a superseded sleep cycle. */
export async function refreshNodeSleepCatcher(db: DB, expected: ServiceRuntimeOwner, previousId: string, catcher: CatcherIdentity) {
  await db.transaction(tx => refreshNodeSleepCatcherInTransaction(tx, expected, previousId, catcher));
}

export async function readNodeSleepingState(db: ReadDB, serviceId: number) {
  const row = await db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, serviceId) });
  const owner = await readServiceRuntimeOwner(db, serviceId);
  if (!row || !owner || row.action !== 'sleep' || row.phase !== 'asleep' || owner.kind !== 'sleep' || owner.epoch !== row.ownerEpoch || owner.requestId !== row.requestId) return null;
  return { ...await assertCurrent(db, { serviceId, owner, workerToken: '', binding: row.binding }, false), owner };
}

export async function refreshNodeSleepCatcherInTransaction(db: ReadDB & Pick<DB, 'update'>, expected: ServiceRuntimeOwner, previousId: string, catcher: CatcherIdentity) {
  const name = catcher.name ?? 'ninedeploy-wake';
  if (!/^[a-f0-9]{64}$/.test(catcher.id) || !/^sha256:[a-f0-9]{64}$/.test(catcher.image) || !validNodeCatcherName(name)) throw changed();
  const row = await db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, expected.serviceId) });
  if (!row || row.action !== 'sleep' || row.phase !== 'asleep' || row.catcherId !== previousId) throw changed();
  await assertCurrent(db, { serviceId: expected.serviceId, owner: expected, workerToken: '', binding: row.binding }, false);
  await db.update(nodeSleepTransitions).set({ catcherId: catcher.id, catcherImage: catcher.image, catcherName: name }).where(eq(nodeSleepTransitions.serviceId, expected.serviceId));
}

async function complete(db: DB, admission: NodeSleepAdmission, raw: unknown, action: 'sleep' | 'wake', authority?: NodeProxyWriteHead) {
  await db.transaction(async tx => {
    const { row } = await assertCurrent(tx, admission), command = nodeSleepCommand(admission, row.action === 'sleep' ? 'stop' : 'start');
    if (row.action !== action) throw changed();
    if (row.phase !== (row.action === 'sleep' ? 'stopping' : 'publishing')) throw changed();
    if (row.action === 'wake') {
      if (!authority) throw changed();
      await assertNodeProxyAcknowledgement(tx, row.serverId, authority);
    }
    if (row.action === 'sleep') {
      const receipt = containerStopSetReply.parse(raw);
      if (receipt.requestId !== command.requestId || receipt.serviceId !== command.serviceId || receipt.revision !== command.revision ||
        receipt.items.length !== row.targets.length || row.targets.some(target => !receipt.items.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId))) throw changed();
    }
    await tx.update(services).set({ asleepAt: row.action === 'sleep' ? new Date() : null }).where(eq(services.id, admission.serviceId));
    await tx.update(nodeSleepTransitions).set({ phase: row.action === 'sleep' ? 'asleep' : 'completed', fallbackRouting: row.action === 'sleep', workerToken: null, leaseUntil: null, reason: null }).where(eq(nodeSleepTransitions.serviceId, admission.serviceId));
  });
}
export const completeNodeSleep = (db: DB, admission: NodeSleepAdmission, receipt: unknown) => complete(db, admission, receipt, 'sleep');
export const completeNodeWake = (db: DB, admission: NodeSleepAdmission, authority: NodeProxyWriteHead) => complete(db, admission, undefined, 'wake', authority);

/** The readiness phase durably records a validated Start acknowledgement, without replaying Start after recovery. */
export async function recordNodeWakeStarted(db: DB, admission: NodeSleepAdmission, raw: unknown) {
  await db.transaction(async tx => {
    const { row } = await assertCurrent(tx, admission), command = nodeSleepCommand(admission, 'start');
    const receipt = containerStartSetReply.parse(raw);
    if (row.action !== 'wake' || row.phase !== 'starting' || receipt.requestId !== command.requestId || receipt.serviceId !== command.serviceId ||
      receipt.revision !== command.revision || receipt.items.length !== row.targets.length || row.targets.some(target =>
        !receipt.items.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId))) throw changed();
    await tx.update(nodeSleepTransitions).set({ phase: 'readiness', leaseUntil: new Date(Date.now() + NODE_SLEEP_LEASE_MS) }).where(eq(nodeSleepTransitions.serviceId, admission.serviceId));
  });
}

export async function holdNodeSleep(db: DB, admission: NodeSleepAdmission, reason: string) {
  await db.update(nodeSleepTransitions).set({ reason: reason.slice(0, 1000), workerToken: null, leaseUntil: null }).where(and(
    eq(nodeSleepTransitions.serviceId, admission.serviceId), eq(nodeSleepTransitions.ownerEpoch, admission.owner.epoch),
    eq(nodeSleepTransitions.requestId, admission.owner.requestId!), eq(nodeSleepTransitions.workerToken, admission.workerToken),
    notInArray(nodeSleepTransitions.phase, ['asleep', 'completed', 'superseded'])));
}

/** Only a current sleeping token from the pinned catcher's fresh demand can admit a wake. */
export async function admitNodeWake(db: DB, expected: Service, demand: { nodeId: number; token: string; catcherId: string; demandAt: number; receivedAt: number }): Promise<NodeSleepAdmission | null> {
  const now = Date.now();
  if (!eligible(expected) || expected.asleepAt == null || demand.nodeId !== expected.serverId || !/^[a-f0-9]{32}$/.test(demand.token) ||
    ![demand.receivedAt, demand.demandAt].every(Number.isSafeInteger) || demand.receivedAt > now || now - demand.receivedAt >= 30_000 ||
    demand.demandAt < demand.receivedAt - 60_000 || demand.demandAt > demand.receivedAt + 5000) return null;
  return db.transaction(async tx => {
    const row = await tx.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, expected.id) });
    const service = await tx.query.services.findFirst({ where: eq(services.id, expected.id) });
    const previous = await readServiceRuntimeOwner(tx, expected.id);
    if (!row || !service || JSON.stringify(service) !== JSON.stringify(expected) || await nodeWakeMaintenancePending(tx, service.serverId!) || row.phase !== 'asleep' || row.action !== 'sleep' ||
      row.wakeToken !== demand.token || row.catcherId !== demand.catcherId || !previous || previous.kind !== 'sleep' || previous.epoch !== row.ownerEpoch || previous.requestId !== row.requestId) return null;
    await assertCurrent(tx, { serviceId: service.id, owner: previous, workerToken: '', binding: row.binding }, false);
    const owner = await reserveServiceRuntimeOwnerInTransaction(tx, service.id, 'wake', nonce(), previous), workerToken = nonce();
    const stamp = binding({ ...row, action: 'wake', ownerEpoch: owner.epoch, requestId: owner.requestId! });
    await tx.update(nodeSleepTransitions).set({ action: 'wake', phase: 'accepted', ownerEpoch: owner.epoch, requestId: owner.requestId!, workerToken, binding: stamp,
      leaseUntil: new Date(Date.now() + NODE_SLEEP_LEASE_MS), reason: null }).where(eq(nodeSleepTransitions.serviceId, service.id));
    return { serviceId: service.id, owner, workerToken, binding: stamp };
  });
}

export async function recoverNodeSleep(db: DB, serviceId: number, expected?: Pick<NodeSleepTransition, 'binding' | 'requestId' | 'action'>): Promise<NodeSleepAdmission | null> {
  return db.transaction(async tx => {
    const [row] = await tx.update(nodeSleepTransitions).set({ workerToken: nonce(), leaseUntil: new Date(Date.now() + NODE_SLEEP_LEASE_MS) })
      .where(and(eq(nodeSleepTransitions.serviceId, serviceId), notInArray(nodeSleepTransitions.phase, ['completed', 'superseded', 'asleep']),
        expected ? and(eq(nodeSleepTransitions.binding, expected.binding), eq(nodeSleepTransitions.requestId, expected.requestId), eq(nodeSleepTransitions.action, expected.action)) : undefined,
        or(isNull(nodeSleepTransitions.leaseUntil), lte(nodeSleepTransitions.leaseUntil, new Date())))).returning();
    if (!row) return null;
    if (staleUnpublished(row)) {
      await tx.update(nodeSleepTransitions).set({ phase: 'superseded', workerToken: null, leaseUntil: null, reason: 'unpublished idle evidence expired' })
        .where(eq(nodeSleepTransitions.serviceId, serviceId));
      return null;
    }
    const owner = await readServiceRuntimeOwner(tx, serviceId);
    if (!owner) throw changed();
    const admission = { serviceId, owner, workerToken: row.workerToken!, binding: row.binding };
    await assertCurrent(tx, admission); return admission;
  });
}
