import { z } from 'zod';
import { containerPath, dockerVolumeName, envVarName, gitBranch, gitRepoUrl, httpPath, repoBaseDir, repoRelativePath, slug } from './common.js';

export const serviceType = z.enum(['pm2', 'docker', 'compose']);
export const buildPack = z.enum(['auto', 'nixpacks', 'dockerfile']);

/** Optional project/workspace/label tag IDs for new service creation. */
const tagIds = z.array(z.number().int().positive()).optional();

export const createService = z.object({
  /** Bundled/remote Hub template ID. The server resolves privileged template
   * settings (cmd, Docker socket and database env mapping) from the trusted
   * registry; clients cannot submit those settings directly. */
  templateId: z.string().min(1).max(100).optional(),
  /**
   * Project / workspace / label tagging (N-N). `tagProjectIds` replaces the
   * removed `projectId` field. `tagWorkspaceIds` defaults to all workspaces
   * the caller belongs to when omitted (so a freshly-created service is
   * visible from the operator's workspaces). `tagLabelIds` is optional.
   */
  tagProjectIds: tagIds,
  tagWorkspaceIds: tagIds,
  tagLabelIds: tagIds,
  name: z.string().min(1).max(100),
  slug: slug.optional(), // derived from name if omitted
  /** Resume an idle, caller-owned service left by an interrupted Hub deploy. */
  reuseExisting: z.boolean().optional(),
  type: serviceType.default('docker'),
  repoUrl: gitRepoUrl.optional(),
  branch: gitBranch.default('main'),
  sourceId: z.number().int().positive().optional(),
  serverId: z.number().int().positive().nullable().optional(),
  image: z.string().optional(),
  volumeMount: z.string().optional(),
  /** Compose deploys: the main service in the compose file (health/routing
   * target). Defaults to the service slug when omitted — or, for an inline
   * `composeContent` stack, to the main service the server derives from the
   * YAML itself. */
  composeService: z.string().min(1).max(200).optional(),
  /** Inline Docker Compose stack: the whole YAML, pasted instead of cloned.
   * The server stores it on the service row and re-materialises it into the
   * workspace before every deploy, so there is no repository to check out.
   * Same 256 KiB cap as a Hub template's `composeContent`. */
  composeContent: z.string().min(1).max(262_144).optional(),
  cpuShares: z.number().int().min(0).max(262144).optional(),
  memLimitMb: z.number().int().min(0).optional(),
  healthPath: httpPath.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  publishedPort: z.number().int().min(1).max(65535).nullable().optional(),
  previewDeploymentsEnabled: z.boolean().optional(),
  previewAutoDestroyOnClose: z.boolean().optional(),
  previewDomainPattern: z.string().nullable().optional(),
  previewMaxActive: z.number().int().min(1).max(50).optional(),
  /** Deployment lane at create time (production / staging / …). */
  environmentId: z.number().int().positive().optional(),
  build: z
    .object({
      buildPack: buildPack.default('auto'),
      baseDir: repoBaseDir.default('/'),
      installCmd: z.string().optional(),
      buildCmd: z.string().optional(),
      startCmd: z.string().optional(),
      dockerfilePath: repoRelativePath.optional(),
      preDeployCmd: z.string().nullable().optional(),
      postDeployCmd: z.string().nullable().optional(),
      preStopCmd: z.string().nullable().optional(),
      // docker --restart policy: fixed values plus on-failure:N (restart-loop cap).
      restartPolicy: z.string().regex(/^(no|always|unless-stopped|on-failure(?::\d{1,3})?)$/).optional(),
      // Seconds between SIGTERM and SIGKILL on stop (docker stop -t).
      stopGraceSeconds: z.number().int().min(0).max(300).optional(),
    })
    .default({ buildPack: 'auto', baseDir: '/' }),
}).superRefine((value, ctx) => {
  if (!value.composeContent) return;
  // An inline stack IS a compose deploy — every other type ignores the field
  // entirely, so accepting it would store YAML that never runs.
  if (value.type !== 'compose') {
    ctx.addIssue({
      code: 'custom',
      path: ['composeContent'],
      message: "composeContent requires type 'compose'",
    });
  }
  // A repository would be cloned into the same workspace the YAML is written
  // to, and the first clone wipes that directory (lib/git.ts) — the pasted
  // stack would silently disappear. One source of truth or the other.
  if (value.repoUrl) {
    ctx.addIssue({
      code: 'custom',
      path: ['repoUrl'],
      message: 'composeContent and repoUrl are mutually exclusive — a git checkout would overwrite the pasted stack',
    });
  }
});
export type CreateService = z.infer<typeof createService>;

