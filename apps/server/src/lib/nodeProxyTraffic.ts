import { proxyTrafficOpen, proxyTrafficSnapshot, type ProxyTrafficOpen, type ProxyTrafficSnapshot } from '@ninedeploy/schemas';
import { ProxyTrafficCounter } from './proxyTrafficCounter.js';
import { nodeProxyTrafficDocker, type NodeProxyTrafficIO } from './nodeProxyTrafficDocker.js';
import { NodeTrafficObservation, trafficObservationsEnabled } from './nodeTrafficObservation.js';
export { PROXY_TRAFFIC_MAX_SESSIONS } from './nodeTrafficObservation.js';

/** Canary observations retain their original operands and receipt format. */
export class NodeProxyTraffic extends NodeTrafficObservation<ProxyTrafficOpen, ProxyTrafficSnapshot> {
  constructor(io: NodeProxyTrafficIO, now = () => performance.now(), enabled = () => true) {
    super(io, { parse: value => proxyTrafficOpen.parse(value), counter: (input, id) => new ProxyTrafficCounter(input, id),
      snapshot: (input, fields) => proxyTrafficSnapshot.parse({ ...fields, step: input.step }) }, now, enabled);
  }
}
export const nodeProxyTraffic = new NodeProxyTraffic(nodeProxyTrafficDocker(), () => performance.now(), trafficObservationsEnabled);
