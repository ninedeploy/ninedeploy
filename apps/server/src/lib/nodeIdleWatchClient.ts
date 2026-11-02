import type { DB } from '@ninedeploy/db';
import { idleWatchOpen, idleWatchSnapshot, type IdleWatchOpen } from '@ninedeploy/schemas';
import { openNodeTrafficObservation, type NodeObservationOptions } from './nodeTrafficObservationClient.js';

/** Long idle windows are chained by the panel, never consumed as autoscale receipts. */
export function openNodeIdleWatch(db: DB, params: IdleWatchOpen, options: NodeObservationOptions = {}) {
  return openNodeTrafficObservation(db, params, {
    parseInput: value => idleWatchOpen.parse(value), parseSnapshot: value => idleWatchSnapshot.parse(value),
    cap: 'proxy.idleWatch', frame: 'ND-IDLE-WATCH ',
  }, options);
}