/** PATCH shape — every field optional, including individual build-config keys.
 * Built explicitly (NOT via createService.partial()): in Zod v4 `partial()`
 * still applies `.default()` values for absent keys, which would silently
 * rewrite `type` back to 'docker' and `branch` to 'main' on every PATCH. */
export const updateService = z.object({
  // Tag updates are usually handled by `PUT /v1/services/:id/tags`; these
  // convenience fields let a single PATCH reassign tags together with other
  // service edits without an extra round-trip.
  tagProjectIds: tagIds,
  tagWorkspaceIds: tagIds,
  tagLabelIds: tagIds,
  name: z.string().min(1).max(100).optional(),
  slug: slug.optional(),
  type: serviceType.optional(),
  repoUrl: gitRepoUrl.optional(),
  branch: gitBranch.optional(),
  /** Attached Git credential (source) for private-repo cloning. null clears it. */
  sourceId: z.number().int().positive().nullable().optional(),
  serverId: z.number().int().positive().nullable().optional(),
  image: z.string().optional(),
  volumeMount: z.string().optional(),
  composeService: z.string().min(1).max(200).optional(),
  /** Watchtower-style image auto-update. Only meaningful on image-based,
   * panel-host services — the route refuses it otherwise. */
  autoUpdate: z.boolean().optional(),
  /** Replace an inline stack's YAML. Only meaningful on a service that
   * already stores one — the route refuses it otherwise, because `type`
   * alone cannot tell an inline stack from a git-repo compose service. */
  composeContent: z.string().min(1).max(262_144).optional(),
  cpuShares: z.number().int().min(0).max(262144).optional(),
  memLimitMb: z.number().int().min(0).optional(),
  healthPath: httpPath.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  publishedPort: z.number().int().min(1).max(65535).nullable().optional(),
  previewDeploymentsEnabled: z.boolean().optional(),
  previewAutoDestroyOnClose: z.boolean().optional(),
  previewDomainPattern: z.string().nullable().optional(),
  previewMaxActive: z.number().int().min(1).max(50).optional(),
  /** Deployment lane (production / staging / …). null clears the assignment. */
  environmentId: z.number().int().positive().nullable().optional(),
  build: z
    .object({
      buildPack: buildPack.optional(),
      baseDir: repoBaseDir.optional(),
      installCmd: z.string().optional(),
      buildCmd: z.string().optional(),
      startCmd: z.string().optional(),
      dockerfilePath: repoRelativePath.optional(),
      preDeployCmd: z.string().nullable().optional(),
      postDeployCmd: z.string().nullable().optional(),
      preStopCmd: z.string().nullable().optional(),
      restartPolicy: z.string().regex(/^(no|always|unless-stopped|on-failure(?::\d{1,3})?)$/).optional(),
      stopGraceSeconds: z.number().int().min(0).max(300).optional(),
    })
    .optional(),
});
export type UpdateService = z.infer<typeof updateService>;

/** Input shapes (what a client sends) — defaults make `build` optional. */
export type CreateServiceInput = z.input<typeof createService>;
export type UpdateServiceInput = z.input<typeof updateService>;

export const service = z.object({
  id: z.number().int(),
  /**
   * Project / workspace / label tag lists (N-N). The legacy single
   * `projectId` field is gone; consumers compose the three arrays to decide
   * what shows up in the top-bar filter chips.
   */
  projectIds: z.array(z.number().int()),
  workspaceIds: z.array(z.number().int()),
  labelIds: z.array(z.number().int()),
  /** Resolved display objects — present on detail responses, may be omitted on list. */
  projects: z
    .array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() }))
    .optional(),
  workspaces: z
    .array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() }))
    .optional(),
  labels: z
    .array(z.object({ id: z.number().int(), name: z.string(), color: z.string() }))
    .optional(),
  serverId: z.number().int().nullable().optional(),
  name: z.string(),
  slug: z.string(),
  type: serviceType,
  status: z.enum(['idle', 'deploying', 'running', 'stopped', 'error', 'deleting']),
  repoUrl: z.string().nullable(),
  branch: z.string(),
  sourceId: z.number().int().nullable(),
  /** Display name of the attached Git credential (source), for the UI. */
  sourceName: z.string().nullable().optional(),
  image: z.string().nullable(),
  /** Watchtower-style digest watch (image-based, panel-host services only). */
  autoUpdate: z.boolean().optional(),
  volumeMount: z.string().nullable(),
  composeService: z.string().nullable(),
  /** The stored YAML of an inline compose stack; null for every other
   * service (a git-repo compose service keeps its file in the repository). */
  composeContent: z.string().nullable().optional(),
  commitSha: z.string().nullable(),
  runtimeId: z.string().nullable(),
  healthPath: z.string(),
  autoUrl: z.string().nullable(),
  port: z.number().int().nullable(),
  publishedPort: z.number().int().nullable().optional(),
  cpuShares: z.number().int(),
  memLimitMb: z.number().int(),
  previewDeploymentsEnabled: z.boolean().optional(),
  previewAutoDestroyOnClose: z.boolean().optional(),
  previewDomainPattern: z.string().nullable().optional(),
  previewMaxActive: z.number().int().optional(),
  isEphemeralPreview: z.boolean().optional(),
  previewParentServiceId: z.number().int().nullable().optional(),
  prNumber: z.number().int().nullable().optional(),
  /** Deployment lane id (production / staging / …). Null = ungrouped. */
  environmentId: z.number().int().nullable().optional(),
  build: z
    .object({
      buildPack: buildPack,
      baseDir: z.string(),
      installCmd: z.string().nullable(),
      buildCmd: z.string().nullable(),
      startCmd: z.string().nullable(),
      dockerfilePath: z.string().nullable(),
      preDeployCmd: z.string().nullable().optional(),
      postDeployCmd: z.string().nullable().optional(),
      preStopCmd: z.string().nullable().optional(),
      restartPolicy: z.string(),
      stopGraceSeconds: z.number().int(),
    })
    .nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Service = z.infer<typeof service>;

