import type { RouteSpecMap } from '../types.js';
import { accessGrantSpecs } from './accessGrants.js';
import { terminalSpecs } from './terminals.js';
import { trafficSpecs } from './traffic.js';

/**
 * `ROUTE_SPECS`: every route's OpenAPI description, aggregated from one
 * fragment file per module group (0.15, DESIGN §3.1). Each fragment has one
 * owner; T4 adds the fragments for the routes that existed before 0.15 and
 * lists them here.
 */

/** `METHOD /path`: the authorization matrix's key format. */
const KEY = /^(GET|POST|PUT|PATCH|DELETE|ALL) \/\S*$/;

/** Merge fragments, refusing a malformed key or a key two fragments both claim. */
export function mergeSpecFragments(fragments: Record<string, RouteSpecMap>): RouteSpecMap {
  const out: RouteSpecMap = {};
  const owner = new Map<string, string>();
  for (const [name, fragment] of Object.entries(fragments)) {
    for (const [key, spec] of Object.entries(fragment)) {
      if (!KEY.test(key)) throw new Error(`ROUTE_SPECS: malformed key "${key}" in fragment "${name}"`);
      const prior = owner.get(key);
      if (prior !== undefined) throw new Error(`ROUTE_SPECS: "${key}" is declared by both "${prior}" and "${name}"`);
      owner.set(key, name);
      out[key] = spec;
    }
  }
  return out;
}

export const SPEC_FRAGMENTS: Record<string, RouteSpecMap> = {
  // ── 0.15 T4 openapi (fragments for the routes that predate 0.15) ──
  // ── end 0.15 T4 ──
  terminals: terminalSpecs,
  traffic: trafficSpecs,
  accessGrants: accessGrantSpecs,
};

export const ROUTE_SPECS: RouteSpecMap = mergeSpecFragments(SPEC_FRAGMENTS);
