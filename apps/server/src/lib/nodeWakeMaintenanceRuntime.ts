import type { DB } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { ensureNodeWakeCatcher } from './nodeWakeCatcherClient.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import type { NodeWakeMaintenanceDeps } from './nodeWakeMaintenanceController.js';

export function nodeWakeMaintenanceRuntime(db: DB, options: { signal?: AbortSignal; log?: (line: string) => void } = {}): NodeWakeMaintenanceDeps {
  return {
    agent: (node, op, params, callOptions) => agentOp(db, node, op, params, () => undefined, callOptions),
    sealed: node => agentTransportSealed(db, node, options.signal),
    ensure: (node, key, signal) => ensureNodeWakeCatcher(db, node, key, signal),
    route: (requireNode, signal) => writeDynamicConfig(db, { requireNode, confirmNodeRouting: true, requireOrderedNode: true, signal }),
    ...options,
  };
}
