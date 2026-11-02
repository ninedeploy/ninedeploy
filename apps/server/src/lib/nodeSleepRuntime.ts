import type { DB } from '@ninedeploy/db';
import { nodeWakeRuntime } from './nodeWakeRuntime.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import type { NodeSleepControllerDeps } from './nodeSleepController.js';

/** Internal adapter; automatic node sleep remains gated until hosted acceptance. */
export function nodeSleepRuntime(db: DB, options: { signal?: AbortSignal; log?: (line: string) => void } = {}): NodeSleepControllerDeps {
  return { ...nodeWakeRuntime(db, options),
    route: (requireNode, wakePromotion, signal) => writeDynamicConfig(db, { requireNode, confirmNodeRouting: true, requireOrderedNode: true, ...(wakePromotion ? { wakePromotion } : {}), signal }),
    drain: signal => new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal!.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, 2000);
      if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true });
    }),
  };
}
