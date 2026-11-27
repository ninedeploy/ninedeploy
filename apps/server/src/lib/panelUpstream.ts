import { existsSync } from 'node:fs';
import os from 'node:os';
import { config } from '../config.js';
import { NETWORK, TRAEFIK_CONTAINER } from '../engine/dockerNames.js';
import { capture } from './exec.js';

/**
 * How Traefik reaches the panel itself: the router of the panel's own
 * domain, the forward-auth verify endpoint and the wake endpoint (0.16.11,
 * scale to zero).
 *
 * Traefik runs on the `ninedeploy` bridge and reaches the host as
 * `host.docker.internal`. That reaches the panel when its port is published
 * on every address at the port the container listens on (bare metal, and
 * Docker installs since 0.16). It does not when the panel is bound to
 * loopback, is published on another port, or is not published at all. There
 * the panel container joins the `ninedeploy` network as `ninedeploy-panel`
 * and is reached by that name.
 *
 * When the panel joins:
 *   - at boot and from the proxy's watchdog, once a panel domain is set: the
 *     domain must answer whatever address the port is published on;
 *   - when something is about to sleep, if it has not joined yet: an install
 *     without a panel domain changes nothing until then.
 * The attachment is read back at boot, so the routes stay right after a
 * restart.
 *
 * Nothing sleeps unless a request from inside the Traefik container reaches
 * the panel's /health: a service that could not be woken must never sleep.
 */

export const PANEL_ALIAS = 'ninedeploy-panel';
/** A reachability answer is reused this long (a failure for a minute). */
const PROBE_OK_TTL_MS = 5 * 60_000;
const PROBE_FAIL_TTL_MS = 60_000;

let onNetwork = false;
let probed: { at: number; ok: boolean; upstream: string } | null = null;

const inContainer = (): boolean => existsSync('/.dockerenv');

/** Whether the panel itself runs in a container: only then can it join a Docker network. */
export function panelRunsInContainer(): boolean {
  return inContainer();
}

/** Where Traefik sends the requests it has for the panel itself. */
export function traefikPanelUpstream(): string {
  return onNetwork ? `http://${PANEL_ALIAS}:${config.port}` : `http://host.docker.internal:${config.port}`;
}

/** Whether the panel container is on the network under its alias, as last read. */
export function panelOnNetwork(): boolean {
  return onNetwork;
}

/** Read: is the panel container on the network under its alias? Sets the answer. */
export async function detectPanelOnNetwork(): Promise<boolean> {
  if (!inContainer()) return false;
  try {
    const out = await capture('docker', ['inspect', os.hostname(), '--format', `{{json (index .NetworkSettings.Networks "${NETWORK}")}}`], { timeoutMs: 10_000 });
    onNetwork = out.includes(`"${PANEL_ALIAS}"`);
  } catch {
    onNetwork = false;
  }
  return onNetwork;
}

/**
 * Join the panel container to the network under its alias. True when the
 * panel is on the network afterwards, which it may already have been. False
 * outside a container or when Docker did not do it; nothing changed then.
 * A join Docker refuses is read back: the container may be attached already.
 */
export async function joinPanelNetwork(): Promise<boolean> {
  if (!inContainer()) return false;
  if (onNetwork) return true;
  try {
    await capture('docker', ['network', 'connect', '--alias', PANEL_ALIAS, NETWORK, os.hostname()], { timeoutMs: 15_000 });
    onNetwork = true;
  } catch {
    onNetwork = await detectPanelOnNetwork();
  }
  return onNetwork;
}

async function traefikReaches(upstream: string): Promise<boolean> {
  try {
    await capture('docker', ['exec', TRAEFIK_CONTAINER, 'wget', '-q', '-O', '/dev/null', '-T', '3', `${upstream}/health`], { timeoutMs: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether Traefik can reach the wake endpoint, joining the panel container
 * to the network first when the host address does not work. Null when it
 * can; otherwise why not, for the hold reason.
 */
export async function wakeUnreachableReason(now: number = Date.now()): Promise<string | null> {
  if (probed && probed.upstream === traefikPanelUpstream() && now - probed.at < (probed.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS)) {
    return probed.ok ? null : unreachable(probed.upstream);
  }
  let upstream = traefikPanelUpstream();
  let ok = await traefikReaches(upstream);
  if (!ok && !onNetwork && inContainer() && (await joinPanelNetwork())) {
    upstream = traefikPanelUpstream();
    ok = await traefikReaches(upstream);
  }
  probed = { at: now, ok, upstream };
  return ok ? null : unreachable(upstream);
}

const unreachable = (upstream: string): string =>
  `Traefik cannot reach the panel at ${upstream}, so a sleeping service could not wake. Publish the panel port on every address (NINEDEPLOY_BIND=0.0.0.0) or run the panel container on the ${NETWORK} network`;

/** Tests only. */
export function resetPanelUpstream(state: { onNetwork?: boolean } = {}): void {
  onNetwork = state.onNetwork ?? false;
  probed = null;
}