// ── Sources (private repo credentials) ─────────────────────────────────────
export const createSource = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['github', 'gitlab', 'gitea', 'custom', 'registry']),
  token: z.string().optional(),
  deployKey: z.string().optional(),
  // Registry-type sources: username for `docker login` (token = password).
  registryUsername: z.string().max(255).optional(),
  defaultBranch: z.string().optional(),
});
export type CreateSourceInput = z.input<typeof createSource>;

export const source = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.string(),
  hasToken: z.boolean(),
  hasDeployKey: z.boolean(),
  registryUsername: z.string().nullable().optional(),
  defaultBranch: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});
export type Source = z.infer<typeof source>;

export const triggerDeploy = z.object({
  commitSha: z.string().optional(),
});
export type TriggerDeploy = z.infer<typeof triggerDeploy>;

export const deployment = z.object({
  id: z.number().int(),
  status: z.enum(['queued', 'building', 'deploying', 'running', 'superseded', 'failed', 'cancelled']),
  commitSha: z.string().nullable(),
  message: z.string().nullable(),
  author: z.string().nullable(),
  trigger: z.string(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Deployment = z.infer<typeof deployment>;

/**
 * A single row in the global deploy queue (`GET /v1/services/queue`).
 *
 * Same fields as `Deployment` plus the service + project metadata the
 * panel needs to render "what is happening and what is coming next"
 * without a follow-up round-trip. `imageDigest` is populated for image
 * deploys where `commitSha` is null.
 */
export const queueItem = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  serviceName: z.string(),
  status: z.enum(['queued', 'building', 'deploying']),
  commitSha: z.string().nullable(),
  imageDigest: z.string().nullable(),
  message: z.string().nullable(),
  author: z.string().nullable(),
  trigger: z.string(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type QueueItem = z.infer<typeof queueItem>;

export const queueResponse = z.object({
  items: z.array(queueItem),
  count: z.number().int(),
  byStatus: z.object({
    queued: z.number().int(),
    building: z.number().int(),
    deploying: z.number().int(),
  }),
});
export type QueueResponse = z.infer<typeof queueResponse>;

// ── Domains (Traefik routing) ─────────────────────────────────────────────
export const createDomain = z.object({
  hostname: z.string().min(3).max(253),
  path: z.string().default('/'),
  // Default matches the DB column default and the CLI (`ssl !== false`):
  // HTTPS everywhere unless explicitly disabled.
  ssl: z.boolean().default(true),
  redirectWww: z.boolean().optional(),
  /** JSON array [{name, value}] of custom response headers. */
  headers: z.string().max(8000).optional(),
  /** Basic Auth credentials (JSON array of "user:htpasswd_hash" or "user:pass"). */
  basicAuth: z.string().max(8000).optional().nullable(),
  /** IP Allowlist (comma-separated CIDRs e.g. "1.2.3.4/32, 10.0.0.0/8"). */
  ipAllowlist: z.string().max(4000).optional().nullable(),
  /** Rate limit: average requests/second. */
  rateLimitAverage: z.number().int().min(0).max(100000).optional().nullable(),
  /** Rate limit: burst peak requests allowed. */
  rateLimitBurst: z.number().int().min(0).max(100000).optional().nullable(),
});
export type CreateDomainInput = z.input<typeof createDomain>;

/** PATCHable routing extras for an existing domain. */
export const domainPatch = z.object({
  ssl: z.boolean().optional(),
  redirectWww: z.boolean().optional(),
  headers: z.string().max(8000).optional().nullable(),
  basicAuth: z.string().max(8000).optional().nullable(),
  ipAllowlist: z.string().max(4000).optional().nullable(),
  rateLimitAverage: z.number().int().min(0).max(100000).optional().nullable(),
  rateLimitBurst: z.number().int().min(0).max(100000).optional().nullable(),
});
export type DomainPatch = z.input<typeof domainPatch>;

export const domain = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  hostname: z.string(),
  path: z.string(),
  ssl: z.boolean(),
  redirectWww: z.boolean(),
  headers: z.string(),
  basicAuth: z.string().nullable().optional(),
  ipAllowlist: z.string().nullable().optional(),
  rateLimitAverage: z.number().nullable().optional(),
  rateLimitBurst: z.number().nullable().optional(),
  status: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Domain = z.infer<typeof domain>;

// ── Webhooks (auto-deploy) ────────────────────────────────────────────────
export const createWebhook = z.object({
  branch: gitBranch.optional(),
  /** Newline/comma-separated globs — deploy only when a changed file matches. */
  watchPaths: z.string().max(1024).refine((raw) => {
    const patterns = raw.split(/[\n,]/).map((pattern) => pattern.trim()).filter(Boolean);
    return patterns.length <= 32 && patterns.every((pattern) => pattern.length <= 256 && (pattern.match(/\*\*/g) ?? []).length <= 4 && (pattern.match(/[?*]/g) ?? []).length <= 16);
  }, 'watchPaths contains an unsafe glob pattern').optional(),
});
export type CreateWebhookInput = z.input<typeof createWebhook>;

export const webhook = z.object({
  id: z.number().int(),
  branch: z.string(),
  active: z.boolean(),
  watchPaths: z.string(),
  sourceId: z.number().int().nullable().optional(),
  url: z.string(),
  createdAt: z.string().datetime(),
});
export type Webhook = z.infer<typeof webhook>;

/** Returned once at creation time — the secret is never retrievable again. */
export const createdWebhook = webhook.extend({ secret: z.string() });
export type CreatedWebhook = z.infer<typeof createdWebhook>;

// ── Managed databases ─────────────────────────────────────────────────────
export const createDatabase = z.object({
  name: z.string().min(1).max(100),
  engine: z.enum(['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'valkey', 'clickhouse', 'meilisearch', 'rabbitmq']),
  version: z.string().optional(),
  projectId: z.number().int().optional(),
  /** Hub/template provisioning is retryable: resume a matching database owned
   * by the caller instead of colliding with the globally unique slug. */
  reuseExisting: z.boolean().optional(),
  existingVolume: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  webGuiEnabled: z.boolean().optional(),
});
export type CreateDatabaseInput = z.input<typeof createDatabase>;

export const databasePatch = z.object({
  name: z.string().min(1).max(100).optional(),
  extensions: z.array(z.string()).optional(),
  webGuiEnabled: z.boolean().optional(),
});
export type DatabasePatch = z.input<typeof databasePatch>;

export const managedDatabase = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  name: z.string(),
  slug: z.string(),
  engine: z.string(),
  version: z.string().nullable(),
  status: z.string(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  username: z.string().nullable(),
  database: z.string().nullable(),
  connectionString: z.string().nullable(),
  webGuiEnabled: z.boolean().optional().default(false),
  webGuiPort: z.number().int().nullable().optional(),
  extensions: z.array(z.string()).optional().default([]),
  attachedServices: z.array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() })).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ManagedDatabase = z.infer<typeof managedDatabase>;

/** Input for attaching a managed database to a service. The env alias, when
 *  provided, must be a valid environment-variable name (trimmed) — it is
 *  injected verbatim into the service's runtime env at deploy time. */
export const createAttachment = z.object({
  databaseId: z.number().int().positive(),
  envAlias: envVarName.optional(),
  reuseExisting: z.boolean().optional(),
});
export type CreateAttachmentInput = z.input<typeof createAttachment>;

export const attachment = z.object({
  id: z.number().int(),
  databaseId: z.number().int(),
  envAlias: z.string(),
  database: z.object({ name: z.string(), engine: z.string(), status: z.string() }).nullable(),
});
export type Attachment = z.infer<typeof attachment>;

// ── Environment variables ──────────────────────────────────────────────────
export const upsertEnvVar = z.object({
  key: envVarName.max(100),
  value: z.string(),
  isSecret: z.boolean().optional(),
  overwriteExisting: z.boolean().optional(),
});
export type UpsertEnvVarInput = z.input<typeof upsertEnvVar>;

export const envVar = z.object({
  id: z.number().int(),
  key: z.string(),
  value: z.string(),
  isSecret: z.boolean(),
});
export type EnvVar = z.infer<typeof envVar>;

// ── Service volume attachments ────────────────────────────────────────────
// A service can attach additional named Docker volumes in addition to its
// `volumeMount` primary. Either an existing managed volume (by name) or a
// fresh one created on demand. The volume persists across redeploys and
// container recreations — detaching only removes the link, not the data.
/** Create a new attachment. Exactly one of `volumeName` or `create.label`
 *  must be present — the former attaches an existing managed volume, the
 *  latter provisions a new one (system-generated name) and immediately
 *  attaches it. */
export const createServiceVolumeAttachment = z
  .object({
    // Attach an existing managed volume (must start with nd-svc- / nd-db-).
    volumeName: dockerVolumeName.optional(),
    // Provision a new named volume on attach. The label is a short
    // human-friendly suffix (e.g. "uploads"); the server prepends the
    // service-prefix to produce a unique managed name.
    create: z.object({ label: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/i, 'invalid label') }).optional(),
    containerPath: containerPath,
    readOnly: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.volumeName) !== Boolean(v.create?.label), {
    message: 'Provide exactly one of volumeName or create.label',
  });
export type CreateServiceVolumeAttachmentInput = z.input<typeof createServiceVolumeAttachment>;

/** PATCH shape — path and readOnly are optional, but at least one must change. */
export const updateServiceVolumeAttachment = z
  .object({
    containerPath: containerPath.optional(),
    readOnly: z.boolean().optional(),
  })
  .refine((v) => v.containerPath !== undefined || v.readOnly !== undefined, {
    message: 'Provide at least one of containerPath or readOnly',
  });
export type UpdateServiceVolumeAttachmentInput = z.input<typeof updateServiceVolumeAttachment>;

/** API representation of a service's volume attachment. */
export const serviceVolumeAttachment = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  volumeName: z.string(),
  containerPath: z.string(),
  readOnly: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ServiceVolumeAttachment = z.infer<typeof serviceVolumeAttachment>;

// ── Resource limits ───────────────────────────────────────────────────────
export const setLimits = z.object({
  cpuShares: z.number().int().min(0).max(262144).nullable().optional(),
  memLimitMb: z.number().int().min(0).nullable().optional(),
});
export type SetLimitsInput = z.infer<typeof setLimits>;

// ── Monitoring stats ───────────────────────────────────────────────────────
export const hostStat = z.object({
  cpuCores: z.number().int(),
  load1: z.number(),
  memTotalBytes: z.number().int(),
  memUsedBytes: z.number().int(),
  diskTotalBytes: z.number().int(),
  diskUsedBytes: z.number().int(),
});
export type HostStat = z.infer<typeof hostStat>;

export const containerStat = z.object({
  name: z.string(),
  kind: z.enum(['service', 'database']),
  refId: z.number().int(),
  refName: z.string(),
  engine: z.string().optional(),
  cpuPct: z.number(),
  memMb: z.number(),
  memLimitMb: z.number().int(),
});
export type ContainerStat = z.infer<typeof containerStat>;

export const statsSnapshot = z.object({
  host: hostStat.nullable(),
  containers: z.array(containerStat),
});
export type StatsSnapshot = z.infer<typeof statsSnapshot>;

export const metricSeries = z.object({
  kind: z.string(),
  points: z.array(z.object({ ts: z.string().datetime(), value: z.number() })),
});
export type MetricSeries = z.infer<typeof metricSeries>;

// ── Topology graph ─────────────────────────────────────────────────────────
export const topologyGraph = z.object({
  services: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      slug: z.string(),
      type: z.string(),
      status: z.string(),
      image: z.string().nullable(),
      port: z.number().int().nullable(),
      runtimeId: z.string().nullable(),
      volumeMount: z.string().nullable(),
    }),
  ),
  databases: z.array(z.object({ id: z.number().int(), name: z.string(), engine: z.string(), status: z.string(), host: z.string().nullable() })),
  attachments: z.array(z.object({ id: z.number().int(), serviceId: z.number().int(), databaseId: z.number().int(), envAlias: z.string() })),
  domains: z.array(z.object({ id: z.number().int(), serviceId: z.number().int(), hostname: z.string(), ssl: z.boolean() })),
  /** Managed docker volumes with their owner link (null = orphaned). */
  volumes: z.array(
    z.object({
      name: z.string(),
      owner: z.object({ kind: z.string(), refId: z.number().int(), name: z.string(), engine: z.string().optional() }).nullable(),
    }),
  ),
  /** User-defined docker networks; `containers` is filled for the shared mesh only. */
  networks: z.array(z.object({ name: z.string(), driver: z.string(), containers: z.array(z.string()) })),
  /** The Traefik gateway fronting every routed service. */
  gateway: z.object({ name: z.string(), network: z.string(), running: z.boolean() }),
});
export type TopologyGraph = z.infer<typeof topologyGraph>;

