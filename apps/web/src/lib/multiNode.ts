import { AGENT_SWARM_MANAGER_VAR, type ServerFeatures, type ServerListEntry } from '@ninedeploy/sdk';

/**
 * Multi-node helpers shared by the Servers page, the service placement cards,
 * the database wizard, the Volumes host switcher and Settings → Swarm.
 *
 * Every field these read is additive: an older panel omits `features`,
 * `agent`, `isBuildServer`, `databases` and the Swarm membership, so each
 * helper treats "absent" as "unknown" and never as "refused".
 */

/** The `features` flags, in display order, with the label the UI shows. */
export const NODE_FEATURES = [
  ['nixpacks', 'Nixpacks'],
  ['railpack', 'Railpack'],
  ['privateClones', 'Private clones'],
  ['volumes', 'Volumes'],
  ['databases', 'Databases'],
  ['imageTransfer', 'Image transfer'],
  ['swarm', 'Swarm'],
] as const satisfies ReadonlyArray<readonly [Exclude<keyof ServerFeatures, 'reason'>, string]>;

/** Labels of the features a node's agent does not offer today (empty when unknown). */
export function missingFeatures(features: ServerFeatures | undefined): string[] {
  if (!features) return [];
  return NODE_FEATURES.filter(([key]) => features[key] === false).map(([, label]) => label);
}

/** Registered nodes (an announced node still waiting for approval is not one). */
export function registeredNodes<T extends Pick<ServerListEntry, 'status'>>(list: readonly T[] | undefined): T[] {
  return (list ?? []).filter((s) => s.status !== 'pending');
}

/** The API error code of a failed SDK call (`NineDeployError.code`), if any. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The message of a failed call, or `fallback`. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The step-up refusals: the password was wrong, or none was given and the sign-in is not fresh. */
export function isStepUpRefusal(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'invalid_password' || code === 'reauth_required';
}

/**
 * The line a node owner adds to the agent's environment to accept Swarm
 * membership (`node_swarm_not_enabled`). `managerAddr` comes from
 * `GET /v1/swarm` and already carries the port.
 */
export function swarmOptInLine(managerAddr: string | null | undefined): string {
  return `${AGENT_SWARM_MANAGER_VAR}=${managerAddr || '<advertise addr>:2377'}`;
}

/** A millisecond duration for the transfer history: "850 ms", "4.2 s", "2m 05s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The ports a swarm needs between its hosts (Settings → Swarm, the Servers page). */
export const SWARM_FIREWALL_PORTS = [
  '2377/tcp (cluster management, manager only)',
  '7946/tcp and 7946/udp (node gossip)',
  '4789/udp (overlay VXLAN traffic)',
  'ESP, IP protocol 50 (encrypted overlays)',
] as const;
