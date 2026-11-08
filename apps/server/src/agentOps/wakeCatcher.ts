import type { AgentOpModule } from './index.js';
import { HttpError } from '../lib/errors.js';
import { ensureWakeCatcher, inventoryWakeCatchers, prepareWakeCatcher, readWakeDemand, removeWakeCatcher } from '../lib/nodeWakeCatcher.js';
import { retireWakeCatcher } from '../lib/nodeWakeCatcherRetirement.js';

/** R2 node scale to zero: the node's wake catcher. Every reply is one `ND-WAKE-CATCHER {…}` line. */
const REPLY = 'ND-WAKE-CATCHER ';
async function answer(onLine: (line: string) => void, action: () => Promise<unknown>): Promise<number> {
  try {
    onLine(`${REPLY}${JSON.stringify(await action())}`);
    return 0;
  } catch (err) {
    const failure = err instanceof HttpError ? err : new HttpError(502, 'wake_catcher_failed', (err instanceof Error ? err.message : String(err)).slice(0, 500));
    onLine(`${REPLY}${JSON.stringify({ error: { status: failure.statusCode, code: failure.code, message: failure.message } })}`);
    return 1;
  }
}

export const wakeCatcherOps: AgentOpModule = {
  name: 'wakeCatcher', caps: ['wake.catcher', 'wake.catcher.inventory', 'wake.catcher.prepare', 'wake.catcher.retire'],
  ops: {
    'wake.catcher.inventory': { cap: 'wake.catcher.inventory', sealedOnly: true, run: (params, sink) => answer(sink, () => inventoryWakeCatchers(params)) },
    'wake.catcher.prepare': { cap: 'wake.catcher.prepare', sealedOnly: true, run: (params, sink) => answer(sink, () => prepareWakeCatcher(params)) },
    'wake.catcher.retire': { cap: 'wake.catcher.retire', sealedOnly: true, run: (params, sink) => answer(sink, () => retireWakeCatcher(params)) },
    'wake.catcher.ensure': { cap: 'wake.catcher', sealedOnly: true, run: (params, sink) => answer(sink, () => ensureWakeCatcher(params)) },
    'wake.catcher.remove': { cap: 'wake.catcher', sealedOnly: true, run: (_params, sink) => answer(sink, () => removeWakeCatcher()) },
    'wake.demand': { cap: 'wake.catcher', sealedOnly: true, run: (params, sink) => answer(sink, () => readWakeDemand(params)) },
  },
};
