import type { DB } from '@ninedeploy/db';
import { servingTrafficOpen, servingTrafficSnapshot, type ServingTrafficOpen } from '@ninedeploy/schemas';
import { consumeNodeServingTraffic } from './nodeServingTrafficReceipt.js';
import { openNodeTrafficObservation, type NodeObservationOptions } from './nodeTrafficObservationClient.js';

/** Autoscale observations are consumed durably before returning their final receipt. */
export function openNodeServingTraffic(db: DB, params: ServingTrafficOpen, options: NodeObservationOptions = {}) {
  return openNodeTrafficObservation(db, params, {
    parseInput: value => servingTrafficOpen.parse(value), parseSnapshot: value => servingTrafficSnapshot.parse(value),
    cap: 'proxy.servingTraffic', frame: 'ND-SERVING-TRAFFIC ',
    complete: (input, snapshot, timing) => consumeNodeServingTraffic(db, input, snapshot, timing),
  }, options);
}