// ── Backups + storage ──────────────────────────────────────────────────────
export const backup = z.object({
  id: z.number().int(),
  // Exactly one of (databaseId, volumeName) is set — encoded by `scope`.
  databaseId: z.number().int().nullable(),
  volumeName: z.string().nullable(),
  scope: z.enum(['db', 'volumes']),
  status: z.string(),
  sizeBytes: z.number().int(),
  /** Snapshot name ('manual', 'schedule-…' or an operator tag); volume rows only. */
  label: z.string().nullable(),
  hasRemoteCopy: z.boolean().optional(),
  createdAt: z.string().datetime(),
});
export type Backup = z.infer<typeof backup>;

export const backupWithDb = backup.extend({ databaseName: z.string().nullable() });
export type BackupWithDb = z.infer<typeof backupWithDb>;

/** Create a new volume backup. The `volumeName` is the route param; the
 *  body only carries the `label` for human-friendly file naming. */
export const createVolumeBackup = z.object({
  label: z.string().min(1).max(80).optional(),
});
export type CreateVolumeBackupInput = z.input<typeof createVolumeBackup>;

// ── Template hub ───────────────────────────────────────────────────────────
export const templateSummary = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  category: z.string(),
  emoji: z.string(),
  featured: z.boolean().optional(),
  runtimeVerified: z.boolean().optional(),
  verifiedAt: z.iso.date().optional(),
});
export type TemplateSummary = z.infer<typeof templateSummary>;

