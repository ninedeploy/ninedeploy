import { idleWatchOpen, idleWatchSnapshot, type IdleWatchOpen, type IdleWatchSnapshot } from '@ninedeploy/schemas';
import { ServingTrafficCounter } from './proxyTrafficCounter.js';
import { nodeProxyTrafficDocker, type NodeProxyTrafficIO } from './nodeProxyTrafficDocker.js';
import { NodeTrafficObservation, trafficObservationsEnabled } from './nodeTrafficObservation.js';

/**
 * R2 node scale to zero (docs/NODE_SLEEP_WAKE.md): one long serving window per request, kept
 * alive by `sample` (the shared engine releases a window not sampled within 30 s). A lapsed,
 * restarted or changed source ends the window; only a finished, complete receipt shows idle.
 */
export class NodeIdleWatch extends NodeTrafficObservation<IdleWatchOpen, IdleWatchSnapshot> {
  constructor(io: NodeProxyTrafficIO<IdleWatchOpen>, now = () => performance.now(), enabled = () => true) {
    super(io, { markerTiming: true, parse: value => idleWatchOpen.parse(value), counter: (input, id) => new ServingTrafficCounter(input, id),
      snapshot: (input, fields) => idleWatchSnapshot.parse({ ...fields, purpose: input.purpose }) }, now, enabled);
  }
}
export const nodeIdleWatch = new NodeIdleWatch(nodeProxyTrafficDocker(), () => performance.now(), trafficObservationsEnabled);
