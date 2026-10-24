import type { AgentOpModule } from './index.js';
import { nodeProxyTraffic } from '../lib/nodeProxyTraffic.js';

/** These are log observations, not a claim that node canary rollout is enabled. */
export const proxyTrafficOps: AgentOpModule = {
  name: 'proxyTraffic', caps: ['proxy.traffic'],
  ops: {
    'proxy.traffic.open': { cap: 'proxy.traffic', sealedOnly: true, async run(params, sink) {
      sink(`ND-PROXY-TRAFFIC ${JSON.stringify({ kind: 'open', snapshot: await nodeProxyTraffic.open(params) })}`); return 0;
    } },
    'proxy.traffic.sample': { cap: 'proxy.traffic', sealedOnly: true, async run(params, sink) {
      sink(`ND-PROXY-TRAFFIC ${JSON.stringify({ kind: 'sample', items: await nodeProxyTraffic.sample(params) })}`); return 0;
    } },
    'proxy.traffic.finish': { cap: 'proxy.traffic', sealedOnly: true, async run(params, sink) {
      sink(`ND-PROXY-TRAFFIC ${JSON.stringify({ kind: 'finish', snapshot: await nodeProxyTraffic.finish(params) })}`); return 0;
    } },
    'proxy.traffic.close': { cap: 'proxy.traffic', sealedOnly: true, async run(params, sink) {
      sink(`ND-PROXY-TRAFFIC ${JSON.stringify({ kind: 'close', ...nodeProxyTraffic.close(params) })}`); return 0;
    } },
  },
};
