import { eq, nodeSleepTransitions, services, type DB } from '@ninedeploy/db';
import { containerStopSetRequest, runtimeFenceRequest, runtimeFenceReply } from '@ninedeploy/schemas';
import { z } from 'zod';
import { capabilityRefusal } from './agentCapabilities.js';
import { abortNodeSleep, advanceNodeSleep, bindNodeSleepCatcher, checkpointNodeSleep, completeNodeSleep, completeNodeSleepRestoration,
  holdNodeSleep, nodeSleepCommand, prepareNodeSleepRestoration, type NodeSleepAdmission } from './nodeSleepAuthority.js';
import { nodeWakeKey } from './nodeWakeKey.js';
import { verifyNodeReadiness } from './nodeReadiness.js';
import { verifyNodeApplicationReadiness } from './nodeApplicationReadiness.js';
import type { NodeWakeControllerDeps } from './nodeWakeController.js';
import type { NodeWakeRoutePromotion } from './nodeWakeRoutePromotion.js';

export interface NodeSleepControllerDeps extends Omit<NodeWakeControllerDeps, 'route'> {
  /** Without promotion, publish/confirm the journal's catcher fallback. */
  route: (nodeId: number, promotion?: NodeWakeRoutePromotion, signal?: AbortSignal) => Promise<void>;
  drain: (signal?: AbortSignal) => Promise<void>;
}
const catcherReceipt = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  name: z.string().length(50).regex(/^ninedeploy-wake-g-[a-f0-9]{32}$/), created: z.boolean() }).strict();

