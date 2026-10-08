/**
 * Docker object names the platform owns.
 *
 * These live in their own leaf module — it imports nothing — because both
 * `engine/proxy.ts` and `lib/serviceBridge.ts` need them and those two import
 * each other. When the constants lived in `proxy.ts`, that cycle was a boot
 * crash rather than a style problem: `serviceBridge.ts` evaluates
 * `RESERVED_NETWORKS = [NETWORK]` at module scope, so whenever the entry graph
 * reached `serviceBridge` first, `NETWORK` was still in its temporal dead zone
 * and the server exited with
 *
 *   ReferenceError: Cannot access 'NETWORK' before initialization
 *
 * on every start. TypeScript cannot see it (the types are fine) and the test
 * suites happened to load `proxy` first, so it only ever surfaced in
 * production. A module with no imports can never be half-initialised, which
 * removes the hazard rather than reordering around it.
 *
 * `proxy.ts` re-exports all three, so existing `from '../engine/proxy.js'`
 * imports keep working.
 */

/** The Traefik container the panel manages. */
export const TRAEFIK_CONTAINER = 'ninedeploy-traefik';

/**
 * Stay on Traefik v3 major — minor/patch updates are pulled automatically.
 * Pin to a specific version only if you need reproducibility (e.g. "traefik:v3.3").
 */
export const TRAEFIK_IMAGE = 'traefik:3';

/** Shared Docker network that app + database containers join to reach each other. */
export const NETWORK = 'ninedeploy';

/** Hard ceiling on per-service replicas — a typo of 1000 must not eat the host. */
export const MAX_REPLICAS = 10;

/**
 * Deterministic replica names for a deployment generation: the primary
 * container keeps its own name; extras get `-r2` … `-rN` suffixes. Deriving
 * them (instead of storing them) means every consumer — Traefik render,
 * reconcile, stop/start — agrees without new state to keep consistent.
 */
export function replicaNames(runtimeId: string, replicas: number): string[] {
  const n = Math.max(1, Math.min(Math.floor(replicas) || 1, MAX_REPLICAS));
  const names = [runtimeId];
  for (let i = 2; i <= n; i++) names.push(`${runtimeId}-r${i}`);
  return names;
}

/**
 * r593: labels every application container the docker builder starts carries,
 * so boot recovery can find the containers an interrupted deployment had
 * already started (a blue-green candidate the dead pipeline never retired)
 * without guessing from names. Containers started before 0.10.38 carry none
 * and are never touched by that cleanup.
 */
export const DEPLOYMENT_LABEL = 'ninedeploy.deployment';
export const SERVICE_LABEL = 'ninedeploy.service';

/** The `key=value` label pairs for one deployment's containers. */
export function deploymentLabels(deploymentId: number, serviceId: number | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [[DEPLOYMENT_LABEL, String(deploymentId)]];
  if (typeof serviceId === 'number') out.push([SERVICE_LABEL, String(serviceId)]);
  return out;
}

/**
 * 0.14: the per-database public-access sidecar (`nd-dbpub-<slug>`), a Traefik
 * TCP proxy that publishes one host port in front of a managed database
 * (`lib/publicDatabaseAccess.ts`). The label carries the database id so the
 * watchdog can find (and remove) orphans without guessing from names; the
 * config label is the sha256 over the static config, the host port and the
 * image, so a port or image change is never mistaken for "already running".
 */
export const DBPUB_CONTAINER_PREFIX = 'nd-dbpub-';
export const PUBLIC_DB_LABEL = 'ninedeploy.public-db';
export const DBPUB_CONFIG_LABEL = 'ninedeploy.dbpub.config-sha';
