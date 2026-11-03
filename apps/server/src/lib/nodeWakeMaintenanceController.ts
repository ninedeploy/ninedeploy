import type { DB } from '@ninedeploy/db';
import type { AgentOpResult } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { checkpointNodeWakeMaintenance, prepareNodeCatcherRouting,
  holdNodeWakeMaintenance, recordNodeWakeMaintenanceCatcher, completeNodeWakeRetirement, assertNodeCatcherUnreferenced, rebaseNodeWakeMaintenance, type NodeWakeMaintenanceClaim } from './nodeWakeMaintenance.js';
import type { NodeCatcherRoutePromotion } from './nodeCatcherRoutePromotion.js';
import { nodeWakeKey } from './nodeWakeKey.js';
import { verifyNodeReadiness } from './nodeReadiness.js';
import { validNodeCatcherName } from './nodeCatcherIdentity.js';
import { z } from 'zod';

export interface NodeWakeMaintenanceDeps {
  agent: (nodeId: number, op: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }) => Promise<AgentOpResult>;
  sealed: (nodeId: number) => Promise<boolean>;
  ensure: (nodeId: number, key: string, signal?: AbortSignal) => Promise<{ id: string; image: string; name: string; created: boolean }>;
  /** Exact ordered fallback routing must be loaded before this resolves. */
  route: (nodeId: number, promotion: NodeCatcherRoutePromotion, signal?: AbortSignal) => Promise<number>;
  retire: (nodeId: number, target: { id: string; name: string }, verify: () => Promise<void>, signal?: AbortSignal) => Promise<{ id: string; name: string; fenced: true; removed: boolean }>;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** Every attempt re-proves catcher reachability and routing; no expired worker releases the barrier. */
export async function executeNodeWakeMaintenance(db: DB, claim: NodeWakeMaintenanceClaim, deps: NodeWakeMaintenanceDeps): Promise<{
  state: 'completed' | 'held'; rebound?: number; retired?: number; reason?: string;
}> {
  const checkpoint = async () => {
    deps.signal?.throwIfAborted(); const row = await checkpointNodeWakeMaintenance(db, claim); deps.signal?.throwIfAborted(); return row;
  };
  const effect = async <T>(fn: () => Promise<T>) => { await checkpoint(); const result = await fn(); await checkpoint(); return result; };
  const call = async (op: string, params: Record<string, unknown>, timeoutMs = 15_000) => {
    const result = await effect(() => deps.agent(claim.serverId, op, params, { signal: deps.signal, timeoutMs }));
    if (result.exitCode !== 0) throw new Error(`Node wake maintenance operation ${op} failed`);
    return result;
  };
  try {
    const initial = await checkpoint();
    const sealed = await effect(() => deps.sealed(claim.serverId));
    const refusal = await capabilityRefusal((op, params) => call(op, params, 5000), `#${claim.serverId}`, sealed, {
      cap: ['wake.catcher.prepare', 'wake.catcher.retire', 'docker.recovery', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite'], feature: 'recover sleeping node routing', sealedRequired: true,
    });
    if (refusal) throw new Error(refusal.message);
    const key = await effect(() => nodeWakeKey(db, claim.serverId));
    if (!key) throw new Error('Node wake maintenance requires the persisted credential');
    const catcher = await effect(() => deps.ensure(claim.serverId, key, deps.signal));
    const ready = async () => verifyNodeReadiness((op, params, _sink, options) => call(op, params, options?.timeoutMs),
      { targets: [{ id: catcher.id, name: catcher.name }], mode: 'tcp', port: 8080, path: '/' }, 15_000,
      async () => { await checkpoint(); }, deps.log ?? (() => undefined));
    if (!await ready()) throw new Error('Node wake catcher readiness is unconfirmed');
    await checkpoint(); let rebound = 0, alreadyBound = initial.phase === 'retiring';
    if (initial.catcherId && (initial.catcherId !== catcher.id || initial.catcherName !== catcher.name || initial.catcherImage !== catcher.image)) {
      claim = await rebaseNodeWakeMaintenance(db, claim, catcher); alreadyBound = false;
    }
    if (!alreadyBound) {
      await recordNodeWakeMaintenanceCatcher(db, claim, catcher);
      const promotion = await prepareNodeCatcherRouting(db, claim);
      await checkpoint();
      // Binding settlement retains the admission barrier until old IDs are retired.
      rebound = await deps.route(claim.serverId, promotion, deps.signal);
      if (!await ready()) throw new Error('Node wake catcher readiness is unconfirmed before retirement');
    }
    const row = await checkpoint();
    if (row.phase !== 'retiring') throw new Error('Node wake retirement journal is unconfirmed');
    const targets = new Map(row.snapshot.filter(item => item.catcherId !== row.catcherId).map(item => [item.catcherId, item.catcherName]));
    const receipts: Array<{ id: string; name: string; fenced: true; removed: boolean }> = [];
    for (const [id, capturedName] of targets) {
      const verify = async () => { const current = await checkpoint();
        if (current.phase !== 'retiring' || current.catcherId !== catcher.id || current.catcherName !== catcher.name) throw new Error('Node wake retirement candidate changed');
        await assertNodeCatcherUnreferenced(db, claim.serverId, id);
      };
      await verify(); let name = capturedName;
      if (!name) {
        const result = await call('docker.identity', { name: id });
        const frames = result.lines.filter(line => line.startsWith('ND-CONTAINER '));
        if (frames.length !== 1 || Buffer.byteLength(frames[0]!) > 8192) throw new Error('Retained catcher identity unavailable');
        const identity = z.object({ id: z.string(), name: z.string(), managed: z.string().nullable(), serviceId: z.string().nullable(), deploymentId: z.string().nullable() }).strict()
          .parse(JSON.parse(frames[0]!.slice('ND-CONTAINER '.length)));
        if (identity.id !== id || identity.managed !== 'wake') throw new Error('Retained catcher identity changed');
        name = identity.name;
      }
      if (!validNodeCatcherName(name)) throw new Error('Retained catcher name is unconfirmed');
      const receipt = await effect(() => deps.retire(claim.serverId, { id, name: name! }, verify, deps.signal));
      if (receipt.id !== id || receipt.name !== name || receipt.fenced !== true || typeof receipt.removed !== 'boolean') throw new Error('Retained catcher retirement receipt changed');
      receipts.push(receipt);
    }
    await completeNodeWakeRetirement(db, claim, receipts);
    return { state: 'completed', rebound, retired: receipts.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await holdNodeWakeMaintenance(db, claim, reason);
    return { state: 'held', reason };
  }
}
