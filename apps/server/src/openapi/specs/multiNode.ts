import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment for the multi-node routes (design §1.3, §4.3, §6.6,
 * §7.5). Every key here must name a live route (authzMatrix `ROUTE_SPECS`
 * coverage case) and its floor must equal the route's MATRIX floor.
 *
 * T1 creates it empty; each task fills only its own labelled block, in the
 * same change that registers the route. A route a task adds to an existing
 * module (for example `POST /v1/volumes`) is documented here too, so the
 * pre-0.16 fragments stay frozen.
 */
export const multiNodeSpecs: RouteSpecMap = {
  // ── 0.16 T2 agent transport ──
  // ── end 0.16 T2 ──
  // ── 0.16 T3 node builds and private clones ──
  // ── end 0.16 T3 ──
  // ── 0.16 T4 build placement ──
  // ── end 0.16 T4 ──
  // ── 0.16 T5 node volumes ──
  // ── end 0.16 T5 ──
  // ── 0.16 T6 node databases ──
  // ── end 0.16 T6 ──
  // ── 0.16 T7 swarm ──
  // ── end 0.16 T7 ──
};