export const template = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  description: z.string(),
  category: z.string(),
  emoji: z.string(),
  image: z.string(),
  port: z.number().int(),
  volumeMount: z.string().nullable().optional(),
  env: z.array(z.object({ key: z.string(), value: z.string(), secret: z.boolean().optional() })).optional(),
  website: z.string().optional(),
  docs: z.string().optional(),
  featured: z.boolean().optional(),
  /** Set only after the complete template contract has passed an isolated
   * container startup and declared-port smoke test. */
  runtimeVerified: z.boolean().optional(),
  verifiedAt: z.iso.date().optional(),
  /** Human hint about extra setup this template needs (shown in the Hub). */
  requires: z.string().optional(),
  /** When set, the wizard can auto-provision + attach a managed database of
   *  this engine. databaseEnv controls the application-specific injection. */
  dbEngine: z.enum(['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongo', 'clickhouse', 'meilisearch', 'rabbitmq']).optional(),
  /** Map application-specific environment keys to managed database connection
   * fields. Without this, attachments expose only their legacy URL alias. */
  databaseEnv: z.record(
    envVarName,
    z.enum(['url', 'host', 'hostPort', 'port', 'username', 'password', 'database']),
  ).optional(),
  /** Container command (argv) appended after the image — needed by images
   *  whose default entrypoint prints help and exits (e.g. minio). */
  cmd: z.array(z.string()).min(1).optional(),
  /** Bind-mount the host Docker socket into the container (docker control —
   *  only settable from the admin-controlled template registry, never via
   *  the create-service API). */
  dockerSocket: z.boolean().optional(),
  /** Full Docker Compose stack definition. When present the template deploys
   *  as a multi-container compose project (`type: 'compose'`) instead of the
   *  single-container image+port model; `image`/`port` then describe the MAIN
   *  (routed) service for Hub display and health routing. */
  composeContent: z.string().min(1).max(262_144).optional(),
  /** Compose service name the router points at and that owns `# port`. */
  composeService: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).optional(),
}).superRefine((value, ctx) => {
  if (value.dbEngine && !value.databaseEnv) {
    ctx.addIssue({
      code: 'custom',
      path: ['databaseEnv'],
      message: 'databaseEnv is required when dbEngine is set',
    });
  }
  if (value.composeContent && !value.composeService) {
    ctx.addIssue({
      code: 'custom',
      path: ['composeService'],
      message: 'composeService is required when composeContent is set',
    });
  }
});
export type Template = z.infer<typeof template>;

