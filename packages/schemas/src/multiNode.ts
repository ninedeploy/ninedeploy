import { z } from 'zod';
import { id } from './common.js';
import { volumeEntry } from './service.js';

// ── Multi-node (the 0.16 theme, shipped in the 0.15.x series) ──────────────
// Contracts for remote nodes that match the panel host: build placement and
// image transfer, server roles, node volumes, Swarm, and the agent capability
// view. These are SHAPE checks; the server authorises every request and
// re-checks every capability. Design: .temp_files/run_0.16/DESIGN.md §1–§7.
//
// Every stored default reproduces 0.15: a NULL `buildOn` builds where the
// service runs, a NULL `orchestrator` runs plain containers, a server is not
// a build server, and a database or volume with no `serverId` lives on the
// panel host.

// ── agent capabilities (§1.1) ──────────────────────────────────────────────

/**
 * The capabilities a multi-node agent advertises in its sealed `agent.ping`,
 * appended in this order after the 0.15 list so the 0.15 prefix check holds.
 * The agent's `AGENT_CAPABILITIES` must end with exactly this list.
 */
export const MULTI_NODE_CAPABILITIES = [
  'stream',
  'docker.runSpec',
  'volume.manage',
  'image.manage',
  'build.nixpacks',
  'build.railpack',
  'git.sshkey',
  'db.manage',
  'swarm',
] as const;
export const multiNodeCapability = z.enum(MULTI_NODE_CAPABILITIES);
export type MultiNodeCapability = z.infer<typeof multiNodeCapability>;

/**
 * Error codes the multi-node routes answer with. `node_agent_outdated` (422)
 * is the one refusal every feature shares when the node's agent predates it.
 */
export const multiNodeErrorCode = z.enum([
  'node_agent_outdated',
  // T2: a current agent whose owner switched the feature off (a node kill switch).
  'node_feature_disabled',
  'node_transport_unsealed',
  'node_unreachable',
  'node_placement_operator_only',
  'node_volume_exists',
  'server_not_online',
  'server_hosts_databases',
  'attachment_host_mismatch',
  'fanout_database_host',
  'remote_database',
  // T5: a volume backup taken on another host (restore needs `?acrossHosts=true`).
  'backup_host_mismatch',
  // T5: the volume file manager works on panel-host volumes only.
  'node_volume_files_unsupported',
]);
export type MultiNodeErrorCode = z.infer<typeof multiNodeErrorCode>;

/** `GET /v1/servers` → `agent`: the persisted capability cache (advisory). */
export const serverAgentInfo = z.object({
  /** null = the agent answered without a version (an older release). */
  version: z.string().nullable(),
  capabilities: z.array(z.string()),
  checkedAt: z.string().datetime().nullable(),
});
export type ServerAgentInfo = z.infer<typeof serverAgentInfo>;

/** `GET /v1/servers` → `features`: what the node can do today, and why not. */
export const serverFeatures = z.object({
  nixpacks: z.boolean(),
  railpack: z.boolean(),
  privateClones: z.boolean(),
  volumes: z.boolean(),
  databases: z.boolean(),
  imageTransfer: z.boolean(),
  swarm: z.boolean(),
  /** The "update the node agent" hint when any feature is off. */
  reason: z.string().optional(),
});
export type ServerFeatures = z.infer<typeof serverFeatures>;

// ── build placement and image transfer (§6) ────────────────────────────────

export const BUILD_CONCURRENCY_MIN = 1;
export const BUILD_CONCURRENCY_MAX = 8;
export const IMAGE_TRANSFERS_LIMIT_MAX = 100;

/** Mirrors `serviceBuildOn` in `@ninedeploy/db`. */
export const buildOn = z.enum(['target', 'panel', 'server']);
export type BuildOn = z.infer<typeof buildOn>;

/** Mirrors `serviceOrchestrator` in `@ninedeploy/db`. */
export const serviceOrchestrator = z.enum(['container', 'swarm']);
export type ServiceOrchestrator = z.infer<typeof serviceOrchestrator>;

/** A registry repository path (`team/app`), no host and no tag. */
export const pushRepository = z
  .string()
  .max(255)
  .regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/, 'must be a repository path such as team/app');

/**
 * `PUT /v1/services/:id/placement` (operator). Partial: only the named keys
 * change; `null` restores the 0.15 default for that key.
 */
export const servicePlacement = z
  .object({
    /** null = `target` (build where the service runs). */
    buildOn: buildOn.nullable(),
    buildServerId: id.nullable(),
    pushRegistrySourceId: id.nullable(),
    pushRepository: pushRepository.nullable(),
    /** null = `container` (plain containers). */
    orchestrator: serviceOrchestrator.nullable(),
  })
  .partial()
  .strict();
export type ServicePlacementInput = z.infer<typeof servicePlacement>;

/** `GET /v1/services/:id/placement`, and `placement` on the service response. */
export const servicePlacementView = z.object({
  buildOn: buildOn.nullable(),
  buildServerId: id.nullable(),
  pushRegistrySourceId: id.nullable(),
  pushRepository: z.string().nullable(),
  orchestrator: serviceOrchestrator.nullable(),
});
export type ServicePlacementView = z.infer<typeof servicePlacementView>;

