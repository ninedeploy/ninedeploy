import { eq } from 'drizzle-orm';
import { databases, type DB, services, serviceVolumeAttachments } from '@ninedeploy/db';
import type { MultiNodeCapability } from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { type AgentCaller, type CapabilityRefusal, capabilityRefusal, nodeLabel } from './agentCapabilities.js';
import { HttpError } from './errors.js';

/**
 * Volumes for services placed on nodes (multi-node, design §4).
 *
 * A volume lives on the host of the service that uses it: there is no volume
 * table, a volume is `(serverId | null, name)`. This file holds what the
 * builders and the queue-time refusal share:
 *
 *  - which shape of container needs `docker.runSpec` (a command, the Docker
 *    socket, volume attachments) instead of the 0.15 `docker.runEnv`;
 *  - the refusal for a node docker service of that shape — the agent must
 *    advertise `docker.runSpec` (sealed) and `volume.manage`, and no attached
 *    volume may belong to something on another host;
 *  - creating a missing managed volume on the node before the container or the
 *    compose project starts (D9), labelled like the panel's own volumes.
 *
 * Bind mounts stay unattachable everywhere: only managed names (`nd-svc-*`,
 * `nd-db-*`) ever reach a node op.
 */

/** A managed volume name (the agent's `RE_MANAGED_VOLUME`, schemas `managedVolumeName`). */
export const RE_NODE_MANAGED_VOLUME = /^nd-(?:svc|db)-[a-z0-9][a-z0-9_.-]*$/;
export const isNodeManagedVolume = (name: string): boolean => name.length <= 128 && RE_NODE_MANAGED_VOLUME.test(name);

/** What a refusal says the agent cannot do (nodeFeatureRefusals pins the wording). */
export const NODE_RUN_SPEC_FEATURE = 'run a service with volume attachments, a command or the Docker socket';
export const NODE_VOLUME_CREATE_FEATURE = 'create node volumes';

/** The attachment fields the node paths read (a `service_volume_attachments` row). */
export interface NodeVolumeAttachment {
  volumeName: string;
  containerPath: string;
  readOnly?: boolean | null;
}

/**
 * What a node container needs that `docker.runEnv` has no slot for, as the
 * words a refusal uses. Empty: the 0.15 `docker.runEnv` path runs unchanged.
 */
export function nodeRunNeeds(
  service: { cmd?: string[] | null; dockerSocket?: boolean | null },
  attachments: readonly NodeVolumeAttachment[],
): string[] {
  const needs: string[] = [];
  if (service.cmd?.length) needs.push('a container command');
  if (service.dockerSocket) needs.push('the Docker socket mount');
  if (attachments.length > 0) needs.push('attached volumes');
  return needs;
}

/** The capabilities a node docker service of that shape needs. */
export function nodeRunCapabilities(
  service: { volumeMount?: string | null },
  attachments: readonly NodeVolumeAttachment[],
): MultiNodeCapability[] {
  return attachments.length > 0 || service.volumeMount ? ['docker.runSpec', 'volume.manage'] : ['docker.runSpec'];
}

/**
 * Labels a volume the panel creates on a node carries (design §4.2): the
 * managed marker the node's `docker volume ls --filter label=…` finds after a
 * rollback, the creating user when known, and the service it was made for.
 */
export function nodeVolumeLabels(owner: { serviceId?: number | null; userId?: number | null }): Record<string, string> {
  const labels: Record<string, string> = { 'ninedeploy.managed': 'volume' };
  if (owner.userId != null) labels['ninedeploy.owner'] = String(owner.userId);
  if (owner.serviceId != null) labels['ninedeploy.service'] = String(owner.serviceId);
  return labels;
}

/**
 * Whether a volume exists on the node: `docker.volumeInspect` exits 0 for an
 * existing volume. The builders' caller throws on a non-zero exit, which is
 * how a missing volume answers — so a throw reads as "absent", and the create
 * that follows (idempotent) reports a real transport failure itself.
 */
