import type { RouteSpecMap } from '../types.js';
// ── 0.15 T4 openapi (imports) ──
import { authSpecs } from './auth.js';
import { automationSpecs } from './automation.js';
import { databasesSpecs } from './databases.js';
import { deploysSpecs } from './deploys.js';
import { domainsSpecs } from './domains.js';
import { envSpecs } from './env.js';
import { extensionsSpecs } from './extensions.js';
import { infrastructureSpecs } from './infrastructure.js';
import { operationsSpecs } from './operations.js';
import { platformSpecs } from './platform.js';
import { projectsSpecs } from './projects.js';
import { servicesSpecs } from './services.js';
import { settingsSpecs } from './settings.js';
import { traefikSpecs } from './traefik.js';
import { workspacesSpecs } from './workspaces.js';
// ── end 0.15 T4 ──
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
  platform: platformSpecs,
  auth: authSpecs,
  workspaces: workspacesSpecs,
  projects: projectsSpecs,
  services: servicesSpecs,
  deploys: deploysSpecs,
  domains: domainsSpecs,
  env: envSpecs,
  automation: automationSpecs,
  databases: databasesSpecs,
  infrastructure: infrastructureSpecs,
  traefik: traefikSpecs,
  settings: settingsSpecs,
  operations: operationsSpecs,
  extensions: extensionsSpecs,
  // ── end 0.15 T4 ──
  terminals: terminalSpecs,
  traffic: trafficSpecs,
  accessGrants: accessGrantSpecs,
};

export const ROUTE_SPECS: RouteSpecMap = mergeSpecFragments(SPEC_FRAGMENTS);
