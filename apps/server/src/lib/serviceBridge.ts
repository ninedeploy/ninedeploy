/**
 * Per-service Docker bridge lifecycle.
 *
 * Model B: each NineDeploy-managed service gets its own bridge named
 * `nd-svc-<slug>`. The service container and any databases attached to it
 * live on that bridge. Traefik is `connect`ed to every per-slug bridge so it
 * can still reverse-proxy to every service. Result: a service cannot reach
 * other services over the Docker network — the only way in/out is Traefik.
 *
 * The shared `ninedeploy` bridge remains for Traefik + the probe container
 * + any standalone database that is not yet attached to a service.
 *
 * Every helper here is idempotent: safe to call on every deploy.
 */
import { capture, run } from './exec.js';
// From the leaf module, not from `proxy` — importing them from there
// closes a cycle whose top-level `RESERVED_NETWORKS` evaluation crashed
// the server on boot with a temporal-dead-zone ReferenceError.
import { NETWORK, TRAEFIK_CONTAINER } from '../engine/dockerNames.js';

const swallow = (): void => undefined;

/** Canonical name for a service's private bridge. */
export const serviceBridgeName = (slug: string): string => `nd-svc-${slug}`;

/**
 * Make sure `nd-svc-<slug>` exists and Traefik is on it. Creates the bridge
 * if missing, then connects Traefik if it is not already a member. No-op when
 * both are true. Errors are surfaced; the deploy must not silently fall back
 * to a shared mesh (that would defeat the isolation).
 */
export async function ensureServiceBridge(slug: string, log: (line: string) => void): Promise<string> {
  const name = serviceBridgeName(slug);
  const list = await capture('docker', ['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']);
  if (!list.includes(name)) {
    log(`creating per-service bridge ${name}`);
    await run('docker', ['network', 'create', name], {}, log);
  }
  // Traefik may be down during the first deploy of an instance; in that case
  // `inspect` fails and we treat it as "not connected yet". The next Traefik
  // startup (or next service deploy) will pick it up via `reapTraefikNetworks`.
  const traefikState = await capture('docker', [
    'inspect', TRAEFIK_CONTAINER,
    '--format', '{{json .NetworkSettings.Networks}}',
  ]).catch(() => '');
  if (traefikState && !traefikState.includes(`"${name}"`)) {
    log(`attaching traefik to ${name}`);
    await run('docker', ['network', 'connect', name, TRAEFIK_CONTAINER], {}, log);
  }
  return name;
}

/**
 * Connect a running container to a per-slug bridge. Idempotent. No-op when
 * already connected.
 */
export async function connectContainerToServiceBridge(
  container: string,
  slug: string,
  log: (line: string) => void,
): Promise<void> {
  const name = serviceBridgeName(slug);
  const state = await capture('docker', [
    'inspect', container, '--format', '{{json .NetworkSettings.Networks}}',
  ]).catch(() => '');
  if (state && state.includes(`"${name}"`)) return;
  log(`connecting ${container} to ${name}`);
  await run('docker', ['network', 'connect', name, container], {}, log);
}

/**
 * Re-attach Traefik to every existing per-slug bridge. Called on Traefik
 * (re)start so a Traefik restart does not silently lose routing to services
 * that joined the per-slug mesh while the previous instance was down.
 */
export async function reapTraefikNetworks(log: (line: string) => void): Promise<void> {
  // Per-slug bridges (`nd-svc-*`) plus compose project defaults
  // (`ndcmp-<slug>_default`) — both must survive a Traefik restart.
  //
  // Docker's `--filter name=<value>` is a SUBSTRING match, not a regex:
  // the `^` and `$` anchors are literal characters. `name=^nd-svc-` would
  // only match a network whose name literally contains the string `^nd-svc-`
  // (none in practice), so the filter silently returned zero bridges and
  // Traefik was never re-attached after a restart. Strip the anchors and
  // match the real bridge shapes NineDeploy creates.
  const nameFilters = ['nd-svc-', 'ndcmp-'];
  const bridges: string[] = [];
  for (const filter of nameFilters) {
    const ls = await capture('docker', [
      'network', 'ls', '--filter', `name=${filter}`, '--format', '{{.Name}}',
    ]).catch(() => '');
    bridges.push(...ls.split('\n').map((s) => s.trim()).filter(Boolean));
  }
  for (const name of bridges) {
    const state = await capture('docker', [
      'inspect', TRAEFIK_CONTAINER,
      '--format', '{{json .NetworkSettings.Networks}}',
    ]).catch(() => '');
    if (state && !state.includes(`"${name}"`)) {
      log(`re-attaching traefik to ${name}`);
      await run('docker', ['network', 'connect', name, TRAEFIK_CONTAINER], {}, log).catch(() => undefined);
    }
  }
}

/**
 * Attach Traefik to a compose project's default network
 * (`ndcmp-<slug>_default`) so the dynamic config can target the stack's main
 * container by name. Idempotent; safe on every deploy. Tolerates a missing
 * Traefik (first-boot reaping attaches later).
 */
export async function connectTraefikToComposeNetwork(slug: string, log: (line: string) => void): Promise<void> {
  const name = `ndcmp-${slug}_default`;
  const state = await capture('docker', [
    'inspect', TRAEFIK_CONTAINER,
    '--format', '{{json .NetworkSettings.Networks}}',
  ]).catch(() => '');
  if (!state || state.includes(`"${name}"`)) return;
  log(`attaching traefik to ${name}`);
  await run('docker', ['network', 'connect', name, TRAEFIK_CONTAINER], {}, log);
}

/**
 * Remove the per-slug bridge if it has no non-Traefik endpoints. Disconnects
 * Traefik first (required to remove a network with active members), then
 * inspects the bridge. Safe to call when the bridge is already gone.
 */
export async function removeServiceBridgeIfEmpty(slug: string, log: (line: string) => void): Promise<void> {
  const name = serviceBridgeName(slug);
  // Traefik must be off the bridge before we can `network rm` it. Tolerate
  // the case where Traefik is not connected to this bridge.
  await run('docker', ['network', 'disconnect', name, TRAEFIK_CONTAINER], {}, swallow).catch(() => undefined);
  // Count non-Traefik endpoints; if zero, the bridge is reapable.
  const members = await capture('docker', [
    'network', 'inspect', name, '--format', '{{range .Containers}}{{.Name}} {{end}}',
  ]).catch(() => '');
  const hasNonTraefik = members
    .split(/\s+/)
    .filter(Boolean)
    .some((c) => c !== TRAEFIK_CONTAINER);
  if (hasNonTraefik) {
    // Reconnect Traefik (we just disconnected) and leave the bridge in place.
    await run('docker', ['network', 'connect', name, TRAEFIK_CONTAINER], {}, swallow).catch(() => undefined);
    return;
  }
  try {
    await run('docker', ['network', 'rm', name], {}, log);
    log(`removed per-service bridge ${name}`);
  } catch (err) {
    // Re-attach Traefik even on failure so we do not leave routing half-broken.
    await run('docker', ['network', 'connect', name, TRAEFIK_CONTAINER], {}, swallow).catch(() => undefined);
    throw err;
  }
}

/**
 * Networks the panel and probe container live on. After Model B, only the
 * shared `ninedeploy` mesh and any per-slug bridge that the probe needs
 * should be returned. Today the probe stays on `ninedeploy`; callers that
 * need to also attach it to a per-slug bridge for cross-network health
 * probes can call `connectContainerToServiceBridge` directly.
 */
export const RESERVED_NETWORKS = [NETWORK] as const;
