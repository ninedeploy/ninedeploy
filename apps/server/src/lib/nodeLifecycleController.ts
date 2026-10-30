import { createHash } from 'node:crypto';
import { eq, nodeDeploymentPreparations, nodeLifecycleIntents, type DB, type Service } from '@ninedeploy/db';
import { containerInventoryRequest, containerInventoryReply, containerStopSetRequest, containerStopSetReply, containerRetireSetReply, runtimeFenceRequest, runtimeFenceReply, containerLifecycleReply, containerLifecycleRequest, containerLifecycleRetireRequest, containerLifecycleRetireReply, type ContainerReadinessRequest } from '@ninedeploy/schemas';
import { z } from 'zod';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import type { AgentOpResult } from './agentClient.js';
import { agentVersionAtLeast, capabilityRefusal, parseAgentCapabilities } from './agentCapabilities.js';
import { HttpError } from './errors.js';
import {
  advanceNodeLifecycleIntent, checkpointNodeLifecycleIntent, claimNodeLifecycleIntent, holdNodeLifecycleIntent,
  nodeLifecycleWireRevision, supersedeNodeLifecycleIntent,
} from './nodeLifecycleIntent.js';
import { verifyNodeReadiness } from './nodeReadiness.js';

export interface NodeLifecycleControllerDeps {
  agent: (serverId: number, op: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }) => Promise<AgentOpResult>;
  sealed: (serverId: number) => Promise<boolean>;
  /** Resolve only after this service's routing generation is acknowledged by the selected node. */
  route: (service: Service, signal?: AbortSignal, serverId?: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

const identity = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(),
  managed: z.string().nullable(), serviceId: z.string().nullable(), deploymentId: z.string().nullable() }).strict();

