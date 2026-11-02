import type { AgentOpModule } from './index.js';
import { nodeIdleWatch } from '../lib/nodeIdleWatch.js';

/** Observation only; node scale to zero stays disabled until the panel side is accepted. */
export const idleWatchOps: AgentOpModule = {
  name: 'idleWatch', caps: ['proxy.idleWatch'],
  ops: {
    'proxy.idleWatch.open': { cap: 'proxy.idleWatch', sealedOnly: true, async run(params, sink) {
      sink(`ND-IDLE-WATCH ${JSON.stringify({ kind: 'open', snapshot: await nodeIdleWatch.open(params) })}`); return 0;
    } },
    'proxy.idleWatch.sample': { cap: 'proxy.idleWatch', sealedOnly: true, async run(params, sink) {
      sink(`ND-IDLE-WATCH ${JSON.stringify({ kind: 'sample', items: await nodeIdleWatch.sample(params) })}`); return 0;
    } },
    'proxy.idleWatch.finish': { cap: 'proxy.idleWatch', sealedOnly: true, async run(params, sink) {
      sink(`ND-IDLE-WATCH ${JSON.stringify({ kind: 'finish', snapshot: await nodeIdleWatch.finish(params) })}`); return 0;
    } },
    'proxy.idleWatch.close': { cap: 'proxy.idleWatch', sealedOnly: true, async run(params, sink) {
      sink(`ND-IDLE-WATCH ${JSON.stringify({ kind: 'close', ...nodeIdleWatch.close(params) })}`); return 0;
    } },
  },
};
