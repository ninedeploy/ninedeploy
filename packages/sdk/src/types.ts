// Response and input shapes the SDK defines on top of @ninedeploy/schemas.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  CreateSourceInput,
  Domain,
  DatabaseCredentials,
  Service,
  TraefikMiddleware,
  TraefikRouter,
  TraefikService,
  VolumeEntry,
  NinedeployManifest,
  GithubAppInstallation,
  TerminalSessionStatus,
  TerminalTargetKind,
  TrafficRange,
  ServerAgentInfo,
  ServerFeatures,
  ServicePlacementView,
  SourcePatch,
  SwarmNodeRole,
} from '@ninedeploy/schemas';

/** Scheduled-job kind (`scheduled_jobs.kind`). */
export type JobKind = 'deploy' | 'exec' | 'backup';

/** A scheduled (cron) job as serialized by `GET/POST/PATCH /v1/services/:id/jobs`. */
export interface ScheduledJob {
  id: number;
  serviceId: number;
  name: string;
  cron: string;
  kind: JobKind;
  /** Empty for exec jobs when the caller is not an operator (r280). */
  command: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

/** One run of a scheduled job (`GET /v1/services/:id/jobs/:jobId/runs`). */
export interface JobRun {
  id: number;
  jobId: number;
  status: string;
  output: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** `GET /v1/traefik/version` — running vs latest Traefik release. */
export interface TraefikVersionInfo {
  current: string | null;
  latest: string | null;
  outdated: boolean;
  image: string;
}

/** `GET /v1/traefik/config` — the routing table the proxy is serving. */
export interface TraefikRoutingConfig {
  routers: TraefikRouter[];
  services: TraefikService[];
  middlewares: TraefikMiddleware[];
}

export interface HealthStatus {
  status: string;
  db?: string;
  version?: string;
  time?: string;
}

/**
 * Who may resolve `${{infisical|doppler:KEY}}` references (0.10.36): services
 * owned by an instance operator always may; others only when one of their
 * workspaces is listed — or, for legacy un-tagged services grandfathered at
 * upgrade, their own id. `workspaces` / `allowedServices` carry display names.
 */
export interface VaultAllowlistView {
  allowlist: { workspaceIds: number[]; serviceIds: number[] };
  workspaces: Array<{ id: number; name: string }>;
  allowedServices: Array<{ id: number; name: string }>;
}

/** `GET /v1/settings/vault`. The allowlist fields are additive (0.10.36). */
export interface VaultSettings extends Partial<VaultAllowlistView> {
  provider: string | null;
  hasToken: boolean;
  projectId: string | null;
  environment: string | null;
}

/**
 * Result of `GET /v1/auth/token`. Tells the caller what
 * the current bearer credential is and what it can do.
 * `kind` is `'session'` for JWTs and `'api'` for opaque
 * API tokens. `scopes` lists the resource-scoped
 * authorities (or the legacy `read` / `write` / `operator`
 * shorthand); an interactive session reports
 * `['session']` which is implicit full authority.
 */
export interface TokenIntrospection {
  kind: 'session' | 'api';
  userId: number;
  scopes: string[];
  expiresAt: string | null;
  isOperator: boolean;
  /** API tokens only. */
  tokenId?: number;
  name?: string;
}

export interface TemplateDeployResult {
  serviceId: number;
  serviceName: string;
  serviceSlug: string;
  deploymentId: number;
  databaseId: number | null;
  generatedSecrets: Array<{ key: string; value: string }>;
  stages: Array<{
    id: 'service' | 'environment' | 'database' | 'attachment' | 'deployment';
    status: 'success' | 'skipped';
    message: string;
  }>;
  alreadyInProgress: boolean;
}

export interface TemplatePrepareResult {
  serviceId: number;
  serviceName: string;
  serviceSlug: string;
  deploymentId: number;
  generatedSecrets: Array<{ key: string; value: string }>;
  stages: TemplateDeployResult['stages'];
}

/**
 * Response from `services.manifest.apply`. The server returns the
 * subset of fields the manifest actually changed under each
 * section; untouched fields stay in the panel-managed column
 * and do not appear in `diff`.
 */
export interface ApplyManifestResult {
  ok: boolean;
  serviceId: number;
  /** Sections the server actually wrote: `service`, `build_config`. */
  touched: string[];
  diff: {
    service: {
      port?: number;
      healthPath?: string;
      publishedPort?: number | null;
    };
    build: {
      installCmd?: string;
      buildCmd?: string;
      startCmd?: string;
      baseDir?: string;
      dockerfilePath?: string | null;
      restartPolicy?: string;
      stopGraceSeconds?: number;
    };
  };
}

/** Body for `services.manifest.apply`. The manifest shape itself
 *  comes from `@ninedeploy/schemas`'s `ninedeployManifest` parser. */
export interface ApplyManifestInput {
  manifest: NinedeployManifest;
  /** `merge` (default) preserves fields the manifest omits;
   *  `replace` is per-field (not per-row) and still leaves
   *  unmentioned sections alone. */
  strategy?: 'merge' | 'replace';
}

/**
 * Single row from `GET /v1/databases/:id/drills`. The drill
 * is an engine-specific smoke check (pg_restore --list,
 * redis-check-rdb, mysqldump header parse, ...) that proves
 * a backup is at least parseable without spinning up a real
 * database container. `details` is the engine-specific
 * output (object counts, banner, ...).
 */
export interface BackupDrillResult {
  drillId: number;
  ok: true;
  /** `unverifiable` (r356): the check could not run — docker, the engine
   *  image or its tool unavailable, or a timeout. Not a verdict on the backup. */
  status: 'passed' | 'failed' | 'unverifiable';
  durationMs: number;
  details: Record<string, unknown> | null;
  error: string | null;
}

/** History row from `GET /v1/databases/:id/drills`. */
export interface BackupDrillEntry {
  id: number;
  databaseId: number;
  backupId: number;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'unverifiable';
  engine: string;
  durationMs: number;
  error: string | null;
  details: Record<string, unknown> | null;
  startedAt: number;
  completedAt: number | null;
}

/**
 * Body for `POST /v1/log-drains/search` (G-16). The
 * search round-trips to the configured Loki drain.
 */
export interface LogSearchInput {
  /** Free-text search (case-insensitive substring). */
  query: string;
  /** Restrict to one service. */
  serviceId?: number;
  /** Window length in minutes (default 15). */
  sinceMinutes?: number;
  /** Hard cap on returned lines (default 200, max 1000). */
  limit?: number;
  /** Query a specific drain. */
  drainId?: number;
}

export interface LogSearchLine {
  ts: number;
  line: string;
  service: string | null;
}

export interface LogSearchResult {
  drain: { id: number; name: string; type: string };
  serviceId: number | null;
  window: { since: string; until: string };
  lines: LogSearchLine[];
}

/**
 * Built-in email template names (G-30). The full set
 * lives in `apps/server/src/lib/emailTemplates.ts`; the
 * union here is the closed set the SDK can name. The
 * server validates on the wire (zod enum) — a string
 * the SDK does not know about returns 400.
 */
export type EmailTemplateName =
  | 'password-reset'
  | 'workspace-invitation'
  | 'domain-transfer'
  | 'backup-drill-failed';

/** One row from `GET /v1/workspaces/:wid/email-templates`. */
export interface EmailTemplateEntry {
  name: EmailTemplateName;
  /**
   * 'workspace': the workspace's override is what gets sent. 'instance': the
   * email is about the account (password reset), always sent with the built-in
   * text — a workspace override is refused. Absent from servers before 0.10.38.
   */
  scope?: 'workspace' | 'instance';
  /** False when nothing sends this email yet (override is stored, not used). */
  sent?: boolean;
  /** True when the workspace has an override for this name. */
  overridden: boolean;
  /** Override subject; null when the built-in default applies. */
  subject: string | null;
  /** Override text body; null when the built-in default applies. */
  text: string | null;
}

/** Result of `POST /v1/workspaces/:wid/email-templates/preview`. */
export interface EmailTemplateRender {
  subject: string;
  text: string;
  /** True when the rendered text came from a tenant override. */
  overridden: boolean;
}

/**
 * Result of `GET /v1/databases/:id/pgbouncer` (and the
 * post-mutation body of the enable / disable routes).
 * `pooledConnectionString` is non-null only when `running`
 * is true — a `docker inspect` failure on the sidecar
 * reports `enabled: true, running: false` so the panel
 * can surface the discrepancy.
 */
export interface PgbouncerStatus {
  enabled: boolean;
  containerName: string | null;
  port: number;
  running: boolean;
  poolMode: string | null;
  pooledConnectionString: string | null;
}

/**
 * Single image row from `GET /v1/housekeeping/images`. Both
 * the human-readable `size` ("1.2GB") and a parsed byte
 * count are returned so the panel can sort without
 * re-parsing. `inUse` is true when at least one container
 * is currently using the image id.
 */
export interface ImageInfo {
  repository: string;
  tag: string;
  id: string;
  size: string;
  sizeBytes: number;
  createdAt: string;
  ageHours: number;
  dangling: boolean;
  inUse: boolean;
}

/** Body for `POST /v1/housekeeping/images/prune`. The server
 *  refuses the empty-options combination (it would delete
 *  every image not currently in use). */
export interface PruneImagesInput {
  keepLast?: number;
  olderThanHours?: number;
  danglingOnly?: boolean;
  dryRun?: boolean;
}

export interface PruneImagesResult {
  freedBytes: number;
  removed: string[];
  removedLabels: string[];
  dryRun: boolean;
  output: string;
}

/**
 * r332: the DNS challenge that proves control of a hostname outside this
 * instance's own zone. Publish a TXT record named `recordName` whose value is
 * `recordValue`, then call `domains.verify` — until then the domain is
 * `status: 'pending'` and Traefik does not route it.
 */
export interface DomainVerificationChallenge {
  recordName: string;
  recordType: 'TXT';
  recordValue: string;
}

/** Response of `POST /v1/services/:id/domains`. `verification` is non-null
 *  exactly when the new domain is `pending` ownership proof. */
export type CreatedDomain = Domain & {
  verifiedAt: string | null;
  dnsRecordId: string | null;
  dnsWarning: string | null;
  verification: DomainVerificationChallenge | null;
};

/**
 * Response of `POST /v1/services/:id/domains/:domainId/verify`. Safe to poll:
 * a failed check (`verified: false`) keeps the challenge and says what DNS
 * answered in `error` / `found`; a success flips the domain `active`.
 */
export type DomainVerifyResult = Domain & {
  verifiedAt: string | null;
  verified: boolean;
  verification: DomainVerificationChallenge | null;
  /** Why the check failed (only when `verified` is false). */
  error?: string;
  /** TXT values DNS returned at `recordName` (only when `verified` is false). */
  found?: string[];
  /** Provider DNS-record failure after a successful verify (the domain is live regardless). */
  dnsWarning?: string | null;
};

/**
 * Result of `POST /v1/domains/:id/transfer` (start a
 * transfer). The caller forwards `acceptUrl` to the target
 * user out-of-band; the token is the only secret embedded
 * in the URL.
 */
export interface StartDomainTransferResult {
  ok: boolean;
  transferId: number;
  acceptUrl: string;
  expiresAt: number;
}

/**
 * Result of `GET /v1/domain-transfers/:token` (preview).
 * `effectivelyExpired` is true when the row is still
 * `pending` server-side but `expiresAt` is in the past;
 * the route reports it as `expired` and refuses accept.
 */
export interface DomainTransferPreview {
  id: number;
  status: 'pending' | 'accepted' | 'cancelled' | 'expired';
  hostname: string;
  sourceEmail: string;
  targetEmail: string;
  expiresAt: number;
  createdAt: number;
  acceptedAt: number | null;
  cancelledAt: number | null;
  effectivelyExpired: boolean;
}

/** Body for `POST /v1/domain-transfers/:token/accept`. */
export interface AcceptDomainTransferInput {
  targetServiceId: number;
}

export interface AcceptDomainTransferResult {
  ok: boolean;
  transferId: number;
  domainId: number;
  serviceId: number;
  hostname: string;
}

/** 0.14: the credentials route adds the public endpoint while public access is on. */
export type DatabaseCredentialsWithPublic = DatabaseCredentials & {
  /** Present when public access is enabled; `?sslmode=require` (postgres) in terminate mode. */
  publicConnectionString?: string | null;
};

/** `POST /v1/github-apps/:id/installations/sync` (0.13). */
export interface GithubAppInstallationSync {
  created: number;
  updated: number;
  removed: number;
  sourcesCreated: number;
  /** The installation list hit the page cap; nothing was marked removed. */
  truncated: boolean;
  installations: GithubAppInstallation[];
}

/** A repository row from `sources.repos` (`repoId` only for GitHub App sources, 0.13). */
export interface SourceRepo {
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  isPrivate: boolean;
  repoId?: number;
}

/** `sources.update` input: create fields, plus `baseUrl: null` to clear a Gitea base URL (0.13). */
/**
 * `PATCH /v1/sources/:id`. 0.16 T8: `allowOnNodes` (multi-node) lets a PAT or
 * deploy key be sent to a node for one clone; turning it on needs an
 * interactive session and `password` (step-up). Turning it off never does.
 */
export type SourceUpdateInput = Omit<Partial<CreateSourceInput>, 'baseUrl'> & { baseUrl?: string | null } & Pick<SourcePatch, 'allowOnNodes' | 'pinHostKeys' | 'resetHostKeys' | 'password'>;

// ── end 0.15 T4 ──

// ── 0.16 T8 surfaces ──
/** The node agent's Swarm opt-in: unset, `servers.swarmJoin` answers 422 `node_swarm_not_enabled`. */
export const AGENT_SWARM_MANAGER_VAR = 'NINEDEPLOY_AGENT_SWARM_MANAGER';

/**
 * One `GET /v1/servers` entry. Every field after `lastSeenAt` is additive and
 * absent on older panels: `terminal` (0.15), `agent`, `features`, the build
 * role and `databases` (multi-node), the Swarm membership (0.16 T8).
 */
export interface ServerListEntry {
  id: number;
  name: string;
  host: string;
  port: number;
  status: string;
  lastSeenAt: string | null;
  createdAt?: string;
  terminal?: NodeTerminalCapability;
  /** The persisted capability cache; null until a sealed `agent.ping` answered. */
  agent?: ServerAgentInfo | null;
  /** What the node can do today; `reason` is the "update the node agent" hint. */
  features?: ServerFeatures;
  isBuildServer?: boolean;
  buildConcurrency?: number;
  /** Managed databases hosted on the node. */
  databases?: number;
  /** The node's swarm id once it joined; null = not in the swarm. */
  swarmNodeId?: string | null;
  swarmRole?: SwarmNodeRole | null;
}

/** `PATCH /v1/servers/:id`: the role after the change and the services that build there. */
export interface ServerRolesResult {
  id: number;
  name: string;
  isBuildServer: boolean;
  buildConcurrency: number;
  buildServiceIds: number[];
}

/** `POST /v1/servers/:id/swarm/join`. */
export interface SwarmJoinResult {
  serverId: number;
  nodeId: string;
  role: 'worker';
  /** e.g. the join token could not be rotated, or the member label could not be set. */
  warnings?: string[];
}

/** `POST /v1/servers/:id/swarm/leave`. */
export interface SwarmLeaveResult {
  serverId: number;
  nodeId: string;
  /** false when its tasks had not moved within 5 minutes. */
  drained: boolean;
  warnings?: string[];
}

/** `GET /v1/volumes` entry: node entries (`?serverId=`) carry `serverId`. */
export type VolumeListEntry = VolumeEntry & { serverId?: number | null };

/** `POST /v1/volumes`. */
export interface VolumeCreateResult {
  ok: boolean;
  name: string;
  serverId: number | null;
}

/** `GET /v1/services/:id`: the service plus `placement` (additive). */
export type ServiceDetail = Service & { placement?: ServicePlacementView };

// ── end 0.16 T8 ──

// ── 0.15 T6 surfaces ──
/** `GET /v1/servers` per node (0.15): what the node's agent offers terminals. */
export interface NodeTerminalCapability {
  host: boolean;
  container: boolean;
  /** Why a capability is missing (an older agent, an unreachable node). */
  reason?: string;
}

/** `terminals.list` query. */
export interface TerminalListQuery {
  status?: TerminalSessionStatus;
  userId?: number;
  targetKind?: TerminalTargetKind;
  /** 1–200, default 50. */
  limit?: number;
  /** Page backwards from this session id (`nextBefore` of the previous page). */
  before?: number;
}

/** `traffic.summary` / `traffic.service` query. */
export interface TrafficQuery {
  /** Default 24h. 1h/24h answer minute buckets, 7d/30d hour buckets. */
  range?: TrafficRange;
  /** Top domains, 1–50 (default 10). */
  top?: number;
}

// ── end 0.15 T6 ──

export interface ContainerInspectData {
  id: string;
  name: string;
  image: string;
  state: {
    status: string;
    running: boolean;
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    error: string;
  };
  labels: Record<string, string>;
  traefikTags: Record<string, string>;
  env: string[];
  ports: Record<string, unknown>;
  mounts: Array<{ source: string; destination: string; mode: string; rw: boolean }>;
  networks: string[];
  resources: {
    memoryLimitBytes: number;
    cpuShares: number;
    restartPolicy: string;
  };
  raw: unknown;
}

export interface ContainerComposeData {
  yaml: string;
  inspect: ContainerInspectData;
}