/** Execute one durable command. Recoveries retain its identities, revisions and unfinished phase. */
export async function executeNodeLifecycleIntent(db: DB, id: number, deps: NodeLifecycleControllerDeps): Promise<{
  state: 'completed' | 'superseded' | 'held' | 'busy' | 'missing';
}> {
  const claimed = await claimNodeLifecycleIntent(db, id);
  if (!claimed) {
    const row = await db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.id, id) });
    return { state: !row ? 'missing' : row.phase === 'completed' || row.phase === 'superseded' ? row.phase : 'busy' };
  }
  let intent = claimed;
  const requiresCreationFence = intent.action === 'stop' && !intent.snapshot.unselected &&
    (intent.snapshot.interruptedDeployments?.length ?? 0) > 0;
  const checkpoint = async () => {
    deps.signal?.throwIfAborted();
    const current = await checkpointNodeLifecycleIntent(db, intent);
    intent = current.intent;
    deps.signal?.throwIfAborted();
    return current.service;
  };
  const call = async (serverId: number, op: string, params: Record<string, unknown>, timeoutMs = 15_000) => {
    await checkpoint();
    const result = await deps.agent(serverId, op, params, { signal: deps.signal, timeoutMs });
    await checkpoint();
    if (result.exitCode !== 0) throw new Error(`Node lifecycle operation ${op} failed`);
    return result;
  };
  type Participant = { serverId: number; runtimeId: string | null; deploymentId: number | null; serving: number; expectedNames?: string[] };
  const participants = (): Participant[] => {
    if (intent.snapshot.unselected) {
      if (intent.action !== 'stop' || intent.runtimeId !== null || intent.deploymentId !== null) throw new Error('Invalid unselected Stop snapshot');
      const accepted = [intent.serverId, ...(intent.snapshot.fanout ?? []).map(target => target.serverId)];
      const nodes = intent.snapshot.unselected.participants;
      if (!Array.isArray(nodes) || nodes.length !== accepted.length || new Set(nodes.map(node => node.serverId)).size !== nodes.length ||
        nodes.some(node => !accepted.includes(node.serverId) || !Array.isArray(node.expectedNames))) throw new Error('Unselected Stop placement changed');
      return nodes.map(node => ({ ...node, runtimeId: null, deploymentId: null, serving: 0 }));
    }
    if (intent.runtimeId === null || intent.deploymentId === null) throw new Error('Missing selected runtime identity');
    return [{ serverId: intent.serverId, runtimeId: intent.runtimeId, deploymentId: intent.deploymentId, serving: intent.snapshot.serving },
    ...(intent.snapshot.fanout ?? []).filter(target => target.runtimeId !== null || requiresCreationFence).map(target => {
      if (target.runtimeId === null) return { serverId: target.serverId, runtimeId: null, deploymentId: null, serving: 0 };
      const deploymentId = Number(/-([1-9]\d*)$/.exec(target.runtimeId!)?.[1]);
      if (!Number.isSafeInteger(deploymentId) || deploymentId < 1) throw new Error('Fan-out runtime has no managed deployment identity; redeploy this target');
      return { serverId: target.serverId, runtimeId: target.runtimeId!, deploymentId, serving: 1 };
    })];
  };
  const fenceRequest = (participant: Participant) => ({ requestId: createHash('sha256').update(intent.requestId + ':fence' + (participant.serverId === intent.serverId ? '' : ':' + participant.serverId)).digest('hex').slice(0,32),
    serviceId: intent.serviceId, revision: nodeLifecycleWireRevision(intent, 'fence'), timeoutMs: 30_000,
    ...(intent.snapshot.creationFenceDeploymentId === undefined ? {} : { deploymentWatermark: intent.snapshot.creationFenceDeploymentId }) });
  const machine = <T extends { requestId: string; serviceId: number; revision: number }>(result: AgentOpResult, prefix: string, parse: (value: unknown) => T, input: { requestId: string; serviceId: number; revision: number }): T => {
    const frames = result.lines.filter(line => line.startsWith(prefix));
    if (frames.length !== 1 || Buffer.byteLength(frames[0]!) > 65_536) throw new Error('Node runtime receipt unavailable');
    const reply = parse(JSON.parse(frames[0]!.slice(prefix.length)));
    if (reply.requestId !== input.requestId || reply.serviceId !== input.serviceId || reply.revision !== input.revision) throw new Error('Node runtime receipt owner changed');
    return reply;
  };
  const capturedTargets = (participant: Participant) => (intent.targets ?? [])
    .filter(target => (target.serverId ?? intent.serverId) === participant.serverId).map(({ id, name }) => ({ id, name }));
  const verifyPreparationIdentities = async (participant: Participant, targets: NonNullable<typeof intent.targets>) => {
    if (intent.action !== 'stop' || participant.serverId !== intent.serverId) return;
    const records = await db.select().from(nodeDeploymentPreparations).where(eq(nodeDeploymentPreparations.serviceId, intent.serviceId));
    for (const record of records) {
      if (record.serverId !== participant.serverId || !(intent.snapshot.interruptedDeployments ?? []).some(item => item.id === record.deploymentId)) {
        throw new Error('Node preparation placement changed');
      }
      if (record.phase === 'preparing' && record.targets === null) continue;
      const names = replicaNames(record.runtimeId, record.capacity);
      if (record.phase !== 'prepared' || !Number.isSafeInteger(record.capacity) || record.capacity < 1 || record.capacity > MAX_REPLICAS ||
        !Array.isArray(record.targets) || record.targets.length !== names.length ||
        record.targets.some((target, index) => target.name !== names[index] || !/^[a-f0-9]{64}$/.test(target.id)) ||
        new Set(record.targets.map(target => target.id)).size !== names.length) throw new Error('Node preparation receipt is invalid');
      for (const target of targets) {
        const expected = record.targets.find(item => item.name === target.name);
        if (expected ? expected.id !== target.id || target.deploymentId !== record.deploymentId : target.deploymentId === record.deploymentId) {
          throw new Error('Node preparation identity changed');
        }
      }
    }
  };
  const discover = async (participant: Participant) => {
    const targets: NonNullable<typeof intent.targets> = [];
    if (intent.snapshot.unselected) {
      const request = containerInventoryRequest.parse({ ...fenceRequest(participant), expectedNames: participant.expectedNames });
      const reply = machine(await call(participant.serverId, 'docker.runtimeInventory', request, 35_000), 'ND-RUNTIME-INVENTORY ', value => containerInventoryReply.parse(value), request);
      const found = reply.items.map(({ running: _running, ...item }) => ({ ...item, ...(participant.serverId === intent.serverId ? {} : { serverId: participant.serverId }) }));
      if (intent.snapshot.retireUnselected && found.some(item => !participant.expectedNames?.includes(item.name) ||
        !(intent.snapshot.interruptedDeployments ?? []).some(deployment => deployment.id === item.deploymentId &&
          (item.name.endsWith(`-${deployment.id}`) || Array.from({ length: MAX_REPLICAS - 1 }, (_, index) => `-${deployment.id}-r${index + 2}`).some(suffix => item.name.endsWith(suffix)))))) {
        throw new Error('Initial Stop inventory contains an unrecorded generation; retained for review');
      }
      await verifyPreparationIdentities(participant, found);
      return found;
    }
    if ((participant.runtimeId === null || participant.deploymentId === null) && !requiresCreationFence) throw new Error('Missing selected generation');
    const selected = participant.runtimeId === null ? [] : replicaNames(participant.runtimeId, intent.action === 'start' ? participant.serving : MAX_REPLICAS)
      .map(name => ({ name, deploymentId: participant.deploymentId! }));
    const candidates = requiresCreationFence ? intent.snapshot.candidateParticipants?.find(item => item.serverId === participant.serverId)?.targets : [];
    if (requiresCreationFence && !candidates) throw new Error('Stop candidate identities are unavailable');
    const names = [...selected, ...(candidates ?? [])];
    if (new Set(names.map(item => item.name)).size !== names.length || names.some(item => !Number.isSafeInteger(item.deploymentId) || item.deploymentId < 1)) throw new Error('Stop candidate identities are invalid');
    for (const { name, deploymentId } of names) {
      const result = await call(participant.serverId, 'docker.identity', { name });
      const frames = result.lines.filter(line => line.startsWith('ND-CONTAINER '));
      if (frames.length !== 1 || Buffer.byteLength(frames[0]!) > 16 * 1024) throw new Error('Node lifecycle identity unavailable');
      const found = identity.nullable().parse(JSON.parse(frames[0]!.slice(13)));
      if (!found) {
        if (intent.action !== 'stop' && participant.runtimeId && replicaNames(participant.runtimeId, participant.serving).includes(name)) throw new Error(`Node lifecycle serving replica ${name} is missing`);
        continue;
      }
      if (found.name !== name || found.managed !== 'service' || found.serviceId !== String(intent.serviceId) || found.deploymentId !== String(deploymentId)) {
        throw new Error(`Node lifecycle ownership of ${name} is unconfirmed; container retained`);
      }
      targets.push({ id: found.id, name, ...(requiresCreationFence ? { deploymentId } : {}), ...(participant.serverId !== intent.serverId ? { serverId: participant.serverId } : {}) });
    }
    if (new Set(targets.map(target => target.id)).size !== targets.length) throw new Error('Duplicate node lifecycle identity');
    await verifyPreparationIdentities(participant, targets);
    return targets;
  };
  const servingTargets = (participant: Participant) => {
    if (participant.runtimeId === null) throw new Error('Missing serving runtime');
    const names = replicaNames(participant.runtimeId, participant.serving);
    const selected = names.map(name => capturedTargets(participant).find(t => t.name === name));
    if (selected.some(target => !target)) throw new Error('Node lifecycle serving targets are unavailable');
    return selected.map(target => target!);
  };
  const retireCandidates = async (participant: Participant) => {
    const candidateNames = intent.snapshot.candidateParticipants?.find(item => item.serverId === participant.serverId)?.targets;
    if (!candidateNames) throw new Error('Stop candidate identities are unavailable');
    const targets = (intent.targets ?? []).filter(target => (target.serverId ?? intent.serverId) === participant.serverId &&
      candidateNames.some(candidate => candidate.name === target.name && candidate.deploymentId === target.deploymentId))
      .map(({ serverId: _server, ...target }) => target);
    if (!targets.length) return;
    const request = containerLifecycleRetireRequest.parse({ requestId: intent.requestId, serviceId: intent.serviceId,
      revision: nodeLifecycleWireRevision(intent, 'effect'), targets, timeoutMs: 30_000 });
    const reply = machine(await call(participant.serverId, 'docker.lifecycleRetire', request, 35_000), 'ND-LIFECYCLE-RETIRED ',
      value => containerLifecycleRetireReply.parse(value), request);
    if (reply.items.length !== request.targets.length || request.targets.some(target => !reply.items.some(item =>
      item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId && item.removed))) {
      throw new Error('Stop candidate retirement coverage changed');
    }
  };
  const apply = async (participant: Participant, fence: boolean, restarting = false) => {
    if (!fence && intent.targets === null) throw new Error('Node lifecycle immutable targets are unavailable');
    if (intent.snapshot.unselected) {
      if (fence) {
        const request = runtimeFenceRequest.parse(fenceRequest(participant));
        const reply = machine(await call(participant.serverId, 'docker.runtimeFence', request, 35_000), 'ND-RUNTIME-FENCE ', value => runtimeFenceReply.parse(value), request);
        if (reply.deploymentWatermark !== request.deploymentWatermark) throw new Error('Node Stop fence watermark is unconfirmed');
      } else {
        const request = containerStopSetRequest.parse({ requestId: intent.requestId, serviceId: intent.serviceId, revision: nodeLifecycleWireRevision(intent, 'effect'), timeoutMs: 30_000, graceSeconds: 5,
          targets: (intent.targets ?? []).filter(target => (target.serverId ?? intent.serverId) === participant.serverId).map(({ serverId: _server, ...target }) => target) });
        const retire = intent.snapshot.retireUnselected === true;
        const reply = retire
          ? machine(await call(participant.serverId, 'docker.retireSet', request, 35_000), 'ND-RETIRED-SET ', value => containerRetireSetReply.parse(value), request)
          : machine(await call(participant.serverId, 'docker.stopSet', request, 35_000), 'ND-STOPPED-SET ', value => containerStopSetReply.parse(value), request);
        if (reply.items.length !== request.targets.length || request.targets.some(target => !reply.items.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId))) throw new Error('Node Stop generation coverage changed');
        const watermark = intent.snapshot.creationFenceDeploymentId;
        if (!Number.isSafeInteger(watermark) || watermark! < 1 || request.targets.some(target => target.deploymentId > watermark!)) throw new Error('Node Stop creation watermark is unconfirmed');
        const handoff = { requestId: request.requestId, serviceId: request.serviceId, revision: request.revision, deploymentWatermark: watermark!, timeoutMs: 30_000 };
        const confirmation = machine(await call(participant.serverId, 'docker.runtimeLegacyHandoff', handoff, 35_000), 'ND-RUNTIME-LEGACY ',
          value => z.object({ requestId: z.string(), serviceId: z.number(), revision: z.number(), deploymentWatermark: z.number(), complete: z.literal(true) }).strict().parse(value), handoff);
        if (confirmation.deploymentWatermark !== watermark) throw new Error('Node Stop creation watermark changed');
      }
      return;
    }
    if (participant.deploymentId === null && !requiresCreationFence) throw new Error('Missing selected deployment');

    const request = containerLifecycleRequest.parse({ requestId: fence
      ? createHash('sha256').update(`${intent.requestId}:fence${participant.serverId === intent.serverId ? '' : `:${participant.serverId}`}`).digest('hex').slice(0, 32) : intent.requestId,
    serviceId: intent.serviceId, deploymentId: requiresCreationFence && (fence || participant.deploymentId === null) ? intent.snapshot.creationFenceDeploymentId : participant.deploymentId,
    revision: nodeLifecycleWireRevision(intent, fence ? 'fence' : restarting ? 'restart-start' : 'effect'),
    action: !fence && (intent.action === 'start' || restarting) ? 'start' : 'stop',
    targets: fence ? [] : restarting ? servingTargets(participant) : requiresCreationFence
      ? (intent.targets ?? []).filter(target => (target.serverId ?? intent.serverId) === participant.serverId).map(({ serverId: _server, ...target }) => target)
      : capturedTargets(participant), timeoutMs: 30_000 });
    const result = await call(participant.serverId, 'docker.lifecycle', request, 35_000);
    const frames = result.lines.filter(line => line.startsWith('ND-LIFECYCLE '));
    if (frames.length !== 1 || Buffer.byteLength(frames[0]!) > 64 * 1024) throw new Error('Node lifecycle receipt unavailable');
    const reply = containerLifecycleReply.parse(JSON.parse(frames[0]!.slice(13)));
    if (reply.requestId !== request.requestId || reply.serviceId !== request.serviceId || reply.deploymentId !== request.deploymentId ||
      reply.revision !== request.revision || reply.action !== request.action || reply.items.length !== request.targets.length ||
      new Set(reply.items.map(item => item.id)).size !== request.targets.length || request.targets.some(target =>
        !reply.items.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId && item.running === (request.action === 'start')))) {
      throw new Error('Node lifecycle receipt identity, revision or coverage changed');
    }
  };
  const readiness = async (participant: Participant) => {
    const mode = intent.snapshot.healthCheck;
    const spec: Omit<ContainerReadinessRequest, 'requestId' | 'timeoutMs'> = {
      targets: servingTargets(participant), port: intent.snapshot.port, path: intent.snapshot.healthPath || '/',
      mode: mode === 'running' || mode === 'command' || mode === 'http-strict' || mode === 'tcp' ? mode : 'auto',
    };
    const ready = await verifyNodeReadiness((op, params, _sink, options) => call(participant.serverId, op, params, Math.min(15_000, options?.timeoutMs ?? 15_000)),
      spec, (intent.snapshot.healthTimeoutS ?? 300) * 1000, async () => { await checkpoint(); }, deps.log ?? (() => undefined));
    await checkpoint();
    if (!ready) throw new Error('Node lifecycle serving readiness is unconfirmed');
  };
  const routeAll = async () => {
    for (const participant of participants()) {
      const service = await checkpoint();
      await deps.route(service, deps.signal, participant.serverId);
      await checkpoint();
    }
  };
  const readinessAll = async () => {
    for (const participant of participants()) await readiness(participant);
  };
  const removeRouting = async () => {
    await routeAll();
    await deps.sleep(2000);
    await checkpoint();
  };
  try {
    await checkpoint();
    if (requiresCreationFence && (!Number.isSafeInteger(intent.snapshot.creationFenceDeploymentId) ||
      intent.snapshot.creationFenceDeploymentId! < (intent.snapshot.interruptedDeployments ?? []).reduce((max, row) => Math.max(max, row.id), intent.deploymentId ?? 0))) {
      throw new Error('Interrupted deployment creation fence is unavailable');
    }
    if (requiresCreationFence) {
      const accepted = [intent.serverId, ...(intent.snapshot.fanout ?? []).map(target => target.serverId)];
      const saved = intent.snapshot.candidateParticipants, slug = intent.snapshot.candidateSlug;
      if (!Array.isArray(saved) || saved.length !== accepted.length || new Set(saved.map(item => item.serverId)).size !== accepted.length ||
        typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(slug) ||
        saved.some(item => {
          if (!accepted.includes(item.serverId) || !Array.isArray(item.targets)) return true;
          const expected = (intent.snapshot.interruptedDeployments ?? []).flatMap(row =>
            replicaNames(item.serverId === intent.serverId ? `${slug}-${row.id}` : `${slug}-t${item.serverId}-${row.id}`, MAX_REPLICAS)
              .map(name => ({ name, deploymentId: row.id })));
          return JSON.stringify(item.targets) !== JSON.stringify(expected);
        })) throw new Error('Stop candidate placement is unconfirmed');
    }
    for (const participant of participants()) {
      const sealed = await deps.sealed(participant.serverId);
      await checkpoint();
      let ping: AgentOpResult | undefined;
      const refusal = await capabilityRefusal(async (op, params) => {
        const result = await call(participant.serverId, op, params, 5000);
        if (op === 'agent.ping') ping = result;
        return result;
      }, `#${participant.serverId}`, sealed, {
        cap: intent.snapshot.unselected ? ['docker.mutations', 'proxy.routingAck', ...(intent.snapshot.retireUnselected ? ['docker.retireHandoff' as const] : [])] : ['docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck',
          ...(requiresCreationFence ? ['docker.lifecycle.creationFence' as const, 'docker.lifecycle.generations' as const, 'docker.lifecycle.retire' as const] : [])], feature: 'execute ordered node lifecycle commands', sealedRequired: true,
      });
      await checkpoint();
      if (refusal) throw new Error(refusal.message);
      if (intent.snapshot.unselected && !agentVersionAtLeast(parseAgentCapabilities(ping?.lines ?? []).version, '0.18.11')) {
        throw new Error(`Update the agent on node #${participant.serverId} to 0.18.11 or newer to complete initial Stop safely`);
      }
    }
    let readyThisRun = false, routingRemovedThisRun = false;
    while (true) {
      await checkpoint();
      if (intent.phase === 'fencing') {
        for (const participant of participants()) await apply(participant, true);
        intent = await advanceNodeLifecycleIntent(db, intent, 'preparing');
      } else if (intent.phase === 'preparing') {
        const targets: NonNullable<typeof intent.targets> = [];
        for (const participant of participants()) targets.push(...await discover(participant));
        intent = await advanceNodeLifecycleIntent(db, intent, intent.action === 'start' ? 'applying' : 'routing', { targets });
      } else if (intent.phase === 'applying') {
        if (intent.action !== 'start' && !routingRemovedThisRun) await removeRouting();
        for (const participant of participants()) {
          await apply(participant, false);
          if (requiresCreationFence) await retireCandidates(participant);
        }
        intent = await advanceNodeLifecycleIntent(db, intent, intent.action === 'restart' ? 'starting' : intent.action === 'start' ? 'readiness' : 'completed',
          requiresCreationFence || intent.snapshot.retireUnselected ? { retiredCandidates: true } : {});
      } else if (intent.phase === 'starting') {
        for (const participant of participants()) await apply(participant, false, true);
        intent = await advanceNodeLifecycleIntent(db, intent, 'warming');
      } else if (intent.phase === 'warming') {
        await readinessAll(); readyThisRun = true;
        intent = await advanceNodeLifecycleIntent(db, intent, 'publishing', { serviceStatus: 'deploying' });
      } else if (intent.phase === 'readiness') {
        await readinessAll(); readyThisRun = true;
        intent = await advanceNodeLifecycleIntent(db, intent, 'routing', { serviceStatus: 'deploying' });
      } else if (intent.phase === 'routing' || intent.phase === 'publishing') {
        if (intent.phase === 'routing' && intent.action !== 'start') {
          await removeRouting(); routingRemovedThisRun = true;
          intent = await advanceNodeLifecycleIntent(db, intent, 'applying');
        } else {
          if (!readyThisRun) await readinessAll();
          await routeAll();
          intent = await advanceNodeLifecycleIntent(db, intent, 'completed', { serviceStatus: 'running' });
        }
      } else return { state: intent.phase };
      if (intent.phase === 'completed') return { state: 'completed' };
    }
  } catch (error) {
    if (error instanceof HttpError && error.code === 'node_lifecycle_superseded') {
      await supersedeNodeLifecycleIntent(db, intent);
      return { state: 'superseded' };
    }
    await holdNodeLifecycleIntent(db, intent, error);
    return { state: 'held' };
  }
}