/**
 * Community template contribution (G-13). A `*.json`
 * file dropped into `<dataDir>/community-templates/` is
 * parsed against the `template` schema and surfaced in
 * the `community.list` response. Files that fail to
 * parse are reported in `errors` (one entry per file)
 * so a single bad contribution does not hide the rest.
 */
export const communityTemplateEntrySchema = z.object({
  id: z.string(),
  template: template,
  file: z.string(),
  bytes: z.number().int().nonnegative(),
  mtime: z.number(),
});
export type CommunityTemplateEntry = z.infer<typeof communityTemplateEntrySchema>;

export const communityTemplateListResultSchema = z.object({
  entries: z.array(communityTemplateEntrySchema),
  errors: z.array(z.object({ file: z.string(), error: z.string() })),
  totalBytes: z.number().int().nonnegative(),
});
export type CommunityTemplateListResult = z.infer<typeof communityTemplateListResultSchema>;

/**
 * One canonical Hub installation request. Internal port, volume, command,
 * Docker socket and database mapping are intentionally absent: they are
 * privileged registry-owned fields resolved by the server.
 */
export const deployTemplate = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  projectId: z.number().int().positive().optional(),
  serverId: z.number().int().positive().nullable().optional(),
  publishedPort: z.number().int().min(1).max(65535).nullable().optional(),
  healthPath: httpPath.optional(),
  cpuShares: z.number().int().min(0).max(262144).optional(),
  memLimitMb: z.number().int().min(0).optional(),
  /** Optional tag override for the template's image — SAME repository only
   *  (e.g. directus/directus:11.5 instead of :latest). Validated server-side
   *  against the template image; digest references and cross-repository
   *  swaps are rejected. */
  image: z.string().trim().min(1).max(500).optional(),
  env: z.array(z.object({
    key: envVarName,
    value: z.string().max(32_768),
    isSecret: z.boolean().optional().default(false),
  })).max(200).optional(),
  /** Reconcile an interrupted caller-owned install with the same slug. */
  reuseExisting: z.boolean().optional().default(true),
});
export type DeployTemplateInput = z.input<typeof deployTemplate>;
export type DeployTemplate = z.infer<typeof deployTemplate>;

