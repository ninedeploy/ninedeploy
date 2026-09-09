import type {
  ActiveSession,
  ActivityEntry,
  AlertRule,
  AnalyzeRepoInput,
  CreateAlertRuleInput,
  ApiToken,
  PasskeyCredential,
  Attachment,
  CreateServiceVolumeAttachmentInput,
  CreateVolumeBackupInput,
  ServiceVolumeAttachment,
  UpdateServiceVolumeAttachmentInput,
  Backup,
  BackupWithDb,
  ComposePreviewRequestInput,
  ComposePreviewResponse,
  CreateApiTokenInput,
  CreateDatabaseInput,
  CreateDomainInput,
  CreateProjectInput,
  CreateServiceInput,
  CreateSourceInput,
  CreateTunnelInput,
  CreateWebhookInput,
  CreatedApiToken,
  CreatedWebhook,
  ConfigItem,
  ConfigListResponse,
  SetConfigInput,
  DoctorFixRequestInput,
  DoctorFixResponse,
  DoctorReport,
  PluginListResponse,
  PluginInspectResponse,
  InstallPluginInput,
  MarketplaceCatalogResponse,
  MenuListResponse,
  DemoSeedResult,
  Deployment,
  QueueResponse,
  DeployTemplateInput,
  DockerResources,
  Domain,
  DomainPatch,
  DomainEntry,
  EnvVar,
  Label,
  CreateLabelInput,
  LabelPatchInput,
  Environment,
  EnvironmentCreateInput,
  Login,
  ManagedDatabase,
  DatabaseDetail,
  DatabaseCredentials,
  PasswordChange,
  PasswordReset,
  MetricSeries,
  ProjectEntry,
  ProjectPatchInput,
  PublicUser,
  Refresh,
  Register,
  RepoInsights,
  Service,
  ServiceTags,
  SetServiceTagsInput,
  Session,
  SetLimitsInput,
  Source,
  StatsSnapshot,
  Template,
  TemplateSummary,
  CommunityTemplateListResult,
  TopologyGraph,
  TraefikCertificate,
  CertificateInventoryEntry,
  CertificateInventoryReport,
  TraefikInfo,
  TraefikStatus,
  TunnelEntry,
  UserCreate,
  VolumeFileEntry,
  VolumeFileWriteInput,
  VolumePathCreateInput,
  TriggerDeploy,
  UpdateCheckResult,
  SelfUpdateStatus,
  UpdateServiceInput,
  UpsertEnvVarInput,
  VolumeEntry,
  Webhook,
  LogDrain,
  LogDrainCreateInput,
  LogDrainUpdateInput,
  LogDrainTestResult,
  AutoPruneConfigUpdateInput,
  AutoPruneStatus,
  AutoPruneRunResult,
  ServerSshTest,
  ServerSshTestResult,
  ServerSshBootstrap,
  ServerBootstrapResult,
  WorkspaceEntry,
  WorkspaceDetail,
  WorkspaceCreateInput,
  WorkspaceUpdateInput,
  WorkspaceMemberEntry,
  WorkspaceMemberInviteEntry,
  WorkspaceMemberAddInput,
  WorkspaceMemberRoleUpdateInput,
  OidcPublicProvider,
  NinedeployManifest,
  WorkspaceInvitationEntry,
  WorkspaceInvitationPublic,
  WorkspaceRole,
  OidcProviderEntry,
  OidcProviderCreateInput,
  OidcProviderUpdateInput,
} from '@ninedeploy/schemas';
import { NineDeployError } from './errors.js';

export { NineDeployError };
export type * from '@ninedeploy/schemas';
export {
  detectProjectKind,
  formatManifestYaml,
  ManifestParseError,
  ManifestValidationError,
  parseManifestYaml,
  starterManifest,
  buildManifestFromTemplate,
} from './manifest.js';
export type { ProjectKind, TemplateRegistryEntry } from './manifest.js';

/**
 * Minimal structural fetch type so the SDK is isomorphic (browser + Node)
 * without pulling in DOM lib types. Both `globalThis.fetch` implementations
 * satisfy this shape.
 */
