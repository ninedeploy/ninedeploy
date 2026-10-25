import { createHash } from 'node:crypto';
import { eq, nodeLifecycleIntents, type DB, type Service } from '@ninedeploy/db';
import { containerLifecycleReply, containerLifecycleRequest, type ContainerReadinessRequest } from '@ninedeploy/schemas';
import { z } from 'zod';
import { MAX_REPLICAS, replicaNames } from '../engine/dockerNames.js';
import type { AgentOpResult } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { HttpError } from './errors.js';
import {
  advanceNodeLifecycleIntent, checkpointNodeLifecycleIntent, claimNodeLifecycleIntent, holdNodeLifecycleIntent,
  nodeLifecycleRevision, supersedeNodeLifecycleIntent,
} from './nodeLifecycleIntent.js';
import { verifyNodeReadiness } from './nodeReadiness.js';

export interface NodeLifecycleControllerDeps {
  agent: (serverId: number, op: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }) => Promise<AgentOpResult>;
  sealed: (serverId: number) => Promise<boolean>;
  /** Resolve only after this service's routing generation is acknowledged by the selected node. */
  route: (service: Service, signal?: AbortSignal) => Promise<void>;
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
  const checkpoint = async () => {
    deps.signal?.throwIfAborted();
    const current = await checkpointNodeLifecycleIntent(db, intent);
    intent = current.intent;
    deps.signal?.throwIfAborted();
    return current.service;
  };
  const call = async (op: string, params: Record<string, unknown>, timeoutMs = 15_000) => {
    await checkpoint();
    const result = await deps.agent(intent.serverId, op, params, { signal: deps.signal, timeoutMs });
    await checkpoint();
    if (result.exitCode !== 0) throw new Error(`Node lifecycle operation ${op} failed`);
    return result;
  };
  const discover = async () => {
    const targets: Array<{ id: string; name: string }> = [];
    const names = replicaNames(intent.runtimeId, intent.action === 'start' ? intent.snapshot.serving : MAX_REPLICAS);
    for (const name of names) {
      const result = await call('docker.identity', { name });
      const frames = result.lines.filter(line => line.startsWith('ND-CONTAINER '));
      if (frames.length !== 1 || Buffer.byteLength(frames[0]!) > 16 * 1024) throw new Error('Node lifecycle identity unavailable');
      const found = identity.nullable().parse(JSON.parse(frames[0]!.slice(13)));
      if (!found) {
        if (intent.action !== 'stop' && replicaNames(intent.runtimeId, intent.snapshot.serving).includes(name)) throw new Error(`Node lifecycle serving replica ${name} is missing`);
        continue;
      }
      if (found.name !== name || found.managed !== 'service' || found.serviceId !== String(intent.serviceId) || found.deploymentId !== String(intent.deploymentId)) {
        throw new Error(`Node lifecycle ownership of ${name} is unconfirmed; container retained`);
      }
      targets.push({ id: found.id, name });
    }
    if (new Set(targets.map(target => target.id)).size !== targets.length) throw new Error('Duplicate node lifecycle identity');
    return targets;
  };
  const servingTargets = () => {
    const names = replicaNames(intent.runtimeId, intent.snapshot.serving);
    const selected = names.map(name => intent.targets?.find(t => t.name === name));
    if (selected.some(target => !target)) throw new Error('Node lifecycle serving targets are unavailable');
    return selected.map(target => target!);
  };
  const apply = async (fence: boolean, restarting = false) => {
    if (!fence && intent.targets === null) throw new Error('Node lifecycle immutable targets are unavailable');
    const request = containerLifecycleRequest.parse({ requestId: fence
      ? createHash('sha256').update(`${intent.requestId}:fence`).digest('hex').slice(0, 32) : intent.requestId,
    serviceId: intent.serviceId, deploymentId: intent.deploymentId, revision: nodeLifecycleRevision(intent.id, fence ? 'fence' : restarting ? 'restart-start' : 'effect'),
    action: !fence && (intent.action === 'start' || restarting) ? 'start' : 'stop',
    targets: fence ? [] : restarting ? servingTargets() : intent.targets, timeoutMs: 30_000 });
    const result = await call('docker.lifecycle', request, 35_000);
    const frames = result.lines.filter(line => line.startsWith('ND-LIFECYCLE '));
    if (frames.length !== 1 || Buffer.byteLength(frames[0]!) > 64 * 1024) throw new Error('Node lifecycle receipt unavailable');
    const reply = containerLifecycleReply.parse(JSON.parse(frames[0]!.slice(13)));
    if (reply.requestId !== request.requestId || reply.serviceId !== request.serviceId || reply.deploymentId !== request.deploymentId ||
      reply.revision !== request.revision || reply.action !== request.action || reply.items.length !== request.targets.length ||
      new Set(reply.items.map(item => item.id)).size !== request.targets.length || request.targets.some(target =>
        !reply.items.some(item => item.id === target.id && item.name === target.name && item.running === (request.action === 'start')))) {
      throw new Error('Node lifecycle receipt identity, revision or coverage changed');
    }
  };
  const readiness = async () => {
    const mode = intent.snapshot.healthCheck;
    const spec: Omit<ContainerReadinessRequest, 'requestId' | 'timeoutMs'> = {
      targets: servingTargets(), port: intent.snapshot.port, path: intent.snapshot.healthPath || '/',
      mode: mode === 'running' || mode === 'command' || mode === 'http-strict' || mode === 'tcp' ? mode : 'auto',
    };
    const ready = await verifyNodeReadiness((op, params, _sink, options) => call(op, params, Math.min(15_000, options?.timeoutMs ?? 15_000)),
      spec, (intent.snapshot.healthTimeoutS ?? 300) * 1000, async () => { await checkpoint(); }, deps.log ?? (() => undefined));
    await checkpoint();
    if (!ready) throw new Error('Node lifecycle serving readiness is unconfirmed');
  };
  const removeRouting = async () => {
    const service = await checkpoint();
    await deps.route(service, deps.signal);
    await checkpoint();
    await deps.sleep(2000);
    await checkpoint();
  };
  try {
    await checkpoint();
    const sealed = await deps.sealed(intent.serverId);
    await checkpoint();
    const refusal = await capabilityRefusal((op, params) => call(op, params, 5000), `#${intent.serverId}`, sealed, {
      cap: ['docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck'], feature: 'execute ordered node lifecycle commands', sealedRequired: true,
    });
    await checkpoint();
    if (refusal) throw new Error(refusal.message);
    let readyThisRun = false, routingRemovedThisRun = false;
    while (true) {
      await checkpoint();
      if (intent.phase === 'fencing') {
        await apply(true);
        intent = await advanceNodeLifecycleIntent(db, intent, 'preparing');
      } else if (intent.phase === 'preparing') {
        const targets = await discover();
        intent = await advanceNodeLifecycleIntent(db, intent, intent.action === 'start' ? 'applying' : 'routing', { targets });
      } else if (intent.phase === 'applying') {
        if (intent.action !== 'start' && !routingRemovedThisRun) await removeRouting();
        await apply(false);
        intent = await advanceNodeLifecycleIntent(db, intent, intent.action === 'restart' ? 'starting' : intent.action === 'start' ? 'readiness' : 'completed');
      } else if (intent.phase === 'starting') {
        await apply(false, true);
        intent = await advanceNodeLifecycleIntent(db, intent, 'warming');
      } else if (intent.phase === 'warming') {
        await readiness(); readyThisRun = true;
        intent = await advanceNodeLifecycleIntent(db, intent, 'publishing', { serviceStatus: 'deploying' });
      } else if (intent.phase === 'readiness') {
        await readiness(); readyThisRun = true;
        intent = await advanceNodeLifecycleIntent(db, intent, 'routing', { serviceStatus: 'deploying' });
      } else if (intent.phase === 'routing' || intent.phase === 'publishing') {
        if (intent.phase === 'routing' && intent.action !== 'start') {
          await removeRouting(); routingRemovedThisRun = true;
          intent = await advanceNodeLifecycleIntent(db, intent, 'applying');
        } else {
          if (!readyThisRun) await readiness();
          const service = await checkpoint();
          await deps.route(service, deps.signal);
          await checkpoint();
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