async function nodeVolumePresent(agent: AgentCaller, name: string): Promise<boolean> {
  try {
    return (await agent('docker.volumeInspect', { name }, () => undefined)).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Create every missing managed volume in `names` on the node, before the
 * container or the compose project that mounts it starts. Mirrors what
 * `docker run -v` does on the panel host (a missing named volume is created),
 * plus labels. Database volumes (`nd-db-*`) are never created here: a node
 * database creates its own and refuses to adopt an existing one, so a missing
 * one is an error the caller reports. Returns the names it created.
 */
export async function ensureNodeVolumes(
  agent: AgentCaller,
  names: readonly string[],
  labels: Record<string, string>,
  log: (line: string) => void,
): Promise<{ created: string[]; missingDatabaseVolumes: string[] }> {
  const created: string[] = [];
  const missingDatabaseVolumes: string[] = [];
  for (const name of [...new Set(names)]) {
    if (!isNodeManagedVolume(name)) throw new Error(`"${name}" is not a managed volume (nd-svc-* or nd-db-*); bind mounts are never attachable`);
    if (await nodeVolumePresent(agent, name)) continue;
    if (name.startsWith('nd-db-')) {
      missingDatabaseVolumes.push(name);
      continue;
    }
    await agent('docker.volumeCreate', { name, labels }, () => undefined);
    log(`Created volume ${name} on the node`);
    created.push(name);
  }
  return { created, missingDatabaseVolumes };
}

/**
 * D9: the compose pre-create (remoteCompose.ts, its labelled block). A node
 * stack's attachments are declared `external: true` in the override, and
 * compose refuses to start a project whose external volume is missing — so
 * every missing managed service volume is created first.
 *
 * Upgrade-safe by construction: an agent without `volume.manage` (a 0.15
 * node) gets exactly the 0.15 behaviour — nothing is created and `compose up`
 * needs the volumes to exist, as it always did — plus a log line naming the
 * update. A missing database volume is left alone (see {@link ensureNodeVolumes}).
 */
export async function precreateComposeVolumes(
  agent: AgentCaller,
  input: {
    nodeLabel: string;
    service: { id: number; ownerUserId?: number | null };
    attachments: readonly NodeVolumeAttachment[];
    log: (line: string) => void;
  },
): Promise<string[]> {
  const names = [...new Set(input.attachments.map((a) => a.volumeName))].filter(isNodeManagedVolume);
  if (names.length === 0) return [];
  const refusal = await capabilityRefusal(agent, input.nodeLabel, true, {
    cap: 'volume.manage',
    feature: NODE_VOLUME_CREATE_FEATURE,
    sealedRequired: false,
  });
  if (refusal) {
    input.log(`Volumes are not pre-created on node ${input.nodeLabel}: ${refusal.message} compose up needs them to exist on the node already.`);
    return [];
  }
  const { created, missingDatabaseVolumes } = await ensureNodeVolumes(
    agent,
    names,
    nodeVolumeLabels({ serviceId: input.service.id, userId: input.service.ownerUserId ?? null }),
    input.log,
  );
  for (const name of missingDatabaseVolumes) {
    input.log(`Database volume ${name} does not exist on node ${input.nodeLabel}; it is created by its database, never by a stack, so compose up will report it.`);
  }
  return created;
}

/** An attached volume that something on another host also uses. */
export interface VolumeHostConflict {
  volume: string;
  /** "service \"api\"" / "database \"pg\"". */
  user: string;
  /** Where that user lives (null = the panel host). */
  serverId: number | null;
}

const hostName = (serverId: number | null): string => (serverId === null ? 'the panel host' : `node #${serverId}`);

/**
 * Attached volumes of `service` that a database, another service's primary
 * volume, or another service's attachment uses on a DIFFERENT host. Each host
 * has its own volume of a name, so attaching one across hosts would silently
 * mount an empty namesake instead of the data.
 */
export async function attachmentHostConflicts(
  db: DB,
  service: { id: number; serverId?: number | null },
  volumeNames: readonly string[],
): Promise<VolumeHostConflict[]> {
  if (volumeNames.length === 0) return [];
  const host = service.serverId ?? null;
  const [svcs, dbs, atts] = await Promise.all([
    db.select({ id: services.id, name: services.name, slug: services.slug, serverId: services.serverId }).from(services),
    db
      .select({
        id: databases.id,
        name: databases.name,
        slug: databases.slug,
        volumeName: databases.volumeName,
        nodeVolumeName: databases.nodeVolumeName,
        serverId: databases.serverId,
      })
      .from(databases),
    db.select({ serviceId: serviceVolumeAttachments.serviceId, volumeName: serviceVolumeAttachments.volumeName }).from(serviceVolumeAttachments),
  ]);
  const conflicts: VolumeHostConflict[] = [];
  for (const volume of [...new Set(volumeNames)]) {
    const users: Array<{ user: string; serverId: number | null }> = [];
    for (const d of dbs) {
      if (d.volumeName === volume || d.nodeVolumeName === volume || `nd-db-${d.slug}-data` === volume) {
        users.push({ user: `database "${d.name}"`, serverId: d.serverId ?? null });
      }
    }
    for (const s of svcs) {
      if (s.id === service.id) continue;
      const attaches = atts.some((a) => a.serviceId === s.id && a.volumeName === volume);
      if (attaches || `nd-svc-${s.slug}-data` === volume) users.push({ user: `service "${s.name}"`, serverId: s.serverId ?? null });
    }
    for (const u of users) if (u.serverId !== host) conflicts.push({ volume, ...u });
  }
  return conflicts;
}

/** How {@link remoteVolumeRefusal} reaches the node (tests inject it). */
export interface RemoteVolumeProbe {
  agent: AgentCaller;
  nodeLabel: string;
  sealed: boolean;
}

/** A refusal: a capability refusal, or an attachment that crosses hosts (409). */
export type RemoteVolumeRefusal =
  | CapabilityRefusal
  | { status: 409; code: 'attachment_host_mismatch'; message: string };

/**
 * Why a node DOCKER service cannot run with its command, Docker socket or
 * volume attachments, or null when it can (design §4.2; replaces the r266
 * clause of `remoteServiceRefusal`).
 *
 *  - A service needing none of them is null without asking the node anything
 *    (the 0.15 `docker.runEnv` path, unchanged).
 *  - An attachment another host also uses → 409 `attachment_host_mismatch`,
 *    before the node is asked anything.
 *  - Otherwise the agent must advertise `docker.runSpec` over the sealed
 *    transport (the env-file path and the command can carry secrets), plus
 *    `volume.manage` when a volume is mounted (it is created first if missing):
 *    422 `node_agent_outdated` / `node_transport_unsealed`, 502 `node_unreachable`.
 *
 * Compose stacks are not refused here: their attachments were accepted before
 * and are pre-created before `compose up` when the agent can (D9).
 */
export async function remoteVolumeRefusal(
  db: DB,
  service: {
    id: number;
    serverId?: number | null;
    type?: string | null;
    cmd?: string[] | null;
    dockerSocket?: boolean | null;
    volumeMount?: string | null;
  },
  opts: { probe?: (serverId: number) => Promise<RemoteVolumeProbe> } = {},
): Promise<RemoteVolumeRefusal | null> {
  if (service.serverId == null || (service.type ?? 'docker') !== 'docker') return null;
  const serverId = service.serverId;
  const attachments = await db
    .select({ volumeName: serviceVolumeAttachments.volumeName, containerPath: serviceVolumeAttachments.containerPath })
    .from(serviceVolumeAttachments)
    .where(eq(serviceVolumeAttachments.serviceId, service.id));
  const needs = nodeRunNeeds(service, attachments);
  if (needs.length === 0) return null;

  const conflicts = await attachmentHostConflicts(db, service, attachments.map((a) => a.volumeName));
  if (conflicts.length > 0) {
    const list = conflicts.map((c) => `${c.volume} (used by ${c.user} on ${hostName(c.serverId)})`).join(', ');
    return {
      status: 409,
      code: 'attachment_host_mismatch',
      message:
        `This service runs on ${hostName(serverId)}, but its attached volume${conflicts.length > 1 ? 's' : ''} ${list} ` +
        'live on another host. A volume lives on the host of the service that uses it; detach it, or place both on the same host.',
    };
  }

  const probe = await (opts.probe ?? (async (id: number): Promise<RemoteVolumeProbe> => ({
    agent: (op, params, sink) => agentOp(db, id, op, params, sink),
    nodeLabel: await nodeLabel(db, id),
    sealed: await agentTransportSealed(db, id),
  })))(serverId);
  return capabilityRefusal(probe.agent, probe.nodeLabel, probe.sealed, {
    cap: nodeRunCapabilities(service, attachments),
    feature: NODE_RUN_SPEC_FEATURE,
    sealedRequired: true,
    persist: { db, serverId },
  });
}

/** Queue-time form of {@link remoteVolumeRefusal}: throws the refusal as an {@link HttpError}. */
export async function assertRemoteVolumeSupported(
  db: DB,
  service: Parameters<typeof remoteVolumeRefusal>[1],
  opts: Parameters<typeof remoteVolumeRefusal>[2] = {},
): Promise<void> {
  const refusal = await remoteVolumeRefusal(db, service, opts);
  if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
}
