import { createHash } from 'node:crypto';
import { eq, nodeAutoscaleTransitions, type DB, type Service } from '@ninedeploy/db';
import { containerInventoryReply, containerRetireSetReply, containerStartSetReply, containerStopSetReply, runtimeFenceReply } from '@ninedeploy/schemas';
import { z } from 'zod';
import { replicaNames } from '../engine/dockerNames.js';
import { advanceNodeAutoscale, checkpointNodeAutoscale, freezeNodeAutoscaleInventory, nodeAutoscaleFence,
  type NodeAutoscaleAdmission, type NodeAutoscalePhase } from './nodeAutoscaleAuthority.js';
import { serviceRuntimeRevision } from './serviceRuntimeOwner.js';

type Target = { id: string; name: string; deploymentId: number };
type Fence = ReturnType<typeof nodeAutoscaleFence>;
type Mutation = { requestId: string; serviceId: number; revision: number; timeoutMs: number; targets: Target[] };
export interface NodeAutoscaleControllerDeps {
  preflight: (serverId: number) => Promise<void>;
  fence: (serverId: number, input: Fence) => Promise<unknown>;
  inventory: (serverId: number, input: Fence & { expectedNames: string[] }) => Promise<unknown>;
  start: (serverId: number, input: Mutation) => Promise<unknown>;
  stop: (serverId: number, input: Mutation & { graceSeconds: number }) => Promise<unknown>;
  retire: (serverId: number, input: Mutation & { graceSeconds: number }) => Promise<unknown>;
  handoff: (serverId: number, input: { requestId: string; serviceId: number; revision: number; timeoutMs: number; deploymentWatermark: number }) => Promise<unknown>;
  ready: (service: Service, targets: Target[]) => Promise<boolean>;
  route: (service: Service, serverId: number) => Promise<void>;
  drain: () => Promise<void>;
  signal?: AbortSignal;
}

