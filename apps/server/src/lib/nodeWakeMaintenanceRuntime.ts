import { eq, nodeProxyWriteHeads, type DB } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { prepareNodeWakeCatcher, retireNodeWakeCatcher } from './nodeWakeCatcherClient.js';
import { renderDynamicConfig, writeDynamicConfig } from '../engine/proxy.js';
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
    retire: async (requireNode, target, verify, signal) => {
      let receipt: Awaited<ReturnType<typeof retireNodeWakeCatcher>> | undefined;
      await verify();
      await writeDynamicConfig(db, { requireNode, confirmNodeRouting: true, requireOrderedNode: true, signal, onNodeConfirmed: async () => {
        await verify();
        const head = await db.query.nodeProxyWriteHeads.findFirst({ where: eq(nodeProxyWriteHeads.serverId, requireNode) });
        if (!head?.contentHash) throw new Error('Node wake retirement routing authority unavailable');
        const content = await renderDynamicConfig(db, { serverId: requireNode });
        await verify();
        receipt = await retireNodeWakeCatcher(db, requireNode, target, { revision: head.revision, requestId: head.requestId, content }, signal);
        await verify();
      } });
      if (!receipt) throw new Error('Node wake retirement was not confirmed');
      return receipt;
    },
    ...options,
  };
}
