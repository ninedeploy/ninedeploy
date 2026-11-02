import { eq, nodeSleepTransitions, services, type DB } from '@ninedeploy/db';
import { containerStartSetRequest, runtimeFenceRequest, runtimeFenceReply } from '@ninedeploy/schemas';
import type { AgentOpResult } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { advanceNodeSleep, checkpointNodeSleep, completeNodeWake, holdNodeSleep, nodeSleepCommand, prepareNodeWakeRouting,
  recordNodeWakeStarted, type NodeSleepAdmission } from './nodeSleepAuthority.js';
import { verifyNodeApplicationReadiness } from './nodeApplicationReadiness.js';
import type { NodeWakeRoutePromotion } from './nodeWakeRoutePromotion.js';

export interface NodeWakeControllerDeps {
  agent: (nodeId: number, op: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }) => Promise<AgentOpResult>;
  sealed: (nodeId: number) => Promise<boolean>;
  /** Must resolve only after exact ordered routing acknowledgement. */
  route: (nodeId: number, promotion: NodeWakeRoutePromotion, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** Resume an admitted wake. A recovered publishing phase always repeats readiness, never Start. */
export async function executeNodeWake(db: DB, admission: NodeSleepAdmission, deps: NodeWakeControllerDeps): Promise<{
  state: 'completed' | 'superseded' | 'held'; reason?: string;
}> {
  if (admission.owner.kind !== 'wake') return { state: 'held', reason: 'Node wake admission required' };
  const checkpoint = async () => {
    deps.signal?.throwIfAborted();
    const row = await checkpointNodeSleep(db, admission);
    if (row.action !== 'wake') throw new Error('Node wake action changed');
    deps.signal?.throwIfAborted(); return row;
  };
  const call = async (op: string, params: Record<string, unknown>, timeoutMs = 15_000) => {
    const row = await checkpoint();
    const result = await deps.agent(row.serverId, op, params, { signal: deps.signal, timeoutMs });
    await checkpoint();
    if (result.exitCode !== 0) throw new Error(`Node wake operation ${op} failed`);
    return result;
  };
  const frame = (result: AgentOpResult, prefix: string) => {
    const lines = result.lines.filter(line => line.startsWith(prefix));
    if (lines.length !== 1 || Buffer.byteLength(lines[0]!) > 65_536) throw new Error('Node wake receipt unavailable');
    return JSON.parse(lines[0]!.slice(prefix.length)) as unknown;
  };
  const ready = async () => {
    const row = await checkpoint(), service = await db.query.services.findFirst({ where: eq(services.id, row.serviceId) });
    if (!service) throw new Error('Node wake service disappeared');
    const targets = row.targets.map(({ id, name }) => ({ id, name }));
    await verifyNodeApplicationReadiness(service, targets, (op, params, _sink, options) => call(op, params, Math.max(1, Math.min(15_000, options?.timeoutMs ?? 15_000))),
      async () => { await checkpoint(); }, deps.log);
  };
  try {
    const row = await checkpoint(), sealed = await deps.sealed(row.serverId);
    await checkpoint();
    const refusal = await capabilityRefusal((op, params) => call(op, params), `#${row.serverId}`, sealed, {
      cap: ['docker.mutations', 'docker.startSet', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'wake.catcher'],
      feature: 'wake a node service with confirmed routing', sealedRequired: true,
    });
    if (refusal) throw new Error(refusal.message);
    let readyThisRun = false;
    for (;;) {
      const current = await checkpoint();
      if (current.phase === 'accepted') await advanceNodeSleep(db, admission, 'accepted', 'fencing');
      else if (current.phase === 'fencing') {
        const request = runtimeFenceRequest.parse({ ...nodeSleepCommand(admission, 'fence'), timeoutMs: 30_000, deploymentWatermark: current.watermark });
        const reply = runtimeFenceReply.parse(frame(await call('docker.runtimeFence', request, 35_000), 'ND-RUNTIME-FENCE '));
        if (reply.requestId !== request.requestId || reply.serviceId !== request.serviceId || reply.revision !== request.revision || reply.deploymentWatermark !== request.deploymentWatermark) throw new Error('Node wake fence changed');
        await advanceNodeSleep(db, admission, 'fencing', 'starting');
      } else if (current.phase === 'starting') {
        const request = containerStartSetRequest.parse({ ...nodeSleepCommand(admission, 'start'), timeoutMs: 60_000,
          targets: current.targets.map(({ id, name, deploymentId }) => ({ id, name, deploymentId })) });
        await recordNodeWakeStarted(db, admission, frame(await call('docker.startSet', request, 65_000), 'ND-STARTED-SET '));
      } else if (current.phase === 'readiness') {
        await ready(); readyThisRun = true;
        await advanceNodeSleep(db, admission, 'readiness', 'publishing');
      } else if (current.phase === 'publishing') {
        if (!readyThisRun) await ready();
        const promotion = await prepareNodeWakeRouting(db, admission);
        await checkpoint(); await deps.route(current.serverId, promotion, deps.signal); await checkpoint();
        await completeNodeWake(db, admission);
        return { state: 'completed' };
      } else throw new Error('Node wake phase is invalid');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const row = await db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, admission.serviceId) });
    if (row?.phase === 'superseded') return { state: 'superseded' };
    await holdNodeSleep(db, admission, reason);
    return { state: 'held', reason };
  }
}
