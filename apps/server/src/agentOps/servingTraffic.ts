import type { AgentOpModule } from './index.js';
import { nodeServingTraffic } from '../lib/nodeServingTraffic.js';

/** Observation only; the panel's RPS autoscaler remains disabled. */
export const servingTrafficOps: AgentOpModule = {
  name: 'servingTraffic', caps: ['proxy.servingTraffic'],
  ops: {
    'proxy.servingTraffic.open': { cap: 'proxy.servingTraffic', sealedOnly: true, async run(params, sink) {
      sink(`ND-SERVING-TRAFFIC ${JSON.stringify({ kind: 'open', snapshot: await nodeServingTraffic.open(params) })}`); return 0;
    } },
    'proxy.servingTraffic.sample': { cap: 'proxy.servingTraffic', sealedOnly: true, async run(params, sink) {
      sink(`ND-SERVING-TRAFFIC ${JSON.stringify({ kind: 'sample', items: await nodeServingTraffic.sample(params) })}`); return 0;
    } },
    'proxy.servingTraffic.finish': { cap: 'proxy.servingTraffic', sealedOnly: true, async run(params, sink) {
      sink(`ND-SERVING-TRAFFIC ${JSON.stringify({ kind: 'finish', snapshot: await nodeServingTraffic.finish(params) })}`); return 0;
    } },
    'proxy.servingTraffic.close': { cap: 'proxy.servingTraffic', sealedOnly: true, async run(params, sink) {
      sink(`ND-SERVING-TRAFFIC ${JSON.stringify({ kind: 'close', ...nodeServingTraffic.close(params) })}`); return 0;
    } },
  },
};
