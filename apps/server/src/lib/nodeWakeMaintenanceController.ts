import type { DB } from '@ninedeploy/db';
import type { AgentOpResult } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { checkpointNodeWakeMaintenance, completeNodeWakeMaintenance, confirmNodeWakeMaintenanceRouting,
  holdNodeWakeMaintenance, recordNodeWakeMaintenanceCatcher, type NodeWakeMaintenanceClaim } from './nodeWakeMaintenance.js';
import { nodeWakeKey } from './nodeWakeKey.js';
import { verifyNodeReadiness } from './nodeReadiness.js';

export interface NodeWakeMaintenanceDeps {
  agent: (nodeId: number, op: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }) => Promise<AgentOpResult>;
  sealed: (nodeId: number) => Promise<boolean>;
  ensure: (nodeId: number, key: string, signal?: AbortSignal) => Promise<{ id: string; image: string; created: boolean }>;
  /** Exact ordered fallback routing must be loaded before this resolves. */
  route: (nodeId: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** Every attempt re-proves catcher reachability and routing; no expired worker releases the barrier. */
export async function executeNodeWakeMaintenance(db: DB, claim: NodeWakeMaintenanceClaim, deps: NodeWakeMaintenanceDeps): Promise<{
  state: 'completed' | 'held'; rebound?: number; reason?: string;
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
    await checkpoint();
    const sealed = await effect(() => deps.sealed(claim.serverId));
    const refusal = await capabilityRefusal((op, params) => call(op, params, 5000), `#${claim.serverId}`, sealed, {
      cap: ['wake.catcher', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite'], feature: 'recover sleeping node routing', sealedRequired: true,
    });
    if (refusal) throw new Error(refusal.message);
    const key = await effect(() => nodeWakeKey(db, claim.serverId));
    if (!key) throw new Error('Node wake maintenance requires the persisted credential');
    const catcher = await effect(() => deps.ensure(claim.serverId, key, deps.signal));
    const ready = await verifyNodeReadiness((op, params, _sink, options) => call(op, params, options?.timeoutMs),
      { targets: [{ id: catcher.id, name: 'ninedeploy-wake' }], mode: 'tcp', port: 8080, path: '/' }, 15_000,
      async () => { await checkpoint(); }, deps.log ?? (() => undefined));
    await checkpoint();
    if (!ready) throw new Error('Node wake catcher readiness is unconfirmed');
    await recordNodeWakeMaintenanceCatcher(db, claim, catcher);
    await effect(() => deps.route(claim.serverId, deps.signal));
    await confirmNodeWakeMaintenanceRouting(db, claim);
    const rebound = await completeNodeWakeMaintenance(db, claim);
    return { state: 'completed', rebound };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await holdNodeWakeMaintenance(db, claim, reason);
    return { state: 'held', reason };
  }
}