export type FetchLike = (input: string, init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface HealthStatus {
  status: string;
  db?: string;
  version?: string;
  time?: string;
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
  status: 'passed' | 'failed';
  durationMs: number;
  details: Record<string, unknown> | null;
  error: string | null;
}

/** History row from `GET /v1/databases/:id/drills`. */
export interface BackupDrillEntry {
  id: number;
  databaseId: number;
  backupId: number;
  status: 'pending' | 'running' | 'passed' | 'failed';
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

export interface NineDeployClientOptions {
  /** Base URL of the NineDeploy API, e.g. http://localhost:3000. */
  baseUrl: string;
  /** Returns the current access token (or bearer credential). */
  getToken?: () => string | undefined | null;
  /**
   * Per-request timeout in milliseconds. A stalled backend must not hang
   * callers forever (worst in CI, where nothing is interactive to Ctrl-C).
   * Defaults to 30_000; pass `0` to disable entirely.
   */
  timeoutMs?: number;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: FetchLike;
}

export interface NineDeployClient {
  auth: {
    status: () => Promise<{ initialized: boolean }>;
    /**
     * Introspect the current bearer token. Returns the
     * token's id (when opaque), name, scopes, expiry and
     * the operator flag. Interactive sessions (JWT) report
     * `scopes: ['session']`. The MCP server uses this to
     * discover the token's authority before registering
     * tools.
     */
    introspectToken: () => Promise<TokenIntrospection>;
    setup: (input: Register) => Promise<Session>;
    register: (input: Register) => Promise<Session>;
    login: (input: Login) => Promise<Session>;
    refresh: (input: Refresh) => Promise<Session>;
    logout: () => Promise<{ ok: boolean }>;
    /** Self-service password change; revokes other sessions, returns a fresh token pair. */
    changePassword: (input: PasswordChange) => Promise<Session>;
    /** Request a reset link (always 200 — no user enumeration). */
    forgotPassword: (email: string) => Promise<{ ok: boolean }>;
    /** Complete a reset with a single-use token; revokes all sessions. */
    resetPasswordWithToken: (input: { token: string; newPassword: string }) => Promise<{ ok: boolean }>;
    twoFactor: {
      /** Generate a pending secret + otpauth URI (auth required). */
      setup: (input?: { password: string }) => Promise<{ secret: string; otpauthUri: string }>;
      enable: (code: string) => Promise<{ ok: boolean; totpEnabled: boolean }>;
      disable: (input: { password: string; code: string }) => Promise<{ ok: boolean; totpEnabled: boolean }>;
    };
    me: () => Promise<PublicUser>;
    tokens: {
      create: (input?: CreateApiTokenInput) => Promise<CreatedApiToken>;
      list: () => Promise<ApiToken[]>;
      remove: (id: number) => Promise<void>;
    };
    passkeys: {
      /** Start a registration ceremony (returns JSON options for the browser API). */
      registerOptions: () => Promise<{ options: string }>;
      /** Complete registration: verify the browser response, store the credential. */
      registerVerify: (input: { name: string; response: unknown }) => Promise<PasskeyCredential>;
      list: () => Promise<PasskeyCredential[]>;
      remove: (id: number) => Promise<void>;
      /** Start a passwordless login ceremony (discoverable credentials). */
      loginOptions: () => Promise<{ options: string }>;
      /** Complete passkey login — returns a full session on success. */
      loginVerify: (response: unknown) => Promise<Session>;
    };
    sessions: {
      list: () => Promise<ActiveSession[]>;
      revoke: (id: number) => Promise<{ ok: boolean }>;
    };
    oidc: {
      publicProviders: () => Promise<OidcPublicProvider[]>;
      listProviders: () => Promise<OidcProviderEntry[]>;
      list: () => Promise<OidcProviderEntry[]>;
      createProvider: (input: OidcProviderCreateInput) => Promise<OidcProviderEntry>;
      create: (input: OidcProviderCreateInput) => Promise<OidcProviderEntry>;
      updateProvider: (id: number, input: OidcProviderUpdateInput) => Promise<OidcProviderEntry>;
      update: (id: number, input: OidcProviderUpdateInput) => Promise<OidcProviderEntry>;
      deleteProvider: (id: number) => Promise<{ ok: boolean }>;
      delete: (id: number) => Promise<{ ok: boolean }>;
      callback: (slug: string, payload: { code: string; state: string }) => Promise<Session>;
    };
  };
  workspaces: {
    list: () => Promise<WorkspaceEntry[]>;
    get: (id: number) => Promise<WorkspaceDetail>;
    create: (input: WorkspaceCreateInput) => Promise<WorkspaceEntry>;
    update: (id: number, input: WorkspaceUpdateInput) => Promise<WorkspaceEntry>;
    delete: (id: number) => Promise<{ ok: boolean }>;
    addMember: (id: number, input: WorkspaceMemberAddInput) => Promise<WorkspaceMemberEntry | WorkspaceMemberInviteEntry>;
    /** Create a pending invitation for an email address that isn't a user yet. */
    inviteMember: (id: number, input: WorkspaceMemberAddInput) => Promise<WorkspaceInvitationEntry & { acceptUrl: string }>;
    listInvitations: (id: number) => Promise<WorkspaceInvitationEntry[]>;
    revokeInvitation: (id: number, inviteId: number) => Promise<{ ok: boolean }>;
    /** Look up a pending invitation by its public token (no auth required). */
    previewInvitation: (token: string) => Promise<WorkspaceInvitationPublic>;
    /** Accept an invitation as the currently authenticated user. */
    acceptInvitation: (token: string) => Promise<{ ok: boolean; workspaceId: number; role: WorkspaceRole }>;
    updateMemberRole: (id: number, memberId: number, input: WorkspaceMemberRoleUpdateInput) => Promise<WorkspaceMemberEntry>;
    removeMember: (id: number, memberId: number) => Promise<{ ok: boolean }>;
  };
  services: {
    /**
     * `query` is appended verbatim. Use `?tagWorkspaceIds=1,2&tagProjectIds=3`
     * to scope the list by tag (each dimension ANDs, members within a
     * dimension OR). The legacy `?projectId=` query is no longer accepted.
     */
    list: (query?: string) => Promise<Service[]>;
    get: (id: number) => Promise<Service>;
    create: (input: CreateServiceInput) => Promise<Service>;
    update: (id: number, input: UpdateServiceInput) => Promise<Service>;
    /**
     * Dry-run a compose file before creating anything: blocking reasons,
     * host-privilege warnings, the declared services and the variables the
     * stack will ask for. Admin-only, and writes nothing.
     */
    composePreview: (input: ComposePreviewRequestInput) => Promise<ComposePreviewResponse>;
    remove: (id: number) => Promise<void>;
    stop: (id: number) => Promise<{ ok: boolean; status: string }>;
    start: (id: number) => Promise<{ ok: boolean; status: string }>;
    restart: (id: number) => Promise<{ ok: boolean; status: string }>;
    logs: (id: number) => Promise<{ lines: string }>;
    clone: (id: number, input?: { name?: string; slug?: string }) => Promise<Service>;
    exportUrl: (id: number) => string;
    importBundle: (bundle: unknown) => Promise<{ ok: boolean; serviceId: number; slug: string; message: string }>;
    /**
     * `.ninedeploy` manifest endpoints. The server applies
     * build / run / network sections to the service + build
     * config rows (operator > manifest > DB merge semantics);
     * routes / alerts / database reconcile happens at deploy
     * time via the deploy pipeline and is intentionally
     * outside this endpoint's scope.
     */
    manifest: {
      /**
       * Push a parsed manifest to the panel and reconcile it
       * into the service. Requires the `admin` role on the
       * service. The response echoes the diff so the CLI can
       * render a one-shot summary without a follow-up GET.
       */
      apply: (serviceId: number, input: ApplyManifestInput) => Promise<ApplyManifestResult>;
    };
  };
  labels: {
    /** `query` is appended verbatim, e.g. `?workspaceId=1`. */
    list: (query?: string) => Promise<Label[]>;
    create: (input: CreateLabelInput) => Promise<Label>;
    update: (id: number, input: LabelPatchInput) => Promise<Label>;
    remove: (id: number) => Promise<{ ok: boolean }>;
  };
  /** Deployment lanes (production / staging / development) per workspace. */
  environments: {
    list: () => Promise<Environment[]>;
    create: (input: EnvironmentCreateInput) => Promise<Environment>;
    rename: (id: number, name: string) => Promise<Environment>;
    remove: (id: number) => Promise<{ ok: boolean }>;
  };
  serviceTags: {
    /** Read the project's / workspace's / label memberships of a service. */
    get: (serviceId: number) => Promise<ServiceTags>;
    /** Replace the membership in a single round-trip. Empty arrays clear. */
    set: (serviceId: number, input: SetServiceTagsInput) => Promise<ServiceTags>;
  };
  deploys: {
    trigger: (serviceId: number, input?: TriggerDeploy) => Promise<{ deploymentId: number }>;
    list: (serviceId: number) => Promise<Deployment[]>;
    /**
     * Global deploy queue view: every in-flight (queued / building /
     * deploying) deployment the caller can see, with service + project
     * metadata. The optional `status` filter is a comma-separated token
     * list (e.g. `?status=queued,building`).
     */
    queue: (query?: string) => Promise<QueueResponse>;
    rollback: (serviceId: number, deploymentId: number) => Promise<{ deploymentId: number }>;
    /** Cancel a queued/in-flight deployment (checkpoints abort at step boundaries). */
    cancel: (serviceId: number, deploymentId: number) => Promise<{ ok: boolean; status: string }>;
    /**
     * Remove a finished deployment from history, with its build log.
     * Refused for an in-flight deployment (cancel it first) and for the one
     * currently serving traffic. Requires the `admin` role on the service.
     */
    remove: (serviceId: number, deploymentId: number) => Promise<{ ok: boolean; id: number }>;
    /** Build-config + env-key diff against the previous deployment. */
    configDiff: (serviceId: number, deploymentId: number) => Promise<{ deploymentId: number; previousDeploymentId: number | null; changed: boolean; diff: string }>;
    /**
     * Promote: deploy ANOTHER service at this service's exact running
     * commit — the staging → production lane hop. Both services must
     * track the same repository and the caller needs `member` on both.
     */
    promote: (serviceId: number, targetServiceId: number) => Promise<{ ok: boolean; deploymentId: number; commitSha: string; promotedFrom: string }>;
  };
  domains: {
    list: (serviceId: number) => Promise<Domain[]>;
    create: (serviceId: number, input: CreateDomainInput) => Promise<Domain>;
    remove: (serviceId: number, domainId: number) => Promise<void>;
    /** Update routing extras: ssl toggle, www→apex redirect, custom headers, basicAuth, ipAllowlist, rateLimit. */
    update: (serviceId: number, domainId: number, input: DomainPatch) => Promise<Domain>;
    all: () => Promise<DomainEntry[]>;
    setSsl: (domainId: number, ssl: boolean) => Promise<{ id: number; ssl: boolean }>;
    /** Toggle sticky-session routing for the service (G-28). */
    setStickySession: (serviceId: number, enabled: boolean) => Promise<{ id: number; enabled: boolean; active: boolean }>;
    /**
     * Start a domain transfer (G-29). The source user (admin
     * on the source service) names the target email; the
     * server returns a one-time `acceptUrl` to forward. The
     * target user accepts via `acceptDomainTransfer(token,
     * { targetServiceId })`. The transfer expires after 7
     * days; cancelling is one call.
     */
    transfer: (domainId: number, input: { targetEmail: string }) => Promise<StartDomainTransferResult>;
    /**
     * Preview a transfer by token. Does NOT require auth
     * (the token is the secret) — the panel uses this to
     * render the accept page to a logged-out visitor.
     */
    previewTransfer: (token: string) => Promise<DomainTransferPreview>;
    /**
     * Accept a transfer. The caller must be authenticated
     * and the caller's email must equal the transfer's
     * target email; the panel / CLI surfaces the preview
     * first so the user knows what they're signing in to.
     */
    acceptTransfer: (token: string, input: AcceptDomainTransferInput) => Promise<AcceptDomainTransferResult>;
    /**
     * Cancel a pending transfer. Only the source user
     * (or an instance operator) can cancel.
     */
    cancelTransfer: (token: string) => Promise<{ transferId: number; status: 'cancelled' }>;
  };
  domainPresets: {
    /** Every `IDomainProvider` the running kernel has registered. */
    list: () => Promise<{ providers: string[] }>;
    /**
     * Manually create the DNS record for `hostname` via the operator's
     * active provider. `content` is optional: when omitted the route
     * falls back to the panel's `dns_records_content` setting, then to
     * `detectPublicIp()`. Returns the upstream recordId so the caller
     * can correlate.
     */
    apply: (input: { hostname: string; content?: string }) => Promise<{
      hostname: string;
      provider: string;
      zone: string;
      recordId: string;
      type: 'A' | 'CNAME';
      content: string;
    }>;
  };
  configPresets: {
    /** Every preset the kernel has registered. */
    list: () => Promise<{ presets: string[] }>;
    /** Fetch a single preset's values + description. */
    get: (id: string) => Promise<{
      id: string;
      description: string | null;
      values: Record<string, unknown>;
      createdAt: string;
    }>;
    /** Register a new preset. Throws if `id` already exists. */
    register: (input: { id: string; description?: string; values: Record<string, unknown> }) => Promise<{ ok: boolean; id: string; keyCount: number }>;
    /** Write every value in the preset to the live configCenter. */
    apply: (id: string, opts?: { override?: Record<string, unknown> }) => Promise<{
      ok: boolean;
      id: string;
      keyCount: number;
      failureCount?: number;
      failures?: Array<{ key: string; status: 'failed'; reason?: string }>;
    }>;
    /** Unregister a preset. Does NOT undo the apply. */
    remove: (id: string) => Promise<{ ok: boolean; id: string }>;
  };
  metricHistory: {
    /** Current configuration snapshot (backend choice, enabled flag, retention, last-flush). */
    get: () => Promise<{
      enabled: boolean;
      backend: 'builtin' | 'prometheus' | 'influxdb';
      events: string[];
      retentionDays: number;
      lastFlush: { ts: number; backend: string; count: number };
    }>;
    /** Run the built-in backend's retention sweep. Returns the row count trimmed. */
    flush: () => Promise<{ ok: boolean; backend: 'builtin'; deleted: number }>;
  };
  buildCache: {
    /** Per-backend counters + merged totals. G-01 PR-A. */
    stats: () => Promise<{
      backends: Array<{
        name: string;
        entries: number;
        totalBytes: number;
        hits: number;
        misses: number;
        stores: number;
        evictions: number;
      }>;
      totals: {
        entries: number;
        totalBytes: number;
        hits: number;
        misses: number;
        stores: number;
        evictions: number;
      };
    }>;
  };
  orchestrators: {
    /** Every `IOrchestrator` the running kernel has registered. G-10 PR-A. */
    list: () => Promise<{
      orchestrators: Array<{ name: string; stacks: Array<{ name: string; serviceCount: number }> }>;
    }>;
    /** The stacks one orchestrator knows about. */
    stacks: (orchestrator: string) => Promise<{
      stacks: Array<{ name: string; serviceCount: number }>;
    }>;
    /**
     * Stable snapshot of ONE stack. Returns `null` when the orchestrator has
     * no record of it.
     *
     * r036: this used to take only the orchestrator name and hit
     * `/:name/stacks`, which passed that name through as the STACK name — so
     * it answered `null` for every stack not coincidentally named after its
     * orchestrator. The stack now has its own argument and path segment.
     */
    stackStatus: (orchestrator: string, stack: string) => Promise<{
      name: string;
      services: Array<{ name: string; state: 'running' | 'stopped' | 'partial' | 'unknown'; replicas: number }>;
      appliedAt: string;
    } | null>;
  };
  branding: {
    /** Read the four operator-overridable branding fields. G-30. */
    get: () => Promise<{
      logoUrl: string | null;
      primaryColor: string | null;
      supportEmail: string | null;
      footerHtml: string | null;
    }>;
    /** Set one or more branding fields. Empty strings are stored as `null`. */
    set: (input: {
      logoUrl?: string | null;
      primaryColor?: string | null;
      supportEmail?: string | null;
      footerHtml?: string | null;
    }) => Promise<{ ok: boolean }>;
  };
  egress: {
    /** Every egress IP rule across every registered driver. G-15. */
    list: () => Promise<{
      drivers: Array<{
        name: string;
        rules: Array<{
          selector: { projectId: number; sourceCidr?: string };
          ip: string;
          createdAt: string;
        }>;
      }>;
    }>;
    /** Attach an egress IP to a project on the named (or first) driver. */
    set: (input: { projectId: number; ip: string; driver?: string }) => Promise<{
      ok: boolean;
      driver: string;
      rule: { selector: { projectId: number; sourceCidr?: string }; ip: string; createdAt: string };
    }>;
    /** Detach the rule for a project. */
    clear: (projectId: number) => Promise<{ ok: boolean; driver: string }>;
  };
  sso: {
    /** Every configured OIDC / SAML provider. G-22. */
    listProviders: () => Promise<{
      providers: Array<{ id: number; type: 'oidc' | 'saml'; name: string; createdAt: string }>;
    }>;
    /** Add a provider (OIDC issuer URL or SAML metadata URL lives in `config`). */
    addProvider: (input: {
      type: 'oidc' | 'saml';
      name: string;
      config: Record<string, unknown>;
    }) => Promise<{ ok: boolean; id?: number; name?: string; type?: 'oidc' | 'saml'; error?: string }>;
    /** Remove a provider by id. */
    removeProvider: (id: number) => Promise<{ ok: boolean }>;
  };
  volumes: {
    list: () => Promise<VolumeEntry[]>;
    remove: (name: string) => Promise<void>;
    prune: () => Promise<{ ok: boolean; deleted: number; freedBytes: number }>;
    /** File manager: list a directory inside the volume. */
    listFiles: (name: string, path?: string) => Promise<{ path: string; entries: VolumeFileEntry[] }>;
    /** File manager: read a file (base64 content). */
    readFile: (name: string, path: string) => Promise<{ content: string; encoding: 'utf8' | 'base64' }>;
    /** File manager: write/overwrite a file (base64 content). */
    writeFile: (name: string, input: VolumeFileWriteInput) => Promise<{ ok: boolean }>;
    /** File manager: create a directory. */
    mkdir: (name: string, input: VolumePathCreateInput) => Promise<{ ok: boolean }>;
    /** File manager: delete a file or directory (recursive). */
    deleteFile: (name: string, path: string) => Promise<void>;
  };
  containers: {
    inspect: (container: string) => Promise<ContainerInspectData>;
    compose: (container: string) => Promise<ContainerComposeData>;
    /** File manager: list a directory inside the container. */
    listFiles: (container: string, path?: string) => Promise<{ path: string; entries: VolumeFileEntry[] }>;
    /** File manager: read a file (base64 content). */
    readFile: (container: string, path: string) => Promise<{ content: string; encoding: 'utf8' | 'base64' }>;
    /** File manager: write/overwrite a file (base64 content). */
    writeFile: (container: string, input: VolumeFileWriteInput) => Promise<{ ok: boolean }>;
    /** File manager: create a directory. */
    mkdir: (container: string, input: VolumePathCreateInput) => Promise<{ ok: boolean }>;
    makeDir: (container: string, input: VolumePathCreateInput) => Promise<{ ok: boolean }>;
    /** File manager: delete a file or directory (recursive). */
    deleteFile: (container: string, path: string) => Promise<void>;
    deletePath: (container: string, path: string) => Promise<void>;
  };
  system: {
    resources: () => Promise<DockerResources>;
    pruneImages: () => Promise<{ ok: boolean }>;
    exportUrl: () => string;
    /** Latest-release check (admin). updateAvailable is null when offline/disabled. */
    updateCheck: (force?: boolean) => Promise<UpdateCheckResult>;
    /** State of a panel-initiated upgrade (idle/running/success/failed/unsupported). */
    updateStatus: () => Promise<SelfUpdateStatus>;
    /** Start upgrading the panel itself to an exact release tag; the updater survives the restart it performs. */
    updateStart: (version: string) => Promise<{ ok: boolean }>;
    /** Recent docker daemon events (single-shot, for the Docker dashboard feed). */
    dockerEvents: (minutes?: number) => Promise<{ events: Array<{ time: string; type: string; action: string; name: string }> }>;
  };
  networks: {
    list: () => Promise<{
      networks: Array<{
        name: string;
        driver: string;
        members: string[];
        /** True when the network is reserved by NineDeploy (cannot be removed). */
        isManaged?: boolean;
      }>;
      remote: number | null;
    }>;
    create: (input: { name: string; driver?: 'bridge' | 'overlay'; serverId?: number | null }) => Promise<{ ok: boolean; name: string }>;
    remove: (name: string, serverId?: number) => Promise<{ ok: boolean }>;
    attach: (input: { network: string; container: string; serverId?: number | null }) => Promise<{ ok: boolean }>;
    detach: (input: { network: string; container: string; serverId?: number | null }) => Promise<{ ok: boolean }>;
  };
  tunnels: {
    list: () => Promise<TunnelEntry[]>;
    create: (input: CreateTunnelInput) => Promise<TunnelEntry>;
    remove: (id: number) => Promise<void>;
  };
  activity: {
    /** Filter + paginate the audit trail. Omitted filters return the newest page. */
    list: (query?: { entity?: string; action?: string; userId?: number; before?: number }) => Promise<{ entries: ActivityEntry[]; nextCursor: number | null }>;
  };
  alerts: {
    list: () => Promise<AlertRule[]>;
    create: (input: CreateAlertRuleInput) => Promise<AlertRule>;
    update: (id: number, input: Partial<CreateAlertRuleInput>) => Promise<AlertRule>;
    remove: (id: number) => Promise<void>;
  };
  settings: {
    get: () => Promise<{ allowRegistration: boolean; acmeEmail: string | null; templatesSource: string | null; dnsProvider: string | null; hasDnsToken: boolean; wildcardApex: string | null; panelDomain: string | null }>;
    setPanelDomain: (domain: string) => Promise<{ ok: boolean; panelDomain: string | null }>;
    setAllowRegistration: (enabled: boolean) => Promise<{ ok: boolean; allowRegistration: boolean }>;
    setAcmeEmail: (email: string) => Promise<{ ok: boolean; acmeEmail: string | null; applied: string }>;
    setTemplatesSource: (source: string) => Promise<{ ok: boolean; templatesSource: string | null }>;
    /** Configure the ACME DNS-01 challenge (wildcard certificates). */
    setDns: (input: { provider: string; token?: string; wildcardApex: string }) => Promise<{ ok: boolean; dnsProvider: string | null; wildcardApex: string | null; applied: string }>;
    /** Vault provider (deploy-time secret resolution). */
    vault: {
      get: () => Promise<{ provider: string | null; hasToken: boolean; projectId: string | null; environment: string | null }>;
      set: (input: { provider: '' | 'infisical' | 'doppler'; token?: string; projectId?: string; environment?: string }) => Promise<{ ok: boolean; provider: string | null }>;
      test: () => Promise<{ ok: boolean; secrets: number }>;
    };
    /** Cloudflare DNS-record auto-provisioning for added domains. */
    dnsRecords: {
      get: () => Promise<{ enabled: boolean; hasToken: boolean; content: string | null }>;
      set: (input: { enabled: boolean; token?: string; content?: string }) => Promise<{ ok: boolean; enabled: boolean }>;
      test: () => Promise<{ ok: boolean; status?: string; error?: string }>;
    };
    /** Namecheap DNS-record auto-provisioning for added domains (G-07 PR-A). */
    namecheap: {
      get: () => Promise<{ configured: boolean; apiUser: string | null; clientIp: string | null; hasKey: boolean }>;
      set: (input: { apiUser: string; apiKey: string; clientIp: string }) => Promise<{ ok: boolean; apiUser: string }>;
    };
    /**
     * Master-key rotation. `rotate` re-encrypts every stored secret onto the
     * highest key version in `NINEDEPLOY_MASTER_KEYS`; it does NOT rewrite
     * backup envelopes, which is what `warning` reports.
     */
    masterKey: {
      get: () => Promise<{ activeVersion: number; knownVersions: number[]; rotatable: boolean }>;
      rotate: () => Promise<{ rotated: number; activeVersion: number; backupsNotRotated: number; warning: string | null }>;
    };
  };
  firewall: {
    status: () => Promise<{
      installed: boolean;
      active: boolean;
      supported: boolean;
      rules: Array<{ id: number; to: string; action: string; from: string; comment?: string }>;
      defaultIncoming: string;
      defaultOutgoing: string;
    }>;
    toggle: (enabled: boolean) => Promise<{ ok: boolean; status: any }>;
    addRule: (input: { port: number | string; proto?: 'tcp' | 'udp' | 'any'; action?: 'allow' | 'deny' | 'limit'; from?: string; comment?: string }) => Promise<{ ok: boolean; status: any }>;
    deleteRule: (id: number | string) => Promise<{ ok: boolean; status: any }>;
    applyRecommended: () => Promise<{ ok: boolean; status: any }>;
  };
  users: {
    list: () => Promise<PublicUser[]>;
    /**
     * Operator-only: create a user directly (no registration flow needed).
     * The new account has no workspace memberships — an existing owner/admin
     * must invite it into at least one workspace before it can act.
     */
    create: (input: UserCreate) => Promise<PublicUser>;
    /**
     * Operator-only: delete a user. The `users.role` column was removed when
     * authorization became workspace-only; the legacy `setRole` is gone with
     * it. Role changes go through `workspaces.updateMemberRole`.
     */
    remove: (id: number) => Promise<void>;
    /** Operator reset of another user's password (revokes their sessions). */
    resetPassword: (id: number, input: PasswordReset) => Promise<{ ok: boolean }>;
    /** Mint a one-time reset link for a user (returned exactly once). */
    resetLink: (id: number) => Promise<{ url: string; expiresAt: string }>;
    /**
     * Operator-only: grant or revoke the INSTANCE-operator flag.
     *
     * Not a workspace role — this is the flag that gates operator-only routes
     * and the host-privilege boundary (PM2/compose deploys, lifecycle hooks,
     * docker-socket templates). Creating a workspace does NOT confer it. The
     * last remaining operator cannot be demoted.
     */
    setOperator: (id: number, isOperator: boolean) => Promise<{ ok: boolean; id: number; isOperator: boolean }>;
  };
  projects: {
    /** `query` is appended verbatim, e.g. `?workspaceId=2` (workspace scoping). */
    list: (query?: string) => Promise<ProjectEntry[]>;
    create: (input: CreateProjectInput) => Promise<ProjectEntry>;
    update: (id: number, input: ProjectPatchInput) => Promise<ProjectEntry>;
    remove: (id: number) => Promise<{ ok: boolean }>;
  };
  about: {
    get: () => Promise<{
      name: string; version: string; description: string; license: string; repo: string; docs: string;
      techStack: Array<{ category: string; items: string[] }>;
      changelog: Array<{ version: string; date: string; title: string; changes: string[] }>;
      /** Instance counts are only returned for authenticated requests. */
      stats?: { services: number; databases: number; deployments: number; users: number };
    }>;
  };
  notifications: {
    listChannels: () => Promise<Array<{ id: number; name: string; type: string; eventFilter: string; active: boolean; configJson: string | null; createdAt: string }>>;
    createChannel: (input: { name: string; type: string; target: string; eventFilter?: string; configJson?: string | null }) => Promise<{ id: number; name: string; type: string }>;
    updateChannel: (id: number, input: { name?: string; target?: string; eventFilter?: string; active?: boolean; configJson?: string | null }) => Promise<{ id: number; active: boolean }>;
    removeChannel: (id: number) => Promise<void>;
    testChannel: (id: number) => Promise<{ ok: boolean }>;
    log: () => Promise<Array<{ id: number; channelId: number | null; event: string; entity: string | null; status: string; error: string | null; ts: string }>>;
  };
  sources: {
    list: () => Promise<Source[]>;
    create: (input: CreateSourceInput) => Promise<Source>;
    update: (id: number, input: Partial<CreateSourceInput>) => Promise<Source>;
    remove: (id: number) => Promise<void>;
    repos: (id: number) => Promise<Array<{ name: string; fullName: string; url: string; defaultBranch: string; isPrivate: boolean }>>;
    branches: (id: number, repo: string) => Promise<string[]>;
    /** Live credential check — proves a stored token still authenticates. */
    test: (id: number) => Promise<{ ok: boolean; provider?: string; login?: string; name?: string | null; status?: number; error?: string }>;
    /**
     * Server-side generation of an ed25519 deploy key pair. The private key
     * is encrypted into the source row and never leaves the server; only the
     * public key and fingerprint are returned (the operator pastes the public
     * key into the Git provider's "Deploy keys" UI).
     */
    generateDeployKey: (id: number) => Promise<{ publicKey: string; fingerprint: string }>;
  };
  insights: {
    /** Pre-deploy repository inspection (DeployWizard): clone + framework detection. */
    analyze: (input: AnalyzeRepoInput) => Promise<RepoInsights>;
    /** Latest stored analysis for a service (null before the first deploy/refresh). */
    get: (serviceId: number) => Promise<RepoInsights | null>;
    /** Re-analyze the service's repository now and store the result. */
    refresh: (serviceId: number) => Promise<RepoInsights>;
  };
  webhooks: {
    list: (serviceId: number) => Promise<Webhook[]>;
    create: (serviceId: number, input?: CreateWebhookInput) => Promise<CreatedWebhook>;
    remove: (serviceId: number, hookId: number) => Promise<void>;
  };
  databases: {
    /** `query` is appended verbatim, e.g. `?projectId=3` (project scoping). */
    list: (query?: string) => Promise<ManagedDatabase[]>;
    create: (input: CreateDatabaseInput) => Promise<ManagedDatabase>;
    get: (id: number) => Promise<DatabaseDetail>;
    remove: (id: number, options?: { force?: boolean }) => Promise<void>;
    restart: (id: number) => Promise<void>;
    stop: (id: number) => Promise<void>;
    start: (id: number) => Promise<void>;
    logs: (id: number, lines?: number) => Promise<{ logs: string[] }>;
    credentials: (id: number) => Promise<DatabaseCredentials>;
    setLimits: (id: number, input: SetLimitsInput) => Promise<{ cpuShares: number | null; memLimitMb: number | null }>;
    startStudio: (id: number, port?: number) => Promise<{ ok: boolean; port: number; url: string }>;
    stopStudio: (id: number) => Promise<{ ok: boolean }>;
    /**
     * PgBouncer sidecar (G-32). Returns the current sidecar
     * state — `enabled` + `running` + the URL the services
     * should connect to. Use the same call after
     * `enablePgbouncer` / `disablePgbouncer` for a fresh
     * read (the route returns the post-mutation status).
     */
    pgbouncerStatus: (id: number) => Promise<PgbouncerStatus>;
    /**
     * Spin up the sidecar. `port` is optional — the row's
     * existing `pgbouncerPort` (default 6432) is used
     * when omitted. Only `engine='postgres'` is supported;
     * the server returns 422 for any other engine.
     */
    enablePgbouncer: (id: number, input?: { port?: number }) => Promise<PgbouncerStatus>;
    /** Stop + remove the sidecar and clear the row's flags. */
    disablePgbouncer: (id: number) => Promise<PgbouncerStatus>;
    /**
     * Run an engine-specific smoke check against a backup
     * file (pg_restore --list, redis-check-rdb, mysqldump
     * header parse, ...). Returns the drill row with `status`
     * of `passed` or `failed`; a failed drill is a real
     * signal that the backup cannot be restored cleanly, not
     * a warning. Requires the `member` role on the database.
     */
    drillBackup: (id: number, input: { backupId: number }) => Promise<BackupDrillResult>;
    /** List the most recent drills for a database, newest first. */
    drills: (id: number) => Promise<BackupDrillEntry[]>;
  };
  attachments: {
    list: (serviceId: number) => Promise<Attachment[]>;
    create: (serviceId: number, input: { databaseId: number; envAlias?: string; reuseExisting?: boolean }) => Promise<Attachment>;
    remove: (serviceId: number, attachmentId: number) => Promise<void>;
  };
  /** Per-volume backup history. The base URL is `/v1/volumes/:name/backups`;
   *  restore + download go through the same path. The global `/v1/backups`
   *  list/delete are exposed as `backups` below. */
  volumeBackups: {
    list: (volumeName: string) => Promise<Backup[]>;
    create: (volumeName: string, input: CreateVolumeBackupInput) => Promise<Backup>;
    restore: (volumeName: string, backupId: number) => Promise<{ ok: boolean }>;
    downloadUrl: (volumeName: string, backupId: number) => string;
  };
  /** Per-service additional volume attachments. Distinct from the instance-wide
   * `volumes` namespace (which lists every Docker volume on the host). The
   * list endpoint returns runtime-computed metadata (size, in-use, sharing);
   * the create/update endpoints return the database row only. */
  serviceVolumes: {
    list: (serviceId: number) => Promise<Array<ServiceVolumeAttachment & { sizeBytes: number; inUse: boolean; sharedWith: number }>>;
    /** Attach an existing managed volume or create a new one and attach it. */
    create: (serviceId: number, input: CreateServiceVolumeAttachmentInput) => Promise<{ attachment: ServiceVolumeAttachment; deploymentId: number }>;
    update: (serviceId: number, attachmentId: number, input: UpdateServiceVolumeAttachmentInput) => Promise<{ attachment: ServiceVolumeAttachment; deploymentId: number }>;
    /** Detach. The underlying Docker volume is NOT deleted (data persists). */
    remove: (serviceId: number, attachmentId: number) => Promise<void>;
    /** Delete a first-boot-baked config file from the volume and queue a
     *  redeploy so the app regenerates it from the current environment
     *  (WordPress wp-config.php et al.). Exactly one of `attachmentId` /
     *  `volumeName` must be set; `filePath` is a single path segment. */
    repairConfig: (
      serviceId: number,
      input: { filePath: string; attachmentId?: number; volumeName?: string },
    ) => Promise<{ ok: boolean; deploymentId: number }>;
  };
  env: {
    list: (serviceId: number) => Promise<EnvVar[]>;
    create: (serviceId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    update: (serviceId: number, varId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    remove: (serviceId: number, varId: number) => Promise<void>;
    /** Cross-scope key search: where a given env key is defined. */
    search: (q: string) => Promise<{ results: Array<{ key: string; isSecret: boolean; scope: string; serviceId: number | null; serviceName: string | null }> }>;
  };
  projectEnv: {
    /** Shared env vars applied to every service in a project (service env wins). */
    list: (projectId: number) => Promise<EnvVar[]>;
    create: (projectId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    update: (projectId: number, varId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    remove: (projectId: number, varId: number) => Promise<void>;
  };
  stats: {
    snapshot: () => Promise<StatsSnapshot>;
    metrics: (serviceId: number, opts?: { kind?: 'cpu' | 'memory'; minutes?: number }) => Promise<MetricSeries>;
  };
  dashboard: {
    get: () => Promise<{
      stats: { services: number; databases: number; deployments: number; domains: number; webhooks: number; running: number; stopped: number; errored: number; dbRunning: number; containers: number };
      health: Array<{ serviceId: number; name: string; slug: string; type: string; status: string; healthy: boolean; responseMs: number | null; port: number | null; runtimeId: string | null; commitSha: string | null; lastDeploy: string | null }>;
      recentDeploys: Array<{ id: number; serviceId: number; serviceName: string; status: string; commitSha: string | null; message: string | null; trigger: string; finishedAt: string | null; createdAt: string }>;
    }>;
  };
  topology: {
    get: () => Promise<TopologyGraph>;
  };
  backups: {
    storage: (databaseId: number) => Promise<{ sizeBytes: number }>;
    backupNow: (databaseId: number) => Promise<Backup>;
    listForDb: (databaseId: number) => Promise<Backup[]>;
    restore: (databaseId: number, backupId: number) => Promise<{ ok: boolean }>;
    list: () => Promise<BackupWithDb[]>;
    remove: (backupId: number) => Promise<void>;
    downloadUrl: (backupId: number) => string;
  };
  backupDestinations: {
    list: () => Promise<Array<{ id: number; name: string; endpoint: string; region: string; bucket: string; prefix: string; active: boolean; createdAt: string }>>;
    create: (input: { name: string; endpoint: string; region?: string; bucket: string; prefix?: string; accessKeyId: string; secretAccessKey: string }) => Promise<{ id: number }>;
    update: (id: number, input: Partial<{ name: string; endpoint: string; region: string; bucket: string; prefix: string; active: boolean; accessKeyId: string; secretAccessKey: string }>) => Promise<{ ok: boolean }>;
    remove: (id: number) => Promise<{ ok: boolean }>;
    test: (id: number) => Promise<{ ok: boolean }>;
  };
  jobs: {
    list: (serviceId: number) => Promise<Array<{ id: number; name: string; cron: string; kind: 'deploy' | 'exec'; command: string; enabled: boolean; lastRunAt: string | null }>>;
    create: (serviceId: number, input: { name: string; cron: string; kind: 'deploy' | 'exec'; command?: string; enabled?: boolean }) => Promise<{ id: number }>;
    update: (serviceId: number, jobId: number, input: Partial<{ name: string; cron: string; kind: 'deploy' | 'exec'; command: string; enabled: boolean }>) => Promise<{ ok: boolean }>;
    remove: (serviceId: number, jobId: number) => Promise<{ ok: boolean }>;
    run: (serviceId: number, jobId: number) => Promise<{ ok: boolean }>;
    runs: (serviceId: number, jobId: number) => Promise<Array<{ id: number; status: string; output: string; exitCode: number | null; createdAt: string }>>;
  };
  servers: {
    list: () => Promise<Array<{ id: number; name: string; host: string; port: number; status: string; lastSeenAt: string | null }>>;
    /** Register a server — the agent token + its sha256 are returned exactly once. */
    create: (input: { name: string; host: string; port?: number }) => Promise<{ id: number; token: string; tokenSha256: string; agentCommand: string }>;
    remove: (id: number, options?: { force?: boolean }) => Promise<{ ok: boolean }>;
    test: (id: number) => Promise<{ ok: boolean; status: string }>;
    approve: (id: number) => Promise<{ ok: boolean; status: string }>;
    reject: (id: number) => Promise<{ ok: boolean }>;
    sshTest: (input: ServerSshTest) => Promise<ServerSshTestResult>;
    sshBootstrap: (input: ServerSshBootstrap) => Promise<ServerBootstrapResult>;
    bootstrapLogs: (id: number) => Promise<{ logs: string[] }>;
  };
  templates: {
    list: () => Promise<TemplateSummary[]>;
    get: (id: string) => Promise<Template>;
    prepare: (id: string, input?: DeployTemplateInput) => Promise<TemplatePrepareResult>;
    deploy: (id: string, input?: DeployTemplateInput) => Promise<TemplateDeployResult>;
    /**
     * Community contributions (G-13). The `list` call
     * already merges community entries with the curated
     * catalog; the dedicated `community` namespace lets
     * the panel surface errors and the operator import
     * a new template from a PR comment or a file.
     */
    community: {
      list: () => Promise<CommunityTemplateListResult>;
      import: (content: string, opts?: { replace?: boolean }) => Promise<{ ok: boolean; id: string; file: string; bytes: number }>;
      remove: (id: string) => Promise<{ ok: boolean; id: string; removed: boolean }>;
    };
  };
  limits: {
    setService: (serviceId: number, input: SetLimitsInput) => Promise<{ cpuShares: number; memLimitMb: number }>;
    setDatabase: (databaseId: number, input: SetLimitsInput) => Promise<{ cpuShares: number; memLimitMb: number }>;
  };
  traefik: {
    get: () => Promise<TraefikInfo>;
    status: () => Promise<TraefikStatus>;
    certificates: () => Promise<TraefikCertificate[]>;
    /**
     * Richer certificate inventory (G-15). Same
     * underlying data as `certificates()` but adds a
     * `status` classification (valid / expiring-soon /
     * expired), a `summary` block, and the full set of
     * fields the Certificates page renders.
     * `threshold` is the days-out cutoff for the
     * `expiring-soon` bucket; default 30.
     */
    certificateInventory: (opts?: { threshold?: number }) => Promise<CertificateInventoryReport>;
    /**
     * Focused "expiring within N days" filter. Default
     * 30. Used by the alert engine and by the panel's
     * "About to expire" widget.
     */
    expiringCertificates: (opts?: { days?: number }) => Promise<{ threshold: number; count: number; certificates: CertificateInventoryEntry[] }>;
    logs: (lines?: number) => Promise<{ logs: string[] }>;
    restart: () => Promise<{ ok: boolean; message?: string }>;
    backupCerts: () => Promise<{ ok: boolean; message?: string; filename?: string }>;
  };
  config: {
    list: (query?: { category?: string; pluginId?: string; reveal?: boolean }) => Promise<ConfigListResponse>;
    get: (key: string) => Promise<ConfigItem>;
    set: (key: string, input: SetConfigInput) => Promise<{ ok: boolean; key: string }>;
    delete: (key: string) => Promise<{ ok: boolean; key: string }>;
  };
  plugins: {
    list: () => Promise<PluginListResponse>;
    marketplace: (opts?: { refresh?: boolean }) => Promise<MarketplaceCatalogResponse>;
    install: (input: InstallPluginInput) => Promise<{ ok: boolean; id: string; status: string }>;
    enable: (id: string) => Promise<{ ok: boolean; id: string; status: string }>;
    disable: (id: string) => Promise<{ ok: boolean; id: string; status: string }>;
    reload: (id: string) => Promise<{ ok: boolean; id: string; status: string }>;
    inspect: (id: string) => Promise<PluginInspectResponse>;
    uninstall: (id: string) => Promise<{ ok: boolean; id: string }>;
  };
  menus: {
    list: (query?: { slot?: string }) => Promise<MenuListResponse>;
  };
  demo: {
    seed: () => Promise<DemoSeedResult>;
  };
  logDrains: {
    list: (query?: { serviceId?: number }) => Promise<LogDrain[]>;
    get: (id: number) => Promise<LogDrain>;
    create: (input: LogDrainCreateInput) => Promise<LogDrain>;
    update: (id: number, input: LogDrainUpdateInput) => Promise<LogDrain>;
    remove: (id: number) => Promise<{ ok: boolean }>;
    test: (id: number) => Promise<LogDrainTestResult>;
    /**
     * Search the configured Loki drain for `query` over
     * the last `sinceMinutes` (default 15). The route
     * round-trips to the drain's `url` so the upstream
     * does the heavy lifting; this is the same shape
     * the operator sees in the Loki Grafana panel.
     */
    search: (input: LogSearchInput) => Promise<LogSearchResult>;
  };
  /**
   * Per-workspace email template overrides (G-30).
   * Read-side is open to members; write-side requires the
   * workspace's admin role. The list / preview are safe
   * to call from a CI script; `set` / `reset` mutate the
   * panel's outbound email and should be operator-only.
   */
  emailTemplates: {
    list: (workspaceId: number) => Promise<{ workspaceId: number; templates: EmailTemplateEntry[] }>;
    preview: (workspaceId: number, name: EmailTemplateName, vars?: Record<string, string | number | null>) => Promise<EmailTemplateRender>;
    set: (workspaceId: number, name: EmailTemplateName, subject: string, text: string) => Promise<{ ok: boolean }>;
    reset: (workspaceId: number, name: EmailTemplateName) => Promise<{ ok: boolean }>;
  };
  housekeeping: {
    getAutoPrune: () => Promise<AutoPruneStatus>;
    updateAutoPrune: (input: AutoPruneConfigUpdateInput) => Promise<AutoPruneStatus>;
    runPrune: () => Promise<AutoPruneRunResult>;
    /**
     * List every image on the host with repo / tag / size /
     * created / dangling / inUse metadata. The companion to
     * the auto-prune cron: this is what the operator
     * inspects before `pruneImages({ keepLast: 5 })`.
     */
    listImages: () => Promise<{ images: ImageInfo[]; totalCount: number; totalBytes: number }>;
    /**
     * Prune images with operator-supplied filters. `dryRun`
     * returns the candidate set without deleting. Refused
     * when no filter is supplied (a naked prune would
     * delete every unused image).
     */
    pruneImages: (input: PruneImagesInput) => Promise<PruneImagesResult>;
  };
  /** Host-wide analysis + guarded cleanup. */
  doctor: {
    scan: () => Promise<DoctorReport>;
    fix: (input: DoctorFixRequestInput) => Promise<DoctorFixResponse>;
  };
  health: () => Promise<HealthStatus>;
}

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

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Propagated to fetch as-is. Typed structurally: the SDK compiles without
   * DOM lib types, and only `AbortSignal.timeout()` ever produces one here.
   */
  signal?: unknown;
}

const NO_FETCH = (): Promise<never> =>
  Promise.reject(new NineDeployError(0, 'no_fetch', 'No fetch implementation is available'));

/**
 * Create a typed NineDeploy API client. Used by both the web dashboard and the CLI.
 *
 * @example
 * const client = createClient({ baseUrl: 'http://localhost:3000', getToken: () => token });
 * const services = await client.services.list();
 */
export function createClient(opts: NineDeployClientOptions): NineDeployClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl: FetchLike = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch ?? NO_FETCH);
  /** Default per-request budget when the caller does not configure one. */
  const DEFAULT_TIMEOUT_MS = 30_000;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = opts.getToken?.();
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (init.body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // AbortSignal.timeout exists everywhere the SDK runs (Node 17.3+, all
    // modern browsers); it is resolved off globalThis and attached opaquely —
    // FetchLike's shape stays untouched (widening it with `signal: unknown`
    // breaks assigning a real `typeof fetch` at the call sites).
    const out: { method?: string; headers?: Record<string, string>; body?: string } = {
      method: init.method ?? 'GET',
      headers,
      body,
    };
    if (timeoutMs > 0) {
      const abort = (globalThis as { AbortSignal?: { timeout: (ms: number) => unknown } }).AbortSignal;
      if (abort) (out as { signal?: unknown }).signal = abort.timeout(timeoutMs);
    }

    const res = await fetchImpl(`${baseUrl}${path}`, out);
    const text = await res.text();
    // Guard the parse: proxies (HTML 502 pages, empty bodies) must surface as a
    // typed error, not an opaque SyntaxError.
    let parsed: unknown;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) {
      if (parsed === undefined) throw new NineDeployError(res.status, 'http_error', `Request failed (${res.status})`);
      throw NineDeployError.fromBody(res.status, parsed);
    }
    // An ok response with an empty/unparseable body (204s, HTML pages from a
    // misconfigured proxy) must never resolve to `undefined` — query functions
    // built on this client would crash TanStack Query ("Query data cannot be
    // undefined"). Empty 2xx bodies resolve to {}; non-JSON bodies surface as
    // a typed error so callers see the real problem instead of a crash.
    if (parsed === undefined) {
      if (text === '') return {} as T;
      throw new NineDeployError(res.status, 'invalid_response', `Expected JSON but received a non-JSON body (status ${res.status})`);
    }
    return parsed as T;
  }

  const get = <T>(path: string) => request<T>(path);
  const send = <T>(method: string, path: string, body?: unknown) => request<T>(path, { method, body });

  return {
    auth: {
      status: () => get<{ initialized: boolean }>('/v1/auth/status'),
      introspectToken: () => get<TokenIntrospection>('/v1/auth/token'),
      setup: (input) => send<Session>('POST', '/v1/setup', input),
      register: (input) => send<Session>('POST', '/v1/auth/register', input),
      login: (input) => send<Session>('POST', '/v1/auth/login', input),
      refresh: (input) => send<Session>('POST', '/v1/auth/refresh', input),
      /** Revoke this user's outstanding JWTs server-side (tokenVersion bump). */
      logout: () => send<{ ok: boolean }>('POST', '/v1/auth/logout', {}),
      changePassword: (input) => send<Session>('POST', '/v1/auth/password', input),
      forgotPassword: (email) => send<{ ok: boolean }>('POST', '/v1/auth/forgot-password', { email }),
      resetPasswordWithToken: (input) => send<{ ok: boolean }>('POST', '/v1/auth/reset-password', input),
      twoFactor: {
        setup: (input?: { password: string }) => send<{ secret: string; otpauthUri: string }>('POST', '/v1/auth/2fa/setup', input ?? {}),
        enable: (code) => send<{ ok: boolean; totpEnabled: boolean }>('POST', '/v1/auth/2fa/enable', { code }),
        disable: (input) => send<{ ok: boolean; totpEnabled: boolean }>('POST', '/v1/auth/2fa/disable', input),
      },
      me: () => get<PublicUser>('/v1/auth/me'),
      tokens: {
        create: (input) => send<CreatedApiToken>('POST', '/v1/auth/tokens', input ?? {}),
        list: () => get<ApiToken[]>('/v1/auth/tokens'),
        remove: async (id) => {
          await request(`/v1/auth/tokens/${id}`, { method: 'DELETE' });
        },
      },
      passkeys: {
        registerOptions: () => send<{ options: string }>('POST', '/v1/auth/passkey/register/options'),
        registerVerify: (input) =>
          send<PasskeyCredential>('POST', '/v1/auth/passkey/register/verify', {
            name: input.name,
            response: input.response as Record<string, unknown>,
          }),
        list: () => get<PasskeyCredential[]>('/v1/auth/passkey'),
        remove: async (id) => {
          await request(`/v1/auth/passkey/${id}`, { method: 'DELETE' });
        },
        loginOptions: () => send<{ options: string }>('POST', '/v1/auth/passkey/login/options'),
        loginVerify: (response) =>
          send<Session>('POST', '/v1/auth/passkey/login/verify', { response: response as Record<string, unknown> }),
      },
      sessions: {
        list: () => get<ActiveSession[]>('/v1/auth/sessions'),
        revoke: (id) => send<{ ok: boolean }>('DELETE', `/v1/auth/sessions/${id}`),
      },
      oidc: {
        publicProviders: () => get<OidcPublicProvider[]>('/v1/auth/oidc/providers/public'),
        listProviders: () => get<OidcProviderEntry[]>('/v1/auth/oidc/providers'),
        list: () => get<OidcProviderEntry[]>('/v1/auth/oidc/providers'),
        createProvider: (input) => send<OidcProviderEntry>('POST', '/v1/auth/oidc/providers', input),
        create: (input) => send<OidcProviderEntry>('POST', '/v1/auth/oidc/providers', input),
        updateProvider: (id, input) => send<OidcProviderEntry>('PATCH', `/v1/auth/oidc/providers/${id}`, input),
        update: (id, input) => send<OidcProviderEntry>('PATCH', `/v1/auth/oidc/providers/${id}`, input),
        deleteProvider: (id) => send<{ ok: boolean }>('DELETE', `/v1/auth/oidc/providers/${id}`),
        delete: (id) => send<{ ok: boolean }>('DELETE', `/v1/auth/oidc/providers/${id}`),
        callback: (slug, payload) => send<Session>('POST', `/v1/auth/oidc/${slug}/callback`, payload),
      },
    },
    workspaces: {
      list: () => get<WorkspaceEntry[]>('/v1/workspaces'),
      get: (id) => get<WorkspaceDetail>(`/v1/workspaces/${id}`),
      create: (input) => send<WorkspaceEntry>('POST', '/v1/workspaces', input),
      update: (id, input) => send<WorkspaceEntry>('PATCH', `/v1/workspaces/${id}`, input),
      delete: (id) => send<{ ok: boolean }>('DELETE', `/v1/workspaces/${id}`),
      addMember: (id, input) =>
        send<WorkspaceMemberEntry | WorkspaceMemberInviteEntry>('POST', `/v1/workspaces/${id}/members`, input),
      inviteMember: (id, input) =>
        send<WorkspaceInvitationEntry & { acceptUrl: string }>(
          'POST',
          `/v1/workspaces/${id}/invitations`,
          input,
        ),
      listInvitations: (id) => get<WorkspaceInvitationEntry[]>(`/v1/workspaces/${id}/invitations`),
      revokeInvitation: (id, inviteId) =>
        send<{ ok: boolean }>('DELETE', `/v1/workspaces/${id}/invitations/${inviteId}`),
      previewInvitation: (token) => get<WorkspaceInvitationPublic>(`/v1/invitations/${token}`),
      acceptInvitation: (token) =>
        send<{ ok: boolean; workspaceId: number; role: WorkspaceRole }>(
          'POST',
          `/v1/invitations/${token}/accept`,
        ),
      updateMemberRole: (id, memberId, input) => send<WorkspaceMemberEntry>('PATCH', `/v1/workspaces/${id}/members/${memberId}`, input),
      removeMember: (id, memberId) => send<{ ok: boolean }>('DELETE', `/v1/workspaces/${id}/members/${memberId}`),
    },
    services: {
      list: (query) => get<Service[]>(`/v1/services${query ?? ''}`),
      get: (id) => get<Service>(`/v1/services/${id}`),
      create: (input) => send<Service>('POST', '/v1/services', input),
      update: (id, input) => send<Service>('PATCH', `/v1/services/${id}`, input),
      composePreview: (input) => send<ComposePreviewResponse>('POST', '/v1/services/compose/preview', input),
      remove: async (id) => {
        await request(`/v1/services/${id}`, { method: 'DELETE' });
      },
      stop: (id) => send<{ ok: boolean; status: string }>('POST', `/v1/services/${id}/stop`),
      start: (id) => send<{ ok: boolean; status: string }>('POST', `/v1/services/${id}/start`),
      restart: (id) => send<{ ok: boolean; status: string }>('POST', `/v1/services/${id}/restart`),
      logs: (id) => get<{ lines: string }>(`/v1/services/${id}/logs`),
      clone: (id, input) => send<Service>('POST', `/v1/services/${id}/clone`, input ?? {}),
      exportUrl: (id) => `/v1/services/${id}/export`,
      importBundle: (bundle) => send<{ ok: boolean; serviceId: number; slug: string; message: string }>('POST', '/v1/services/import', bundle),
      manifest: {
        apply: (serviceId, input) =>
          send<ApplyManifestResult>('POST', `/v1/services/${serviceId}/manifest/apply`, input),
      },
    },
    labels: {
      list: (query) => get<Label[]>(`/v1/labels${query ?? ''}`),
      create: (input) => send<Label>('POST', '/v1/labels', input),
      update: (id, input) => send<Label>('PATCH', `/v1/labels/${id}`, input),
      remove: (id) => send<{ ok: boolean }>('DELETE', `/v1/labels/${id}`),
    },
    environments: {
      list: () => get<Environment[]>('/v1/environments'),
      create: (input) => send<Environment>('POST', '/v1/environments', input),
      rename: (id, name) => send<Environment>('PATCH', `/v1/environments/${id}`, { name }),
      remove: (id) => send<{ ok: boolean }>('DELETE', `/v1/environments/${id}`),
    },
    serviceTags: {
      get: (id) => get<ServiceTags>(`/v1/services/${id}/tags`),
      set: (id, input) => send<ServiceTags>('PUT', `/v1/services/${id}/tags`, input),
    },
    deploys: {
      trigger: (serviceId, input) =>
        send<{ deploymentId: number }>('POST', `/v1/services/${serviceId}/deploys`, input ?? {}),
      list: (serviceId) => get<Deployment[]>(`/v1/services/${serviceId}/deploys`),
      queue: (query) =>
        get<QueueResponse>(`/v1/services/queue${query ? (query.startsWith('?') ? query : `?${query}`) : ''}`),
      rollback: (serviceId, deploymentId) =>
        send<{ deploymentId: number }>('POST', `/v1/services/${serviceId}/deploys/${deploymentId}/rollback`),
      cancel: (serviceId, deploymentId) =>
        send<{ ok: boolean; status: string }>('POST', `/v1/services/${serviceId}/deploys/${deploymentId}/cancel`),
      remove: (serviceId, deploymentId) =>
        send<{ ok: boolean; id: number }>('DELETE', `/v1/services/${serviceId}/deploys/${deploymentId}`),
      configDiff: (serviceId, deploymentId) =>
        get<{ deploymentId: number; previousDeploymentId: number | null; changed: boolean; diff: string }>(
          `/v1/services/${serviceId}/deploys/${deploymentId}/diff`,
        ),
      promote: (serviceId, targetServiceId) =>
        send<{ ok: boolean; deploymentId: number; commitSha: string; promotedFrom: string }>(
          'POST',
          `/v1/services/${serviceId}/promote`,
          { targetServiceId },
        ),
    },
    domains: {
      list: (serviceId) => get<Domain[]>(`/v1/services/${serviceId}/domains`),
      create: (serviceId, input) => send<Domain>('POST', `/v1/services/${serviceId}/domains`, input),
      update: (serviceId, domainId, input) =>
        send<Domain>('PATCH', `/v1/services/${serviceId}/domains/${domainId}`, input),
      remove: async (serviceId, domainId) => {
        await request(`/v1/services/${serviceId}/domains/${domainId}`, { method: 'DELETE' });
      },
      all: () => get<DomainEntry[]>('/v1/domains'),
      setSsl: (domainId, ssl) => send<{ id: number; ssl: boolean }>('PATCH', `/v1/domains/${domainId}`, { ssl }),
      /** Toggle sticky-session routing (G-28) — sits under `/domains` for legacy compatibility. */
      setStickySession: (serviceId, enabled) =>
        send<{ id: number; enabled: boolean; active: boolean }>(
          'POST',
          `/v1/services/${serviceId}/sticky-session`,
          { enabled },
        ),
      transfer: (domainId, input) =>
        send<StartDomainTransferResult>('POST', `/v1/domains/${domainId}/transfer`, input),
      previewTransfer: (token) => get<DomainTransferPreview>(`/v1/domain-transfers/${token}`),
      acceptTransfer: (token, input) =>
        send<AcceptDomainTransferResult>('POST', `/v1/domain-transfers/${token}/accept`, input),
      cancelTransfer: (token) =>
        send<{ transferId: number; status: 'cancelled' }>('POST', `/v1/domain-transfers/${token}/cancel`, {}),
    },
    domainPresets: {
      list: () => get<{ providers: string[] }>('/v1/domain-presets'),
      apply: (input) => send<{
        hostname: string;
        provider: string;
        zone: string;
        recordId: string;
        type: 'A' | 'CNAME';
        content: string;
      }>('POST', '/v1/domain-presets/apply', input),
    },
    configPresets: {
      list: () => get<{ presets: string[] }>('/v1/config-presets'),
      get: (id) => get<{
        id: string;
        description: string | null;
        values: Record<string, unknown>;
        createdAt: string;
      }>(`/v1/config-presets/${encodeURIComponent(id)}`),
      register: (input) => send<{ ok: boolean; id: string; keyCount: number }>('POST', '/v1/config-presets', input),
      apply: (id, opts) => send<{
        ok: boolean;
        id: string;
        keyCount: number;
        failureCount?: number;
        failures?: Array<{ key: string; status: 'failed'; reason?: string }>;
      }>('PUT', `/v1/config-presets/${encodeURIComponent(id)}/apply`, opts ?? {}),
      remove: (id) => send<{ ok: boolean; id: string }>('DELETE', `/v1/config-presets/${encodeURIComponent(id)}`),
    },
    metricHistory: {
      get: () => get<{
        enabled: boolean;
        backend: 'builtin' | 'prometheus' | 'influxdb';
        events: string[];
        retentionDays: number;
        lastFlush: { ts: number; backend: string; count: number };
      }>('/v1/metric-history'),
      flush: () => send<{ ok: boolean; backend: 'builtin'; deleted: number }>('POST', '/v1/metric-history/flush'),
    },
    buildCache: {
      stats: () => get<{
        backends: Array<{
          name: string;
          entries: number;
          totalBytes: number;
          hits: number;
          misses: number;
          stores: number;
          evictions: number;
        }>;
        totals: {
          entries: number;
          totalBytes: number;
          hits: number;
          misses: number;
          stores: number;
          evictions: number;
        };
      }>('/v1/build-cache/stats'),
    },
    orchestrators: {
      list: () => get<{
        orchestrators: Array<{ name: string; stacks: Array<{ name: string; serviceCount: number }> }>;
      }>('/v1/orchestrators'),
      stacks: (orchestrator) => get<{
        stacks: Array<{ name: string; serviceCount: number }>;
      }>(`/v1/orchestrators/${encodeURIComponent(orchestrator)}/stacks`),
      stackStatus: (orchestrator, stack) => get<{
        name: string;
        services: Array<{ name: string; state: 'running' | 'stopped' | 'partial' | 'unknown'; replicas: number }>;
        appliedAt: string;
      } | null>(
        `/v1/orchestrators/${encodeURIComponent(orchestrator)}/stacks/${encodeURIComponent(stack)}`,
      ),
    },
    branding: {
      get: () => get<{
        logoUrl: string | null;
        primaryColor: string | null;
        supportEmail: string | null;
        footerHtml: string | null;
      }>('/v1/branding'),
      set: (input) => send<{ ok: boolean }>('PATCH', '/v1/branding', input),
    },
    egress: {
      list: () => get<{
        drivers: Array<{
          name: string;
          rules: Array<{
            selector: { projectId: number; sourceCidr?: string };
            ip: string;
            createdAt: string;
          }>;
        }>;
      }>('/v1/egress'),
      set: (input) => send<{
        ok: boolean;
        driver: string;
        rule: { selector: { projectId: number; sourceCidr?: string }; ip: string; createdAt: string };
      }>('POST', '/v1/egress', input),
      clear: (projectId) => send<{ ok: boolean; driver: string }>('DELETE', `/v1/egress/${projectId}`),
    },
    sso: {
      listProviders: () => get<{
        providers: Array<{ id: number; type: 'oidc' | 'saml'; name: string; createdAt: string }>;
      }>('/v1/sso/providers'),
      addProvider: (input) => send<{
        ok: boolean;
        id?: number;
        name?: string;
        type?: 'oidc' | 'saml';
        error?: string;
      }>('POST', '/v1/sso/providers', input),
      removeProvider: (id) => send<{ ok: boolean }>('DELETE', `/v1/sso/providers/${id}`),
    },
    volumes: {
      list: () => get<VolumeEntry[]>('/v1/volumes'),
      listFiles: (name, path = '') =>
        get<{ path: string; entries: VolumeFileEntry[] }>(`/v1/volumes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`),
      readFile: (name, path) =>
        get<{ content: string; encoding: 'utf8' | 'base64' }>(`/v1/volumes/${encodeURIComponent(name)}/files/content?path=${encodeURIComponent(path)}`),
      writeFile: (name, input) => send<{ ok: boolean }>('PUT', `/v1/volumes/${encodeURIComponent(name)}/files`, input),
      mkdir: (name, input) => send<{ ok: boolean }>('POST', `/v1/volumes/${encodeURIComponent(name)}/files/dir`, input),
      deleteFile: async (name, path) => {
        await request(`/v1/volumes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
      remove: async (name) => {
        await request(`/v1/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
      },
      prune: () => send<{ ok: boolean; deleted: number; freedBytes: number }>('POST', '/v1/volumes/prune'),
    },
    containers: {
      inspect: (container) => get<ContainerInspectData>(`/v1/containers/${encodeURIComponent(container)}/inspect`),
      compose: (container) => get<ContainerComposeData>(`/v1/containers/${encodeURIComponent(container)}/compose`),
      listFiles: (container, path = '/') =>
        get<{ path: string; entries: VolumeFileEntry[] }>(`/v1/containers/${encodeURIComponent(container)}/files?path=${encodeURIComponent(path)}`),
      readFile: (container, path) =>
        get<{ content: string; encoding: 'utf8' | 'base64' }>(`/v1/containers/${encodeURIComponent(container)}/files/content?path=${encodeURIComponent(path)}`),
      writeFile: (container, input) => send<{ ok: boolean }>('PUT', `/v1/containers/${encodeURIComponent(container)}/files`, input),
      mkdir: (container, input) => send<{ ok: boolean }>('POST', `/v1/containers/${encodeURIComponent(container)}/files/dir`, input),
      makeDir: (container, input) => send<{ ok: boolean }>('POST', `/v1/containers/${encodeURIComponent(container)}/files/dir`, input),
      deleteFile: async (container, path) => {
        await request(`/v1/containers/${encodeURIComponent(container)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
      deletePath: async (container, path) => {
        await request(`/v1/containers/${encodeURIComponent(container)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
    },
    system: {
      resources: () => get<DockerResources>('/v1/system/resources'),
      pruneImages: () => send<{ ok: boolean }>('POST', '/v1/system/prune-images'),
      updateCheck: (force) => get<UpdateCheckResult>(`/v1/system/update-check${force ? '?force=1' : ''}`),
      updateStatus: () => get<SelfUpdateStatus>('/v1/system/update-status'),
      updateStart: (version) => send<{ ok: boolean }>('POST', '/v1/system/update-start', { version }),
      exportUrl: () => '/v1/system/export',
      dockerEvents: (minutes) =>
        get<{ events: Array<{ time: string; type: string; action: string; name: string }> }>(
          `/v1/system/docker-events?minutes=${minutes ?? 60}`,
        ),
    },
    networks: {
      list: () => get<{ networks: Array<{ name: string; driver: string; members: string[] }>; remote: number | null }>('/v1/networks'),
      create: (input) => send<{ ok: boolean; name: string }>('POST', '/v1/networks', { driver: 'bridge', ...input }),
      remove: (name, serverId) =>
        send<{ ok: boolean }>('DELETE', `/v1/networks/${encodeURIComponent(name)}${serverId != null ? `?serverId=${serverId}` : ''}`),
      attach: (input) => send<{ ok: boolean }>('POST', '/v1/networks/attach', input),
      detach: (input) => send<{ ok: boolean }>('POST', '/v1/networks/detach', input),
    },
    tunnels: {
      list: () => get<TunnelEntry[]>('/v1/tunnels'),
      create: (input) => send<TunnelEntry>('POST', '/v1/tunnels', input),
      remove: async (id) => {
        await request(`/v1/tunnels/${id}`, { method: 'DELETE' });
      },
    },
  activity: {
    list: (query) => {
      const parts: string[] = [];
      if (query?.entity) parts.push(`entity=${encodeURIComponent(query.entity)}`);
      if (query?.action) parts.push(`action=${encodeURIComponent(query.action)}`);
      if (query?.userId) parts.push(`userId=${query.userId}`);
      if (query?.before) parts.push(`before=${query.before}`);
      const qs = parts.join('&');
      return get<{ entries: ActivityEntry[]; nextCursor: number | null }>(`/v1/activity${qs ? `?${qs}` : ''}`);
    },
  },
  alerts: {
    list: () => get('/v1/alerts'),
    create: (input) => send('POST', '/v1/alerts', input),
    update: (id, input) => send('PATCH', `/v1/alerts/${id}`, input),
    remove: async (id) => {
      await request(`/v1/alerts/${id}`, { method: 'DELETE' });
    },
  },
    settings: {
      get: () => get<{ allowRegistration: boolean; acmeEmail: string | null; templatesSource: string | null; dnsProvider: string | null; hasDnsToken: boolean; wildcardApex: string | null; panelDomain: string | null }>('/v1/settings'),
      setPanelDomain: (domain) =>
        send<{ ok: boolean; panelDomain: string | null }>('PUT', '/v1/settings/panel-domain', { domain }),
      setAllowRegistration: (enabled) =>
        send<{ ok: boolean; allowRegistration: boolean }>('PUT', '/v1/settings/allow-registration', { enabled }),
      setAcmeEmail: (email) =>
        send<{ ok: boolean; acmeEmail: string | null; applied: string }>('PUT', '/v1/settings/acme-email', { email }),
      setTemplatesSource: (source) =>
        send<{ ok: boolean; templatesSource: string | null }>('PUT', '/v1/settings/templates-source', { source }),
      setDns: (input) =>
        send<{ ok: boolean; dnsProvider: string | null; wildcardApex: string | null; applied: string }>('PUT', '/v1/settings/dns', input),
      vault: {
        get: () =>
          get<{ provider: string | null; hasToken: boolean; projectId: string | null; environment: string | null }>('/v1/settings/vault'),
        set: (input) => send<{ ok: boolean; provider: string | null }>('PUT', '/v1/settings/vault', input),
        test: () => send<{ ok: boolean; secrets: number }>('POST', '/v1/settings/vault/test'),
      },
      dnsRecords: {
        get: () => get<{ enabled: boolean; hasToken: boolean; content: string | null }>('/v1/settings/dns-records'),
        set: (input) => send<{ ok: boolean; enabled: boolean }>('PUT', '/v1/settings/dns-records', input),
        test: () => send<{ ok: boolean; status?: string; error?: string }>('POST', '/v1/settings/dns-records/test'),
      },
      namecheap: {
        get: () => get<{ configured: boolean; apiUser: string | null; clientIp: string | null; hasKey: boolean }>('/v1/settings/dns-records/namecheap'),
        set: (input) => send<{ ok: boolean; apiUser: string }>('PUT', '/v1/settings/dns-records/namecheap', input),
      },
      masterKey: {
        get: () => get<{ activeVersion: number; knownVersions: number[]; rotatable: boolean }>('/v1/settings/master-key'),
        rotate: () =>
          send<{ rotated: number; activeVersion: number; backupsNotRotated: number; warning: string | null }>(
            'POST',
            '/v1/settings/master-key/rotate',
          ),
      },
    },
    firewall: {
      status: () => get<any>('/v1/firewall'),
      toggle: (enabled) => send<any>('POST', '/v1/firewall/toggle', { enabled }),
      addRule: (input) => send<any>('POST', '/v1/firewall/rules', input),
      deleteRule: (id) => request(`/v1/firewall/rules/${id}`, { method: 'DELETE' }),
      applyRecommended: () => send<any>('POST', '/v1/firewall/recommended'),
    },
    users: {
      list: () => get<PublicUser[]>('/v1/users'),
      create: (input) => send<PublicUser>('POST', '/v1/users', input),
      resetPassword: (id, input) => send<{ ok: boolean }>('PATCH', `/v1/users/${id}/password`, input),
      resetLink: (id) => send<{ url: string; expiresAt: string }>('POST', `/v1/users/${id}/reset-link`),
      setOperator: (id, isOperator) =>
        send<{ ok: boolean; id: number; isOperator: boolean }>('PATCH', `/v1/users/${id}/operator`, { isOperator }),
      remove: async (id) => {
        await request(`/v1/users/${id}`, { method: 'DELETE' });
      },
    },
    projects: {
      list: (query) => get<ProjectEntry[]>(`/v1/projects${query ?? ''}`),
      create: (input) => send<ProjectEntry>('POST', '/v1/projects', input),
      update: (id, input) => send<ProjectEntry>('PATCH', `/v1/projects/${id}`, input),
      remove: (id) => send<{ ok: boolean }>('DELETE', `/v1/projects/${id}`),
    },
    about: {
      get: () => get('/v1/about'),
    },
    notifications: {
      listChannels: () => get<Array<{ id: number; name: string; type: string; eventFilter: string; active: boolean; configJson: string | null; createdAt: string }>>('/v1/notifications/channels'),
      createChannel: (input) => send('POST', '/v1/notifications/channels', input),
      updateChannel: (id, input) => send('PATCH', `/v1/notifications/channels/${id}`, input),
      removeChannel: async (id) => { await request(`/v1/notifications/channels/${id}`, { method: 'DELETE' }); },
      testChannel: (id) => send('POST', `/v1/notifications/channels/${id}/test`),
      log: () => get('/v1/notifications/log'),
    },
    sources: {
      list: () => get<Source[]>('/v1/sources'),
      create: (input) => send<Source>('POST', '/v1/sources', input),
      update: (id, input) => send<Source>('PATCH', `/v1/sources/${id}`, input),
      remove: async (id) => {
        await request(`/v1/sources/${id}`, { method: 'DELETE' });
      },
      repos: (id) => get<Array<{ name: string; fullName: string; url: string; defaultBranch: string; isPrivate: boolean }>>(`/v1/sources/${id}/repos`),
      branches: (id, repo) => get<string[]>(`/v1/sources/${id}/branches?repo=${encodeURIComponent(repo)}`),
      test: (id) => get<{ ok: boolean; provider?: string; login?: string; name?: string | null; status?: number; error?: string }>(`/v1/sources/${id}/test`),
      generateDeployKey: (id) => send<{ publicKey: string; fingerprint: string }>('POST', `/v1/sources/${id}/generate-deploy-key`),
    },
    insights: {
      analyze: (input) => send<RepoInsights>('POST', '/v1/insights', input),
      get: (serviceId) => get<RepoInsights | null>(`/v1/services/${serviceId}/insights`),
      refresh: (serviceId) => send<RepoInsights>('POST', `/v1/services/${serviceId}/insights/refresh`),
    },
    webhooks: {
      list: (serviceId) => get<Webhook[]>(`/v1/services/${serviceId}/webhooks`),
      create: (serviceId, input) => send<CreatedWebhook>('POST', `/v1/services/${serviceId}/webhooks`, input ?? {}),
      remove: async (serviceId, hookId) => {
        await request(`/v1/services/${serviceId}/webhooks/${hookId}`, { method: 'DELETE' });
      },
    },
    databases: {
      list: (query) => get<ManagedDatabase[]>(`/v1/databases${query ?? ''}`),
      create: (input) => send<ManagedDatabase>('POST', '/v1/databases', input),
      get: (id) => get<DatabaseDetail>(`/v1/databases/${id}`),
      remove: async (id, opts) => {
        await request(`/v1/databases/${id}${opts?.force ? '?force=true' : ''}`, { method: 'DELETE' });
      },
      restart: async (id) => {
        await request(`/v1/databases/${id}/restart`, { method: 'POST' });
      },
      stop: async (id) => {
        await request(`/v1/databases/${id}/stop`, { method: 'POST' });
      },
      start: async (id) => {
        await request(`/v1/databases/${id}/start`, { method: 'POST' });
      },
      logs: (id, lines) => get<{ logs: string[] }>(`/v1/databases/${id}/logs${lines ? `?lines=${lines}` : ''}`),
      credentials: (id) => get<DatabaseCredentials>(`/v1/databases/${id}/credentials`),
      setLimits: (id, input) => send<{ cpuShares: number | null; memLimitMb: number | null }>('PATCH', `/v1/databases/${id}/limits`, input),
      startStudio: (id, port) => send<{ ok: boolean; port: number; url: string }>('POST', `/v1/databases/${id}/studio`, { port }),
      stopStudio: async (id) => {
        await request(`/v1/databases/${id}/studio`, { method: 'DELETE' });
        return { ok: true };
      },
      drillBackup: (id, input) =>
        send<BackupDrillResult>('POST', `/v1/databases/${id}/backups/drill`, input),
      drills: (id) => get<BackupDrillEntry[]>(`/v1/databases/${id}/drills`),
      pgbouncerStatus: (id) => get<PgbouncerStatus>(`/v1/databases/${id}/pgbouncer`),
      enablePgbouncer: (id, input) =>
        send<PgbouncerStatus>('POST', `/v1/databases/${id}/pgbouncer/enable`, input ?? {}),
      disablePgbouncer: (id) =>
        send<PgbouncerStatus>('POST', `/v1/databases/${id}/pgbouncer/disable`, {}),
    },
    attachments: {
      list: (serviceId) => get<Attachment[]>(`/v1/services/${serviceId}/attachments`),
      create: (serviceId, input) => send<Attachment>('POST', `/v1/services/${serviceId}/attachments`, input),
      remove: async (serviceId, attachmentId) => {
        await request(`/v1/services/${serviceId}/attachments/${attachmentId}`, { method: 'DELETE' });
      },
    },
    serviceVolumes: {
      list: (serviceId) => get<Array<ServiceVolumeAttachment & { sizeBytes: number; inUse: boolean; sharedWith: number }>>(`/v1/services/${serviceId}/volumes`),
      create: (serviceId, input) =>
        send<{ attachment: ServiceVolumeAttachment; deploymentId: number }>('POST', `/v1/services/${serviceId}/volumes`, input),
      update: (serviceId, attachmentId, input) =>
        send<{ attachment: ServiceVolumeAttachment; deploymentId: number }>(
          'PATCH',
          `/v1/services/${serviceId}/volumes/${attachmentId}`,
          input,
        ),
      remove: async (serviceId, attachmentId) => {
        await request(`/v1/services/${serviceId}/volumes/${attachmentId}`, { method: 'DELETE' });
      },
      repairConfig: (serviceId, input) =>
        send<{ ok: boolean; deploymentId: number }>('POST', `/v1/services/${serviceId}/volumes/config-repair`, input),
    },
    volumeBackups: {
      // Path segments are user-visible names: encode them like the rest of
      // the client does, or '?'/'#'/'%' in a volume name rewrite the URL.
      list: (volumeName) => get<Backup[]>(`/v1/volumes/${encodeURIComponent(volumeName)}/backups`),
      create: (volumeName, input) =>
        send<Backup>('POST', `/v1/volumes/${encodeURIComponent(volumeName)}/backups`, input),
      restore: (volumeName, backupId) =>
        send<{ ok: boolean }>('POST', `/v1/volumes/${encodeURIComponent(volumeName)}/backups/${backupId}/restore`),
      downloadUrl: (volumeName, backupId) =>
        `/v1/volumes/${encodeURIComponent(volumeName)}/backups/${backupId}/download`,
    },
    env: {
      list: (serviceId) => get<EnvVar[]>(`/v1/services/${serviceId}/env`),
      create: (serviceId, input) => send<EnvVar>('POST', `/v1/services/${serviceId}/env`, input),
      update: (serviceId, varId, input) => send<EnvVar>('PATCH', `/v1/services/${serviceId}/env/${varId}`, input),
      remove: async (serviceId, varId) => {
        await request(`/v1/services/${serviceId}/env/${varId}`, { method: 'DELETE' });
      },
      search: (q) =>
        get<{ results: Array<{ key: string; isSecret: boolean; scope: string; serviceId: number | null; serviceName: string | null }> }>(
          `/v1/env/search?q=${encodeURIComponent(q)}`,
        ),
    },
    projectEnv: {
      list: (projectId) => get<EnvVar[]>(`/v1/projects/${projectId}/env`),
      create: (projectId, input) => send<EnvVar>('POST', `/v1/projects/${projectId}/env`, input),
      update: (projectId, varId, input) => send<EnvVar>('PATCH', `/v1/projects/${projectId}/env/${varId}`, input),
      remove: async (projectId, varId) => {
        await request(`/v1/projects/${projectId}/env/${varId}`, { method: 'DELETE' });
      },
    },
    stats: {
      snapshot: () => get<StatsSnapshot>('/v1/stats'),
      metrics: (serviceId, opts) =>
        get<MetricSeries>(
          `/v1/services/${serviceId}/metrics?kind=${opts?.kind ?? 'cpu'}&minutes=${opts?.minutes ?? 60}`,
        ),
    },
    dashboard: {
      get: () => get('/v1/dashboard'),
    },
    topology: {
      get: () => get<TopologyGraph>('/v1/topology'),
    },
    templates: {
      list: () => get<TemplateSummary[]>('/v1/templates'),
      get: (id) => get<Template>(`/v1/templates/${encodeURIComponent(id)}`),
      prepare: (id, input) => send<TemplatePrepareResult>('POST', `/v1/templates/${encodeURIComponent(id)}/prepare`, input ?? {}),
      deploy: (id, input) => send<TemplateDeployResult>('POST', `/v1/templates/${encodeURIComponent(id)}/deploy`, input ?? {}),
      community: {
        list: () => get<CommunityTemplateListResult>('/v1/templates/community'),
        import: (content, opts) =>
          send<{ ok: boolean; id: string; file: string; bytes: number }>(
            'POST',
            '/v1/templates/community/import',
            { content, ...(opts ?? {}) },
          ),
        remove: (id) =>
          send<{ ok: boolean; id: string; removed: boolean }>('DELETE', `/v1/templates/community/${encodeURIComponent(id)}`),
      },
    },
    backups: {
      storage: (databaseId) => get<{ sizeBytes: number }>(`/v1/databases/${databaseId}/storage`),
      backupNow: (databaseId) => send<Backup>('POST', `/v1/databases/${databaseId}/backups`),
      listForDb: (databaseId) => get<Backup[]>(`/v1/databases/${databaseId}/backups`),
      restore: (databaseId, backupId) => send<{ ok: boolean }>('POST', `/v1/databases/${databaseId}/backups/${backupId}/restore`),
      list: () => get<BackupWithDb[]>('/v1/backups'),
      remove: async (backupId) => {
        await request(`/v1/backups/${backupId}`, { method: 'DELETE' });
      },
      downloadUrl: (backupId) => `/v1/backups/${backupId}/download`,
    },
    backupDestinations: {
      list: () => get('/v1/backup-destinations'),
      create: (input) => send<{ id: number }>('POST', '/v1/backup-destinations', input),
      update: (id, input) => send<{ ok: boolean }>('PATCH', `/v1/backup-destinations/${id}`, input),
      remove: (id) => send<{ ok: boolean }>('DELETE', `/v1/backup-destinations/${id}`),
      test: (id) => send<{ ok: boolean }>('POST', `/v1/backup-destinations/${id}/test`),
    },
    jobs: {
      list: (serviceId) => get(`/v1/services/${serviceId}/jobs`),
      create: (serviceId, input) => send<{ id: number }>('POST', `/v1/services/${serviceId}/jobs`, input),
      update: (serviceId, jobId, input) => send<{ ok: boolean }>('PATCH', `/v1/services/${serviceId}/jobs/${jobId}`, input),
      remove: (serviceId, jobId) => send<{ ok: boolean }>('DELETE', `/v1/services/${serviceId}/jobs/${jobId}`),
      run: (serviceId, jobId) => send<{ ok: boolean }>('POST', `/v1/services/${serviceId}/jobs/${jobId}/run`),
      runs: (serviceId, jobId) => get(`/v1/services/${serviceId}/jobs/${jobId}/runs`),
    },
    servers: {
      list: () => get('/v1/servers'),
      create: (input) => send('POST', '/v1/servers', input),
      remove: (id, opts) => send<{ ok: boolean }>('DELETE', `/v1/servers/${id}${opts?.force ? '?force=true' : ''}`),
      test: (id) => send<{ ok: boolean; status: string }>('POST', `/v1/servers/${id}/test`),
      approve: (id) => send<{ ok: boolean; status: string }>('POST', `/v1/servers/${id}/approve`),
      reject: (id) => send<{ ok: boolean }>('POST', `/v1/servers/${id}/reject`),
      sshTest: (input) => send<ServerSshTestResult>('POST', '/v1/servers/ssh-test', input),
      sshBootstrap: (input) => send<ServerBootstrapResult>('POST', '/v1/servers/ssh-bootstrap', input),
      bootstrapLogs: (id) => get<{ logs: string[] }>(`/v1/servers/${id}/bootstrap-logs`),
    },
    limits: {
      setService: (serviceId, input) =>
        send<{ cpuShares: number; memLimitMb: number }>('PATCH', `/v1/services/${serviceId}/limits`, input),
      setDatabase: (databaseId, input) =>
        send<{ cpuShares: number; memLimitMb: number }>('PATCH', `/v1/databases/${databaseId}/limits`, input),
    },
    traefik: {
      get: () => get<TraefikInfo>('/v1/traefik'),
      status: () => get<TraefikStatus>('/v1/traefik/status'),
      certificates: () => get<TraefikCertificate[]>('/v1/traefik/certificates'),
      certificateInventory: (opts) =>
        get<CertificateInventoryReport>(
          // `!= null` (not truthiness): 0 ("only already-expired") is a real
          // threshold and must reach the server, not silently become the
          // server-side default of 30.
          `/v1/traefik/certificates/inventory${opts?.threshold != null ? `?threshold=${opts.threshold}` : ''}`,
        ),
      expiringCertificates: (opts) =>
        get<{ threshold: number; count: number; certificates: CertificateInventoryEntry[] }>(
          `/v1/traefik/certificates/expiring${opts?.days != null ? `?days=${opts.days}` : ''}`,
        ),
      logs: (lines = 50) => get<{ logs: string[] }>(`/v1/traefik/logs?lines=${lines}`),
      restart: () => send<{ ok: boolean; message: string }>('POST', '/v1/traefik/restart'),
      backupCerts: () => send<{ ok: boolean; message: string; filename?: string }>('POST', '/v1/traefik/backup-certs'),
    },
    config: {
      list: (query) => {
        const parts: string[] = [];
        if (query?.category) parts.push(`category=${encodeURIComponent(query.category)}`);
        if (query?.pluginId) parts.push(`pluginId=${encodeURIComponent(query.pluginId)}`);
        if (query?.reveal) parts.push('reveal=true');
        const qs = parts.length ? `?${parts.join('&')}` : '';
        return get<ConfigListResponse>(`/v1/config${qs}`);
      },
      get: (key) => get<ConfigItem>(`/v1/config/${encodeURIComponent(key)}`),
      set: (key, input) => send<{ ok: boolean; key: string }>('POST', `/v1/config/${encodeURIComponent(key)}`, input),
      delete: (key) => send<{ ok: boolean; key: string }>('DELETE', `/v1/config/${encodeURIComponent(key)}`),
    },
    plugins: {
      list: () => get<PluginListResponse>('/v1/plugins'),
      marketplace: (opts) =>
        get<MarketplaceCatalogResponse>(
          `/v1/plugins/marketplace${opts?.refresh ? '?refresh=true' : ''}`,
        ),
      install: (input) => send<{ ok: boolean; id: string; status: string }>('POST', '/v1/plugins/install', input),
      enable: (id) => send<{ ok: boolean; id: string; status: string }>('POST', `/v1/plugins/${encodeURIComponent(id)}/enable`),
      disable: (id) => send<{ ok: boolean; id: string; status: string }>('POST', `/v1/plugins/${encodeURIComponent(id)}/disable`),
      reload: (id) => send<{ ok: boolean; id: string; status: string }>('POST', `/v1/plugins/${encodeURIComponent(id)}/reload`),
      inspect: (id) => get<PluginInspectResponse>(`/v1/plugins/${encodeURIComponent(id)}/inspect`),
      uninstall: (id) => send<{ ok: boolean; id: string }>('POST', `/v1/plugins/${encodeURIComponent(id)}/uninstall`),
    },
    menus: {
      list: (query) => {
        const qs = query?.slot ? `?slot=${encodeURIComponent(query.slot)}` : '';
        return get<MenuListResponse>(`/v1/menus${qs}`);
      },
    },
    demo: {
      seed: () => send<DemoSeedResult>('POST', '/v1/demo/seed'),
    },
    logDrains: {
      list: (query) => {
        const qs = query?.serviceId !== undefined ? `?serviceId=${encodeURIComponent(String(query.serviceId))}` : '';
        return get<LogDrain[]>(`/v1/log-drains${qs}`);
      },
      get: (id) => get<LogDrain>(`/v1/log-drains/${id}`),
      create: (input) => send<LogDrain>('POST', '/v1/log-drains', input),
      update: (id, input) => send<LogDrain>('PATCH', `/v1/log-drains/${id}`, input),
      remove: (id) => send<{ ok: boolean }>('DELETE', `/v1/log-drains/${id}`),
      test: (id) => send<LogDrainTestResult>('POST', `/v1/log-drains/${id}/test`),
      search: (input) => send<LogSearchResult>('POST', '/v1/log-drains/search', input),
    },
    emailTemplates: {
      list: (workspaceId) =>
        get<{ workspaceId: number; templates: EmailTemplateEntry[] }>(
          `/v1/workspaces/${workspaceId}/email-templates`,
        ),
      preview: (workspaceId, name, vars) =>
        send<EmailTemplateRender>(
          'POST',
          `/v1/workspaces/${workspaceId}/email-templates/preview`,
          { name, vars: vars ?? {} },
        ),
      set: (workspaceId, name, subject, text) =>
        send<{ ok: boolean }>(
          'PUT',
          `/v1/workspaces/${workspaceId}/email-templates/${name}`,
          { subject, text },
        ),
      reset: (workspaceId, name) =>
        send<{ ok: boolean }>('DELETE', `/v1/workspaces/${workspaceId}/email-templates/${name}`, {}),
    },
    housekeeping: {
      getAutoPrune: () => get<AutoPruneStatus>('/v1/housekeeping/prune/config'),
      updateAutoPrune: (input) => send<AutoPruneStatus>('PATCH', '/v1/housekeeping/prune/config', input),
      runPrune: () => send<AutoPruneRunResult>('POST', '/v1/housekeeping/prune'),
      listImages: () =>
        get<{ images: ImageInfo[]; totalCount: number; totalBytes: number }>('/v1/housekeeping/images'),
      pruneImages: (input) =>
        send<PruneImagesResult>('POST', '/v1/housekeeping/images/prune', input),
    },
    health: () => get<HealthStatus>('/health'),
    doctor: {
      /** Full host scan: dead containers, orphan volumes/networks, row-vs-runtime
       *  desyncs, dangling images, disk pressure — with guarded repair actions. */
      scan: () => get<DoctorReport>('/v1/doctor'),
      /** Execute one finding's repair. The server re-scans and re-locates the
       *  finding first; a stale finding answers 409 instead of acting. */
      fix: (input: DoctorFixRequestInput) => send<DoctorFixResponse>('POST', '/v1/doctor/fix', input),
    },
  };
}
