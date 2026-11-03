import type { DB } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { prepareNodeWakeCatcher } from './nodeWakeCatcherClient.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { settleNodeCatcherRoutePromotion } from './nodeCatcherRoutePromotion.js';
import type { NodeWakeMaintenanceDeps } from './nodeWakeMaintenanceController.js';

export function nodeWakeMaintenanceRuntime(db: DB, options: { signal?: AbortSignal; log?: (line: string) => void } = {}): NodeWakeMaintenanceDeps {
  return {
    agent: (node, op, params, callOptions) => agentOp(db, node, op, params, () => undefined, callOptions),
    sealed: node => agentTransportSealed(db, node, options.signal),
    ensure: (node, key, signal) => prepareNodeWakeCatcher(db, node, key, signal),
    route: async (requireNode, catcherPromotion, signal) => {
      let rebound: number | undefined;
      await writeDynamicConfig(db, { requireNode, confirmNodeRouting: true, requireOrderedNode: true, catcherPromotion, signal,
        onCatcherConfirmed: async () => { rebound = await settleNodeCatcherRoutePromotion(catcherPromotion, requireNode); } });
      if (rebound === undefined) throw new Error('Node catcher routing was not settled');
      return rebound;
    },
    ...options,
  };
}
