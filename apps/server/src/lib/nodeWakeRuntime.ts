import type { DB } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import type { NodeWakeControllerDeps } from './nodeWakeController.js';

/** Production adapter; the node sleep/poller gate remains disabled until full acceptance. */
export function nodeWakeRuntime(db: DB, options: { signal?: AbortSignal; log?: (line: string) => void } = {}): NodeWakeControllerDeps {
  return {
    agent: (nodeId, op, params, callOptions) => agentOp(db, nodeId, op, params, () => undefined, callOptions),
    sealed: nodeId => agentTransportSealed(db, nodeId, options.signal),
    route: (nodeId, wakePromotion, signal, settle) => writeDynamicConfig(db, { requireNode: nodeId, confirmNodeRouting: true, requireOrderedNode: true, wakePromotion, signal, onWakeConfirmed: settle }),
    ...options,
  };
}
