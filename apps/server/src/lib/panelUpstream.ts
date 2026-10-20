import { existsSync } from 'node:fs';
import os from 'node:os';
import { config } from '../config.js';
import { NETWORK, TRAEFIK_CONTAINER } from '../engine/dockerNames.js';
import { capture } from './exec.js';

/**
 * 0.16.11 scale to zero: how Traefik reaches the panel's wake endpoint, and
 * whether it can.
 *
 * Traefik runs on the `ninedeploy` bridge and reaches the host as
 * `host.docker.internal`. That reaches the panel when it listens on every
 * address (bare metal, and Docker installs since 0.16). A Docker install
 * from before 0.16 publishes the panel on loopback only, which Traefik
 * cannot reach; there the panel container joins the `ninedeploy` network as
 * `ninedeploy-panel` and is reached by that name. The join happens only
 * when something is about to sleep (an upgrade changes nothing), and is
 * read back at boot so a sleeping service's routes stay right after a
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

/** Where Traefik sends a sleeping service's requests. */
export function panelWakeUpstream(): string {
  return onNetwork ? `http://${PANEL_ALIAS}:${config.port}` : `http://host.docker.internal:${config.port}`;
}

/** At boot, read only: is the panel container already on the network under its alias? */
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
  if (probed && probed.upstream === panelWakeUpstream() && now - probed.at < (probed.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS)) {
    return probed.ok ? null : unreachable(probed.upstream);
  }
  let upstream = panelWakeUpstream();
  let ok = await traefikReaches(upstream);
  if (!ok && !onNetwork && inContainer()) {
    try {
      await capture('docker', ['network', 'connect', '--alias', PANEL_ALIAS, NETWORK, os.hostname()], { timeoutMs: 15_000 });
      onNetwork = true;
    } catch {
      onNetwork = await detectPanelOnNetwork();
    }
    if (onNetwork) {
      upstream = panelWakeUpstream();
      ok = await traefikReaches(upstream);
    }
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