/** The build placement a stored value means: NULL is today's `target`. */
export function effectiveBuildOn(value: BuildOn | null | undefined): BuildOn {
  return value ?? 'target';
}

/** The orchestrator a stored value means: NULL is today's `container`. */
export function effectiveOrchestrator(value: ServiceOrchestrator | null | undefined): ServiceOrchestrator {
  return value ?? 'container';
}

/** `PATCH /v1/servers/:id` (operator): the build-server role. */
export const serverRoles = z
  .object({
    isBuildServer: z.boolean(),
    buildConcurrency: z.number().int().min(BUILD_CONCURRENCY_MIN).max(BUILD_CONCURRENCY_MAX),
  })
  .partial()
  .strict();
export type ServerRolesInput = z.infer<typeof serverRoles>;

/** Mirrors `imageTransferMethod` in `@ninedeploy/db`. */
export const imageTransferMethod = z.enum(['stream', 'registry', 'preload']);
export type ImageTransferMethod = z.infer<typeof imageTransferMethod>;

/** Mirrors `imageTransferStatus` in `@ninedeploy/db`. */
export const imageTransferStatus = z.enum(['running', 'completed', 'failed']);
export type ImageTransferStatus = z.infer<typeof imageTransferStatus>;

/** One `image_transfers` row as the API returns it. A NULL server is the panel host. */
export const imageTransfer = z.object({
  id,
  deploymentId: id.nullable(),
  serviceId: id,
  sourceServerId: id.nullable(),
  targetServerId: id.nullable(),
  method: imageTransferMethod,
  imageRef: z.string(),
  imageId: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  status: imageTransferStatus,
  error: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nullable(),
});
export type ImageTransfer = z.infer<typeof imageTransfer>;

/** `GET /v1/services/:id/image-transfers` query. Query strings arrive as text. */
export const imageTransfersQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(IMAGE_TRANSFERS_LIMIT_MAX).default(20),
  })
  .strict();
export type ImageTransfersQuery = z.infer<typeof imageTransfersQuery>;

// ── node volumes (§4) ──────────────────────────────────────────────────────

/** A managed volume name: `nd-svc-*` or `nd-db-*` (bind mounts are never attachable). */
export const managedVolumeName = z
  .string()
  .max(128)
  .regex(/^nd-(?:svc|db)-[a-z0-9][a-z0-9_.-]*$/, 'must be a managed volume name (nd-svc-* or nd-db-*)');

/** `?serverId=` on the volume routes: absent = the panel host (today's response). */
export const volumeHostQuery = z
  .object({
    serverId: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type VolumeHostQuery = z.infer<typeof volumeHostQuery>;

/** `POST /v1/volumes` (operator). `serverId` null or absent = the panel host. */
export const volumeCreate = z
  .object({
    name: managedVolumeName,
    serverId: id.nullable().optional(),
  })
  .strict();
export type VolumeCreateInput = z.infer<typeof volumeCreate>;

/** A volume list item with the host it lives on (null = the panel host). */
export const hostVolumeEntry = volumeEntry.extend({ serverId: id.nullable() });
export type HostVolumeEntry = z.infer<typeof hostVolumeEntry>;

// ── Swarm (§7) ─────────────────────────────────────────────────────────────

/** Step-up password, as on the other step-up routes. */
const stepUpPassword = z.string().min(1).max(1024).optional();

/** `POST /v1/swarm/init` (operator, interactive, step-up). */
export const swarmInit = z
  .object({
    advertiseAddr: z.union([z.ipv4(), z.ipv6()]),
    password: stepUpPassword,
  })
  .strict();
export type SwarmInitInput = z.infer<typeof swarmInit>;

/** `PUT /v1/swarm/settings` (operator; step-up to enable). */
export const swarmSettings = z
  .object({
    enabled: z.boolean(),
    password: stepUpPassword,
  })
  .strict();
export type SwarmSettingsInput = z.infer<typeof swarmSettings>;

export const swarmNodeRole = z.enum(['manager', 'worker']);
export type SwarmNodeRole = z.infer<typeof swarmNodeRole>;

/** One Swarm node; `serverId` links it to a NineDeploy node (null = the panel host or a foreign node). */
export const swarmNode = z.object({
  id: z.string(),
  hostname: z.string(),
  role: swarmNodeRole,
  availability: z.string(),
  state: z.string(),
  serverId: id.nullable(),
});
export type SwarmNode = z.infer<typeof swarmNode>;

/** `GET /v1/swarm` (operator). Join tokens are never returned. */
export const swarmStatus = z.object({
  enabled: z.boolean(),
  /** `docker info` `.Swarm.LocalNodeState`: inactive, pending, active, error, locked. */
  localState: z.string(),
  controlAvailable: z.boolean(),
  managerAddr: z.string().nullable(),
  nodes: z.array(swarmNode),
});
export type SwarmStatus = z.infer<typeof swarmStatus>;

/** `GET /v1/services/:id/swarm` (viewer). */
export const serviceSwarmStatus = z.object({
  /** null = the service has no stack (not on Swarm, or not deployed yet). */
  stack: z.string().nullable(),
  desired: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  tasks: z.array(
    z.object({
      node: z.string(),
      state: z.string(),
      error: z.string().nullable(),
      image: z.string(),
    }),
  ),
});
export type ServiceSwarmStatus = z.infer<typeof serviceSwarmStatus>;