/**
 * Dry-run analysis of a pasted compose file. The wizard calls this while the
 * user is still typing so blocking problems, host-privilege warnings, the
 * routable service list and the variables the stack will ask for all appear
 * inline — instead of arriving as a 400 after the service row already exists.
 * Reads only: nothing is written and no service is created.
 */
export const composePreviewRequest = z.object({
  content: z.string().min(1).max(262_144),
  /** The container port the wizard is about to route to, used to pick the
   * main service by port reference. 0/omitted falls back to name heuristics. */
  port: z.number().int().min(1).max(65535).optional(),
});
export type ComposePreviewRequestInput = z.input<typeof composePreviewRequest>;

export const composePreviewResponse = z.object({
  /** False when `reasons` is non-empty — the stack cannot run here at all. */
  ok: z.boolean(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  /** Every service key in the file, in declaration order. */
  services: z.array(z.string()),
  /** Best guess at the routed service; null when the file declares none. */
  suggestedService: z.string().nullable(),
  /** `SERVICE_*` tokens the platform will generate values for. */
  magicTokens: z.array(z.string()),
  /** `${VAR}` references with no default — the user must supply these. */
  openPlaceholders: z.array(z.string()),
  /** `${VAR:-default}` references, offered as prefilled env rows. */
  configurableEnv: z.array(z.object({ key: z.string(), value: z.string() })),
});
export type ComposePreviewResponse = z.infer<typeof composePreviewResponse>;

/**
 * Whether an image reference keeps the template's registry repository while
 * changing only the tag (`directus/directus:latest` → `directus/directus:11.5`).
 * Digest references and cross-repository swaps are refused: the Hub override
 * exists to pin a version, not to run an arbitrary image under a template's name.
 */
export function sameImageRepository(templateImage: string, override: string): boolean {
  if (override.includes('@')) return false;
  const repo = (ref: string): string => {
    const at = ref.lastIndexOf('@');
    if (at > ref.lastIndexOf('/')) return ref.slice(0, at);
    const colon = ref.lastIndexOf(':');
    return colon > ref.lastIndexOf('/') ? ref.slice(0, colon) : ref;
  };
  return repo(templateImage) === repo(override);
}

// ── Domain routing index + volumes ─────────────────────────────────────────
export const domainEntry = z.object({
  id: z.number().int(),
  hostname: z.string(),
  path: z.string(),
  ssl: z.boolean(),
  status: z.string(),
  serviceId: z.number().int(),
  serviceName: z.string().nullable(),
  container: z.string().nullable(),
  port: z.number().int().nullable(),
  certExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DomainEntry = z.infer<typeof domainEntry>;

export const volumeEntry = z.object({
  name: z.string(),
  sizeBytes: z.number().int(),
  owner: z.object({ kind: z.string(), id: z.number().int().optional(), name: z.string(), engine: z.string().optional() }).nullable(),
  /** True when the owner's container is running — deletion is refused (409). */
  inUse: z.boolean(),
});
export type VolumeEntry = z.infer<typeof volumeEntry>;

// ── Volume file manager ────────────────────────────────────────────────────
export const volumeFileEntry = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir']),
  sizeBytes: z.number().int(),
  mode: z.string().nullable().optional(),
  modifiedAt: z.string().datetime().nullable(),
});
export type VolumeFileEntry = z.infer<typeof volumeFileEntry>;

export const volumeFileWrite = z.object({
  /** Relative path inside the volume. */
  path: z.string().min(1).max(1024),
  /** Base64-encoded file content (schemas validate; argv never sees it). */
  contentBase64: z.string().max(8 * 1024 * 1024),
});
export type VolumeFileWriteInput = z.input<typeof volumeFileWrite>;

export const volumePathCreate = z.object({
  path: z.string().min(1).max(1024),
});
export type VolumePathCreateInput = z.input<typeof volumePathCreate>;

// ── Container file manager ─────────────────────────────────────────────────
export const containerFileEntry = volumeFileEntry;
export type ContainerFileEntry = VolumeFileEntry;

export const containerFileWrite = volumeFileWrite;
export type ContainerFileWriteInput = VolumeFileWriteInput;

export const containerPathCreate = volumePathCreate;
export type ContainerPathCreateInput = VolumePathCreateInput;

// ── Docker resource accounting ─────────────────────────────────────────────
export const dockerResources = z.object({
  network: z.string(),
  containers: z.number().int(),
  volumes: z.number().int(),
  imagesSummary: z.object({ total: z.string(), active: z.string(), size: z.string(), reclaimable: z.string() }),
  images: z.array(z.object({ repo: z.string(), tag: z.string(), size: z.string() })),
});
export type DockerResources = z.infer<typeof dockerResources>;

// ── Cloudflare Tunnels ─────────────────────────────────────────────────────
export const createTunnel = z.object({ name: z.string().min(1).max(100), token: z.string().min(1) });
export type CreateTunnelInput = z.input<typeof createTunnel>;

export const tunnelEntry = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  containerName: z.string(),
  createdAt: z.string().datetime(),
});
export type TunnelEntry = z.infer<typeof tunnelEntry>;