/** Execute a persisted scale decision; each externally visible effect is replayable under its stable revision. */
export async function executeNodeAutoscale(db: DB, admission: NodeAutoscaleAdmission, deps: NodeAutoscaleControllerDeps): Promise<void> {
  const serverId = admission.service.serverId!, from = admission.service.runtimeReplicas, to = admission.desiredReplicas, up = to > from;
  const checkpoint = async (count: number) => { deps.signal?.throwIfAborted(); await checkpointNodeAutoscale(db, admission, count); deps.signal?.throwIfAborted(); };
  const effect = async <T>(count: number, fn: () => Promise<T>) => { await checkpoint(count); const result = await fn(); await checkpoint(count); return result; };
  const match = (reply: { requestId: string; serviceId: number; revision: number }, request: { requestId: string; serviceId: number; revision: number }) =>
    reply.requestId === request.requestId && reply.serviceId === request.serviceId && reply.revision === request.revision;
  for (;;) {
    const [row] = await db.select().from(nodeAutoscaleTransitions).where(eq(nodeAutoscaleTransitions.serviceId, admission.service.id)).limit(1);
    if (!row) throw new Error('Node autoscale transition disappeared');
    const phase = row.phase as NodeAutoscalePhase;
    const count = ['routing', 'draining', 'stopping', 'handoff'].includes(phase) ? to : from;
    await checkpoint(count);
    if (phase === 'accepted') {
      for (const node of [...admission.targets.map(target => target.serverId), serverId]) await effect(from, () => deps.preflight(node));
      await advanceNodeAutoscale(db, admission, 'accepted', 'fencing');
      continue;
    }
    if (phase === 'fencing') {
      for (const node of [...admission.targets.map(target => target.serverId), serverId]) {
        const request = nodeAutoscaleFence(admission, node);
        const reply = runtimeFenceReply.parse(await effect(from, () => deps.fence(node, request)));
        if (!match(reply, request) || reply.deploymentWatermark !== request.deploymentWatermark) throw new Error('Node autoscale fence receipt changed');
      }
      const request = nodeAutoscaleFence(admission);
      const evidence = await effect(from, () => deps.inventory(serverId, { ...request, expectedNames: replicaNames(admission.service.runtimeId!, Math.max(from, to)) }));
      await freezeNodeAutoscaleInventory(db, admission, evidence);
      await advanceNodeAutoscale(db, admission, 'fencing', 'prepared');
      continue;
    }
    const { timeoutMs: _timeout, ...fence } = nodeAutoscaleFence(admission);
    const inventory = containerInventoryReply.parse({ ...fence, complete: true, items: row.replicaInventory });
    const names = replicaNames(admission.service.runtimeId!, Math.max(from, to));
    if (inventory.items.length !== names.length || names.some((name, index) => inventory.items[index]?.name !== name ||
      inventory.items[index]?.running !== (index < from) || inventory.items[index]?.deploymentId !== Number(/-([1-9]\d*)$/.exec(admission.service.runtimeId!)?.[1]))) throw new Error('Frozen node autoscale inventory changed');
    const targets = inventory.items.slice(Math.min(from, to), Math.max(from, to)).map(({ running: _running, ...target }) => target);
    const mutation: Mutation = { requestId: createHash('sha256').update(`${admission.owner.requestId}:scale-effect:${serverId}`).digest('hex').slice(0, 32),
      serviceId: admission.service.id, revision: serviceRuntimeRevision(admission.owner.epoch, 1), timeoutMs: 60_000, targets };
    const sameTargets = (items: Target[]) => items.length === targets.length && targets.every(target => items.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId));
    if (phase === 'prepared' && up) {
      const reply = containerStartSetReply.parse(await effect(from, () => deps.start(serverId, mutation)));
      if (!match(reply, mutation) || !sameTargets(reply.items)) throw new Error('Node autoscale Start receipt changed');
      await advanceNodeAutoscale(db, admission, 'prepared', 'started');
    } else if (phase === 'started' && up) {
      if (!await effect(from, () => deps.ready(admission.service, targets))) throw new Error('Node autoscale readiness unconfirmed');
      await advanceNodeAutoscale(db, admission, 'started', 'ready');
    } else if (phase === 'ready' && up || phase === 'prepared' && !up) {
      await advanceNodeAutoscale(db, admission, phase, 'routing');
    } else if (phase === 'routing') {
      if (up && !await effect(to, () => deps.ready(admission.service, targets))) throw new Error('Node autoscale readiness unconfirmed before routing');
      await effect(to, () => deps.route(admission.service, serverId));
      await advanceNodeAutoscale(db, admission, 'routing', up ? 'handoff' : 'draining');
    } else if (phase === 'draining' && !up) {
      await effect(to, deps.drain);
      await advanceNodeAutoscale(db, admission, 'draining', 'stopping');
    } else if (phase === 'stopping' && !up) {
      const reply = containerStopSetReply.parse(await effect(to, () => deps.stop(serverId, { ...mutation, graceSeconds: 10 })));
      if (!match(reply, mutation) || !sameTargets(reply.items)) throw new Error('Node autoscale Stop receipt changed');
      await advanceNodeAutoscale(db, admission, 'stopping', 'handoff');
    } else if (phase === 'handoff') {
      for (const node of [...admission.targets.map(target => target.serverId), serverId]) {
        const request = { requestId: createHash('sha256').update(`${admission.owner.requestId}:scale-handoff:${node}`).digest('hex').slice(0, 32),
          serviceId: admission.service.id, revision: serviceRuntimeRevision(admission.owner.epoch, 2), timeoutMs: 30_000, graceSeconds: 0, targets: [] };
        const retired = containerRetireSetReply.parse(await effect(to, () => deps.retire(node, request)));
        if (!match(retired, request) || retired.items.length !== 0) throw new Error('Node autoscale handoff retirement is unconfirmed');
        const handoff = { requestId: request.requestId, serviceId: request.serviceId, revision: request.revision, timeoutMs: 30_000, deploymentWatermark: admission.watermark };
        const reply = z.object({ requestId: z.string(), serviceId: z.number(), revision: z.number(), deploymentWatermark: z.number(), complete: z.literal(true) }).strict()
          .parse(await effect(to, () => deps.handoff(node, handoff)));
        if (!match(reply, handoff) || reply.deploymentWatermark !== handoff.deploymentWatermark) throw new Error('Node autoscale handoff is unconfirmed');
      }
      await advanceNodeAutoscale(db, admission, 'handoff', 'completed');
      return;
    } else throw new Error('Node autoscale phase is invalid');
  }
}
