/**
 * Single source of truth for the NineDeploy-managed Docker namespace.
 *
 * Network and container names NineDeploy owns MUST go through this module —
 * scattered `name.startsWith('nd-svc-')` literals are a refactor trap and the
 * place where the deletion guard story is most likely to drift.
 *
 * Two predicates:
 *   - `isManagedNetwork(name)` — names NineDeploy creates and re-attaches every
 *     service to. Deletion would break the shared mesh and the panel's DNS.
 *   - `isManagedContainer(name)` — prefixes NineDeploy uses for app/database
 *     containers, plus the panel's own containers. Detaching these from a
 *     network can break routing or the service's own DB link.
 *
 * Use the typed error `ManagedNamespaceError` for 409s so the audit log and
 * the UI message line up.
 */
import { NETWORK, TRAEFIK_CONTAINER } from '../engine/proxy.js';

/**
 * Networks NineDeploy creates and depends on. Deletion is forbidden.
 * - `ninedeploy`: the shared mesh (Traefik + probe container + any standalone
 *   database that has no service attached yet).
 * - `nd-svc-<slug>`: a per-service private bridge created by
 *   `lib/serviceBridge.ts`. Each managed service runs on exactly one of
 *   these; deleting it would either break Traefik routing (still possible,
 *   Traefik auto-discovers) or break the service's own DB connectivity.
 */
export const MANAGED_NETWORKS: ReadonlySet<string> = new Set([NETWORK]);
const PER_SERVICE_BRIDGE_PREFIX = /^nd-svc-/;

/** Container-name prefixes NineDeploy reserves for its own fleet. */
const MANAGED_CONTAINER_PREFIXES: readonly RegExp[] = [
  /^nd-svc-/, // service app containers (engine/builders/docker.ts, modules/databases.ts)
  /^nd-db-/, // database containers (modules/databases.ts, engine/database.ts)
];

/** Container-name literals that are managed but don't follow a prefix. */
const MANAGED_CONTAINER_LITERALS: ReadonlySet<string> = new Set([
  TRAEFIK_CONTAINER, // 'ninedeploy-traefik'
  NETWORK, // the panel container itself, when NineDeploy is run as a container
]);

/** True when the given Docker network name is owned by NineDeploy. */
export function isManagedNetwork(name: string): boolean {
  if (MANAGED_NETWORKS.has(name)) return true;
  if (PER_SERVICE_BRIDGE_PREFIX.test(name)) return true;
  return false;
}

/** True when the given Docker container name is owned by NineDeploy. */
export function isManagedContainer(name: string): boolean {
  if (MANAGED_CONTAINER_LITERALS.has(name)) return true;
  return MANAGED_CONTAINER_PREFIXES.some((re) => re.test(name));
}

/**
 * Thrown when a route tries to act on a managed network or container in a way
 * that would break NineDeploy. The route maps it to a 409 with this message.
 */
export class ManagedNamespaceError extends Error {
  readonly kind: 'network' | 'container';
  readonly target: string;
  constructor(kind: 'network' | 'container', target: string, message: string) {
    super(message);
    this.name = 'ManagedNamespaceError';
    this.kind = kind;
    this.target = target;
  }
}