// ── Log Drains ─────────────────────────────────────────────────────────────
export const logDrainType = z.enum(['syslog', 'loki', 'vector', 'datadog', 'http']);
export type LogDrainType = z.infer<typeof logDrainType>;

export const logDrainFormat = z.enum(['json', 'raw', 'rfc5424']);
export type LogDrainFormat = z.infer<typeof logDrainFormat>;

export const logDrain = z.object({
  id: z.number().int(),
  name: z.string(),
  type: logDrainType,
  url: z.string(),
  serviceId: z.number().int().nullable(),
  serviceName: z.string().nullable().optional(),
  enabled: z.boolean(),
  format: logDrainFormat,
  headers: z.record(z.string(), z.string()).optional(),
  hasApiKey: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LogDrain = z.infer<typeof logDrain>;

export const logDrainCreate = z.object({
  name: z.string().min(1).max(100),
  type: logDrainType,
  url: z.string().min(1),
  apiKey: z.string().optional(),
  serviceId: z.number().int().optional().nullable(),
  enabled: z.boolean().optional(),
  format: logDrainFormat.optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type LogDrainCreateInput = z.input<typeof logDrainCreate>;

export const logDrainUpdate = logDrainCreate.partial();
export type LogDrainUpdateInput = z.input<typeof logDrainUpdate>;

export const logDrainTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  message: z.string().optional(),
});
export type LogDrainTestResult = z.infer<typeof logDrainTestResult>;

// ── Auto-Prune & Disk Maintenance ──────────────────────────────────────────
export const autoPruneConfig = z.object({
  enabled: z.boolean(),
  thresholdPercent: z.number().min(10).max(99),
  pruneImages: z.boolean(),
  pruneVolumes: z.boolean(),
  pruneContainers: z.boolean(),
  pruneBuildCache: z.boolean(),
  maxAgeHours: z.number().min(1).max(720),
});
export type AutoPruneConfig = z.infer<typeof autoPruneConfig>;

export const autoPruneConfigUpdate = autoPruneConfig.partial();
export type AutoPruneConfigUpdateInput = z.input<typeof autoPruneConfigUpdate>;

export const autoPruneStatus = autoPruneConfig.extend({
  diskUsedPercent: z.number(),
  diskTotalBytes: z.number(),
  diskFreeBytes: z.number(),
  lastPrunedAt: z.string().datetime().nullable(),
  lastFreedBytes: z.number().nullable(),
});
export type AutoPruneStatus = z.infer<typeof autoPruneStatus>;

export const autoPruneRunResult = z.object({
  ok: z.boolean(),
  freedBytes: z.number(),
  diskUsedPercentAfter: z.number(),
  details: z.object({
    imagesFreed: z.string().optional(),
    buildCacheFreed: z.string().optional(),
    containersFreed: z.string().optional(),
    volumesFreed: z.string().optional(),
  }),
});
export type AutoPruneRunResult = z.infer<typeof autoPruneRunResult>;

