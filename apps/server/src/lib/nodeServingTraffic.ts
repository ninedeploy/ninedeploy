import { servingTrafficOpen, servingTrafficSnapshot, type ServingTrafficOpen, type ServingTrafficSnapshot } from '@ninedeploy/schemas';
import { ServingTrafficCounter } from './proxyTrafficCounter.js';
import { nodeProxyTrafficDocker, type NodeProxyTrafficIO } from './nodeProxyTrafficDocker.js';
import { NodeTrafficObservation, trafficObservationsEnabled } from './nodeTrafficObservation.js';

/** Ordinary serving generations have no synthetic canary release or step. */
export class NodeServingTraffic extends NodeTrafficObservation<ServingTrafficOpen, ServingTrafficSnapshot> {
  constructor(io: NodeProxyTrafficIO<ServingTrafficOpen>, now = () => performance.now(), enabled = () => true) {
    super(io, { markerTiming: true, parse: value => servingTrafficOpen.parse(value), counter: (input, id) => new ServingTrafficCounter(input, id),
      snapshot: (input, fields) => servingTrafficSnapshot.parse({ ...fields, purpose: input.purpose }) }, now, enabled);
  }
}
export const nodeServingTraffic = new NodeServingTraffic(nodeProxyTrafficDocker(), () => performance.now(), trafficObservationsEnabled);