/** No Stop begins before confirmed, reachable catcher routing; pre-Stop failures restore the app. */
export async function executeNodeSleep(db: DB, admission: NodeSleepAdmission, deps: NodeSleepControllerDeps): Promise<{
  state: 'asleep' | 'aborted' | 'superseded' | 'held'; reason?: string;
}> {
  if (admission.owner.kind !== 'sleep') return { state: 'held', reason: 'Node sleep admission required' };
  const checkpoint = async () => { deps.signal?.throwIfAborted(); const row = await checkpointNodeSleep(db, admission); deps.signal?.throwIfAborted(); return row; };
  const effect = async <T>(fn: () => Promise<T>) => { await checkpoint(); const result = await fn(); await checkpoint(); return result; };
  const call = async (op: string, params: Record<string, unknown>, timeoutMs = 15_000) => {
    const row = await checkpoint();
    const result = await effect(() => deps.agent(row.serverId, op, params, { signal: deps.signal, timeoutMs }));
    if (result.exitCode !== 0) throw new Error(`Node sleep operation ${op} failed`);
    return result;
  };
  const frame = (result: { lines: string[] }, prefix: string) => {
    const lines = result.lines.filter(line => line.startsWith(prefix));
    if (lines.length !== 1 || Buffer.byteLength(lines[0]!) > 65_536) throw new Error('Node sleep receipt unavailable');
    return JSON.parse(lines[0]!.slice(prefix.length)) as unknown;
  };
  const catcherReady = async () => {
    const row = await checkpoint();
    if (!row.catcherId) throw new Error('Node sleep catcher identity unavailable');
    const ready = await verifyNodeReadiness((op, params, _sink, options) => call(op, params, Math.max(1, options?.timeoutMs ?? 15_000)),
      { targets: [{ id: row.catcherId, name: row.catcherName }], mode: 'tcp', port: 8080, path: '/' }, 15_000, async () => { await checkpoint(); }, deps.log ?? (() => undefined));
    if (!ready) throw new Error('Node sleep catcher readiness is unconfirmed');
  };
  const restore = async () => {
    const row = await checkpoint(), service = await db.query.services.findFirst({ where: eq(services.id, admission.serviceId) });
    if (!service) throw new Error('Node sleep service disappeared');
    await verifyNodeApplicationReadiness(service, row.targets.map(({ id, name }) => ({ id, name })),
      (op, params, _sink, options) => call(op, params, Math.max(1, options?.timeoutMs ?? 15_000)), async () => { await checkpoint(); }, deps.log);
    const promotion = await prepareNodeSleepRestoration(db, admission);
    await effect(() => deps.route(row.serverId, promotion, deps.signal));
    await completeNodeSleepRestoration(db, admission);
  };
  try {
    const row = await checkpoint(), sealed = await effect(() => deps.sealed(row.serverId));
    const refusal = await capabilityRefusal((op, params) => call(op, params), `#${row.serverId}`, sealed, {
      cap: ['docker.mutations', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'wake.catcher.prepare'],
      feature: 'sleep a node service with confirmed wake routing', sealedRequired: true,
    });
    if (refusal) throw new Error(refusal.message);
    for (;;) {
      const current = await checkpoint();
      if (current.phase === 'restoring') { await restore(); return { state: 'aborted' }; }
      if (current.phase !== 'stopping' && (Date.now() < current.idleEvidence.sampledAt || Date.now() - current.idleEvidence.sampledAt >= 30_000)) throw new Error('Node sleep idle decision expired before Stop');
      if (current.phase === 'accepted') await advanceNodeSleep(db, admission, 'accepted', 'fencing');
      else if (current.phase === 'fencing') {
        const request = runtimeFenceRequest.parse({ ...nodeSleepCommand(admission, 'fence'), timeoutMs: 30_000, deploymentWatermark: current.watermark });
        const reply = runtimeFenceReply.parse(frame(await call('docker.runtimeFence', request, 35_000), 'ND-RUNTIME-FENCE '));
        if (reply.requestId !== request.requestId || reply.serviceId !== request.serviceId || reply.revision !== request.revision || reply.deploymentWatermark !== request.deploymentWatermark) throw new Error('Node sleep fence changed');
        const key = await effect(() => nodeWakeKey(db, current.serverId, true));
        const catcher = catcherReceipt.parse(frame(await call('wake.catcher.prepare', { key }, 65_000), 'ND-WAKE-CATCHER '));
        await bindNodeSleepCatcher(db, admission, catcher);
        await catcherReady(); await advanceNodeSleep(db, admission, 'fencing', 'prepared');
      } else if (current.phase === 'prepared') await advanceNodeSleep(db, admission, 'prepared', 'routing');
      else if (current.phase === 'routing') {
        await catcherReady(); await effect(() => deps.route(current.serverId, undefined, deps.signal));
        await advanceNodeSleep(db, admission, 'routing', 'routed');
      } else if (current.phase === 'routed') {
        await effect(() => deps.drain(deps.signal));
        if (Date.now() < current.idleEvidence.sampledAt || Date.now() - current.idleEvidence.sampledAt >= 30_000) throw new Error('Node sleep idle decision expired before Stop');
        await advanceNodeSleep(db, admission, 'routed', 'stopping');
      } else if (current.phase === 'stopping') {
        // The Stop may already have landed. Reconfirm a reachable fallback on recovery.
        await catcherReady(); await effect(() => deps.route(current.serverId, undefined, deps.signal));
        const request = containerStopSetRequest.parse({ ...nodeSleepCommand(admission, 'stop'), timeoutMs: 30_000, graceSeconds: 10,
          targets: current.targets.map(({ id, name, deploymentId }) => ({ id, name, deploymentId })) });
        await completeNodeSleep(db, admission, frame(await call('docker.stopSet', request, 35_000), 'ND-STOPPED-SET '));
        return { state: 'asleep' };
      } else throw new Error('Node sleep phase is invalid');
    }
  } catch (error) {
    let reason = error instanceof Error ? error.message : String(error);
    const row = await db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, admission.serviceId) });
    if (row?.phase === 'superseded') return { state: 'superseded' };
    if (row?.phase !== 'stopping' && row?.phase !== 'restoring') {
      try {
        if (await abortNodeSleep(db, admission, reason) === 'completed') return { state: 'aborted', reason };
        await restore(); return { state: 'aborted', reason };
      } catch (restorationError) {
        reason += `; restoration unavailable: ${restorationError instanceof Error ? restorationError.message : String(restorationError)}`;
      }
    }
    await holdNodeSleep(db, admission, reason);
    return { state: 'held', reason };
  }
}
