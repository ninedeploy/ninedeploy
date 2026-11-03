import type { DB } from '@ninedeploy/db';
import { nodeWakeRuntime } from './nodeWakeRuntime.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import type { NodeSleepControllerDeps } from './nodeSleepController.js';

/** Internal adapter; automatic node sleep remains gated until hosted acceptance. */
export function nodeSleepRuntime(db: DB, options: { signal?: AbortSignal; log?: (line: string) => void } = {}): NodeSleepControllerDeps {
  return { ...nodeWakeRuntime(db, options),
    route: (requireNode, wakePromotion, signal, settle) => {
      if (wakePromotion && !settle) return Promise.reject(new Error('Node sleep restoration requires settlement'));
      return writeDynamicConfig(db, { requireNode, confirmNodeRouting: true, requireOrderedNode: true,
        ...(wakePromotion ? { wakePromotion, onWakeConfirmed: settle } : {}), signal });
    },
    drain: signal => new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal!.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, 2000);
      if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true });
    }),
  };
}
