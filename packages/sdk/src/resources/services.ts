// Client surface: services, labels, environments, serviceTags, projects, fanout, limits, attachments.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  Attachment,
  AutoscaleStatusView,
  SizingReport,
  RestartLimitConfig,
  RestartLimitView,
  PendingChangesView,
  PendingApplyInput,
  PendingApplyResult,
  ComposePreviewRequestInput,
  ComposePreviewResponse,
  CreateProjectInput,
  CreateServiceInput,
  Label,
  CreateLabelInput,
  LabelPatchInput,
  Environment,
  EnvironmentCreateInput,
  EnvironmentPatchInput,
  PrimaryRecoveryEntry,
  ServiceRoutingView,
  PrimaryRecoveryResult,
  SwarmRecoveryEntry,
  SwarmRecoveryResult,
  FanoutRecoveryEntry,
  FanoutRecoveryResult,
  ProjectEntry,
  ProjectPatchInput,
  Service,
  ServiceTags,
  SetServiceTagsInput,
  SetLimitsInput,
  UpdateServiceInput,
  ServiceGithubFeedbackPatch,
  ServiceGithubLink,
  ServiceGithubLinkPut,
  ServiceGithubStatus,
  ImageTransfer,
  ServicePlacementInput,
  ServicePlacementView,
  ServiceSwarmStatus,
  ServiceFile,
  ServiceFileEntry,
  ServiceFilePut,
  ServiceLifecycleResult,
  ServiceLifecycleView,
  ServiceLifecycleRetry,
  ErrorPagesInput,
  InlineDockerfileView,
  ServiceMoveView,
  ServiceCommitStatusView,
  ErrorEventView,
  ErrorIngestView,
  ErrorIssueView,
  ErrorPagesView,
  MaintenanceInput,
  MaintenanceView,
} from '@ninedeploy/schemas';
import { apiGetUrl } from '../apiPath.js';
import type { ApplyManifestResult, ApplyManifestInput, ServiceDetail } from '../types.js';
import type { Transport } from '../transport.js';

/** 0.16.1: one kept upload of a service's source archive. */
/** G1.7: the registry push webhook of one service. `url` is set only in the answer that made it. */
export interface RegistryHookView {
  enabled: boolean;
  mine: boolean;
  url: string | null;
  createdAt: string | null;
  lastPushAt: string | null;
}

export interface SourceUpload {
  /** First 40 hex chars of the archive's SHA-256 (the deployment's `commitSha`). */
  sha: string;
  format: 'zip' | 'tar.gz';
  bytes: number;
  uploadedAt: string;
}

export interface ServicesApi {
  services: {
    /**
     * `query` is appended verbatim. Use `?tagWorkspaceIds=1,2&tagProjectIds=3`
     * to scope the list by tag (each dimension ANDs, members within a
     * dimension OR). The legacy `?projectId=` query is no longer accepted.
     */
    list: (query?: string) => Promise<Service[]>;
    /** 0.16 T8: the detail response also carries `placement` (absent on older panels). */
    get: (id: number) => Promise<ServiceDetail>;
    create: (input: CreateServiceInput) => Promise<Service>;
    update: (id: number, input: UpdateServiceInput) => Promise<Service>;
    /**
     * Dry-run a compose file before creating anything: blocking reasons,
     * host-privilege warnings, the declared services and the variables the
     * stack will ask for. Admin-only, and writes nothing.
     */
    composePreview: (input: ComposePreviewRequestInput) => Promise<ComposePreviewResponse>;
    remove: (id: number) => Promise<void>;
    stop: (id: number) => Promise<ServiceLifecycleResult>;
    start: (id: number) => Promise<ServiceLifecycleResult>;
    restart: (id: number) => Promise<ServiceLifecycleResult>;
    lifecycle: (id: number) => Promise<ServiceLifecycleView>;
    retryLifecycle: (id: number) => Promise<ServiceLifecycleRetry>;
    /** The last `tail` runtime-log lines (default 300, at most 5000; 0.16.3). */
    logs: (id: number, opts?: { tail?: number }) => Promise<{ lines: string }>;
    clone: (id: number, input?: { name?: string; slug?: string }) => Promise<Service>;
    exportUrl: (id: number) => string;
    /**
     * 0.16.1: send a `.zip` / `.tar.gz` (up to 100 MiB) as the source of a
     * docker service created without a repository or image, and deploy it
     * (`deploy: false` only stores it). A panel older than 0.16.1 answers 404.
     */
    uploadSource: (
      id: number,
      archive: Uint8Array,
      opts?: { deploy?: boolean },
    ) => Promise<SourceUpload & { entries: number; deploymentId: number | null }>;
    /**
     * 0.16.1 deploy status badge (member). `enable` turns it on or rotates its
     * URL; `disable` turns it off. The URL is the badge's only credential.
     */
    /**
     * 0.16.3 file mounts: files the panel keeps (encrypted) and mounts read-only
     * in a docker service's container, on the panel host or (0.16.5) a node. `list` has no content;
     * `get` (member) does. Changes apply on the next deploy.
     */
    files: {
      list: (id: number) => Promise<ServiceFileEntry[]>;
      get: (id: number, fileId: number) => Promise<ServiceFile>;
      put: (id: number, input: ServiceFilePut) => Promise<ServiceFileEntry>;
      remove: (id: number, fileId: number) => Promise<{ ok: boolean }>;
    };
    /**
     * Deploy hook (member): a secret URL that redeploys the service on POST,
     * for CI. `enable` turns it on or rotates the URL; `disable` turns it off.
     * The URL is returned only to the member it deploys as (`mine`); another
     * member sees `url: null` and takes it over by rotating.
     */
    deployHook: {
      get: (id: number) => Promise<{ enabled: boolean; url: string | null; mine: boolean }>;
      enable: (id: number) => Promise<{ enabled: boolean; url: string | null; mine: boolean }>;
      disable: (id: number) => Promise<{ enabled: boolean; url: string | null; mine: boolean }>;
    };
    badge: {
      get: (id: number) => Promise<{ enabled: boolean; url: string | null }>;
      enable: (id: number) => Promise<{ enabled: boolean; url: string | null }>;
      disable: (id: number) => Promise<{ enabled: boolean; url: string | null }>;
    };
    /** 0.16.1: the kept uploads (newest first) and whether the service takes uploads. */
    sourceUploads: (id: number) => Promise<{ uploadSourced: boolean; maxBytes: number; uploads: SourceUpload[] }>;
    /** 0.16.1: the panel host IPs a port mapping can be bound to (member), with the operator's label, the primary mark and whether one is dedicated to this service or another; `detected: false` when the host could not be asked. */
    hostAddresses: (id: number) => Promise<{ detected: boolean; addresses: Array<{ ip: string; family: 4 | 6; iface: string; label?: string | null; primary?: boolean; dedicated?: 'self' | 'other' | null }> }>;
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
    /**
     * The service's GitHub App link (0.13). `get` is viewer; `feedback` is
     * service admin; `link`, `migrate`, `finalize` and `unlink` are operator.
     * `unlink` answers 409 when the service clones through the App source
     * itself (attach another source first, or disable the link).
     */
    github: {
      get: (id: number) => Promise<ServiceGithubStatus>;
      link: (id: number, input: ServiceGithubLinkPut) => Promise<{ link: ServiceGithubLink }>;
      feedback: (id: number, input: ServiceGithubFeedbackPatch) => Promise<{ link: ServiceGithubLink }>;
      migrate: (id: number, sourceId: number) => Promise<{ link: ServiceGithubLink }>;
      finalize: (id: number) => Promise<{ link: ServiceGithubLink; webhooksDeactivated: number }>;
      unlink: (id: number) => Promise<{ ok: boolean; sourceId: number | null; webhooksReactivated: number }>;
    };
    // ── 0.16 T8 surfaces ──
    /**
     * Build placement (multi-node): where the image is built, how it travels
     * and which orchestrator runs it. `get` is any seat on the service; `set`
     * is operator only and partial (only the named keys change; `null`
     * restores the 0.15 default). An older node agent answers 422
     * `node_agent_outdated`; switching to Swarm answers 422 `swarm_unsupported`
     * or `swarm_disabled`.
     */
    placement: {
      get: (id: number) => Promise<ServicePlacementView>;
      set: (id: number, input: ServicePlacementInput) => Promise<ServicePlacementView>;
    };
    /** Image transfers of the service, newest first (`limit` 1-100, default 20). */
    imageTransfers: (id: number, query?: { limit?: number }) => Promise<ImageTransfer[]>;
    /** Swarm tasks of the service; `stack: null` when it is not on Swarm. */
    swarm: (id: number) => Promise<ServiceSwarmStatus>;
    // ── end 0.16 T8 ──
    // ── 0.16.10 autoscaling ──
    /**
     * Autoscaling status (`GET /v1/services/:id/autoscale`, viewer):
     * `{ enabled: false, replicas }` when off; otherwise the bounds, metric,
     * target, last value, desired count, why it is holding and the last
     * scaling event. The configuration itself is `autoscale` on the service
     * and is set with `update(id, { autoscale })` (`null` turns it off).
     */
    /** Where the service's traffic goes now: domains through Traefik, host ports through Docker. */
    routing: (id: number) => Promise<ServiceRoutingView>;
    runtimeRecovery: (id: number) => Promise<PrimaryRecoveryEntry | null>;
    retryRuntimeRecovery: (id: number) => Promise<PrimaryRecoveryResult>;
    swarmRecovery: (id: number) => Promise<SwarmRecoveryEntry | null>;
    retrySwarmRecovery: (id: number) => Promise<SwarmRecoveryResult>;
    autoscale: (id: number) => Promise<AutoscaleStatusView>;
    /** G5.6: memory and CPU limit suggestions from the metric history (viewer; advisory). */
    sizing: (id: number) => Promise<SizingReport>;
    /** G2.2: maintenance mode (a config turns it on, null off) and custom 502/503/504 pages. */
    maintenance: {
      get: (id: number) => Promise<MaintenanceView>;
      set: (id: number, maintenance: MaintenanceInput['maintenance']) => Promise<MaintenanceView>;
    };
    errorPages: {
      get: (id: number) => Promise<ErrorPagesView>;
      set: (id: number, pages: ErrorPagesInput['pages']) => Promise<ErrorPagesView>;
    };
    /** G1.1: a Dockerfile pasted in the panel (null builds from the repository again). */
    /** G5.4: errors reported by Sentry SDKs, grouped into issues. */
    errors: {
      list: (id: number, status?: 'unresolved' | 'resolved' | 'ignored') => Promise<ErrorIssueView[]>;
      get: (id: number, issueId: number) => Promise<{ issue: ErrorIssueView; events: ErrorEventView[] }>;
      setStatus: (id: number, issueId: number, status: 'unresolved' | 'resolved' | 'ignored') => Promise<ErrorIssueView>;
      /** The DSN: `create` answers it once and replaces any earlier one. */
      ingest: {
        get: (id: number) => Promise<ErrorIngestView>;
        create: (id: number) => Promise<ErrorIngestView>;
        remove: (id: number) => Promise<ErrorIngestView>;
      };
    };
    /** G3.1: move a stopped docker service to another host with its data volume (operators). */
    move: {
      get: (id: number) => Promise<ServiceMoveView>;
      /** `serverId` null = the panel host. Answers at once; follow it with `get`. */
      start: (id: number, serverId: number | null) => Promise<ServiceMoveView>;
    };
    inlineDockerfile: {
      get: (id: number) => Promise<InlineDockerfileView>;
      set: (id: number, content: string | null) => Promise<InlineDockerfileView>;
    };
    /**
     * G1.7 registry push webhook: a secret URL a registry (Docker Hub, GHCR,
     * Harbor, registry:2) calls after a push; the service redeploys when the
     * pushed tag is its image. The URL is returned once, by `enable`.
     */
    /** GitLab, Gitea and Bitbucket commit statuses (ROADMAP 0.16.8 item 8). */
    commitStatus: {
      get: (id: number) => Promise<ServiceCommitStatusView>;
      set: (id: number, enabled: boolean) => Promise<ServiceCommitStatusView>;
    };
    registryHook: {
      get: (id: number) => Promise<RegistryHookView>;
      enable: (id: number) => Promise<RegistryHookView>;
      disable: (id: number) => Promise<RegistryHookView>;
    };
    /** G1.3: stop the service when its containers keep restarting (opt-in; member to set). */
    restartLimit: {
      get: (id: number) => Promise<RestartLimitView>;
      set: (id: number, limit: RestartLimitConfig | null) => Promise<RestartLimitView>;
    };
    /**
     * G5.2 pending changes tray. With staging on, edits collect (`stage`, a
     * PATCH body) instead of applying; `apply` sends them through
     * `update` together, optionally with a deploy.
     */
    pending: {
      get: (id: number) => Promise<PendingChangesView>;
      stage: (id: number, patch: UpdateServiceInput) => Promise<PendingChangesView>;
      setStaging: (id: number, staging: boolean) => Promise<PendingChangesView>;
      discard: (id: number) => Promise<PendingChangesView>;
      apply: (id: number, input?: PendingApplyInput) => Promise<PendingApplyResult>;
    };
    // ── 0.16.11 scale to zero ──
    /**
     * Put a docker service to sleep now (`POST /v1/services/:id/sleep`,
     * member): its domains are routed to the panel's wake endpoint and its
     * containers stop; the next request wakes it. Works without
     * `sleepAfterMinutes`, which is set with `update(id, { sleepAfterMinutes })`
     * (5-1440, `null` = never). Answers 400 `cannot_sleep` (the message says
     * why) or 409 `sleep_failed`.
     */
    sleep: (id: number) => Promise<{ ok: boolean; asleep: boolean }>;
    /**
     * Wake a sleeping service (`POST /v1/services/:id/wake`, member): starts
     * its containers, waits for the healthcheck and routes its domains back.
     * Answers 400 `not_asleep` or 409 `wake_failed`. `start` and `restart`
     * wake a sleeping service too.
     */
    wake: (id: number) => Promise<{ ok: boolean; status: string }>;
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
    /**
     * 0.16.13: rename a lane and/or switch `protected` (variable values, logs
     * and shells for workspace admins only) and `requireApproval` (each deploy
     * waits for an admin). The two switches need an admin seat.
     */
    update: (id: number, input: EnvironmentPatchInput) => Promise<Environment>;
    remove: (id: number) => Promise<{ ok: boolean }>;
  };
  serviceTags: {
    /** Read the project's / workspace's / label memberships of a service. */
    get: (serviceId: number) => Promise<ServiceTags>;
    /** Replace the membership in a single round-trip. Empty arrays clear. */
    set: (serviceId: number, input: SetServiceTagsInput) => Promise<ServiceTags>;
  };
  projects: {
    /** `query` is appended verbatim, e.g. `?workspaceId=2` (workspace scoping). */
    list: (query?: string) => Promise<ProjectEntry[]>;
    create: (input: CreateProjectInput) => Promise<ProjectEntry>;
    update: (id: number, input: ProjectPatchInput) => Promise<ProjectEntry>;
    remove: (id: number) => Promise<{ ok: boolean }>;
  };
  fanout: {
    recovery: (serviceId: number) => Promise<FanoutRecoveryEntry[]>;
    retryRecovery: (serviceId: number) => Promise<FanoutRecoveryResult>;
    /** The extra nodes an image/Dockerfile release is pushed to. */
    get: (serviceId: number) =>
      Promise<Array<{ serverId: number; runtimeId: string | null; status: string }>>;
    /** Replace the target-node set (operator-only). */
    set: (serviceId: number, serverIds: number[]) =>
      Promise<{ targets: Array<{ serverId: number; runtimeId: string | null; status: string }> }>;
  };
  limits: {
    setService: (serviceId: number, input: SetLimitsInput) => Promise<{ cpuShares: number; cpuLimitMilli: number; memLimitMb: number; liveApplied: boolean }>;
    setDatabase: (databaseId: number, input: SetLimitsInput) => Promise<{ cpuShares: number; cpuLimitMilli: number; memLimitMb: number }>;
  };
  attachments: {
    list: (serviceId: number) => Promise<Attachment[]>;
    create: (serviceId: number, input: { databaseId: number; envAlias?: string; reuseExisting?: boolean }) => Promise<Attachment>;
    remove: (serviceId: number, attachmentId: number) => Promise<void>;
  };
}

export function servicesApi(t: Transport): ServicesApi {
  const { get, send, request } = t;
  return {
    services: {
      list: (query) => get<Service[]>(`/v1/services${query ?? ''}`),
      get: (id) => get<ServiceDetail>(`/v1/services/${id}`),
      create: (input) => send<Service>('POST', '/v1/services', input),
      update: (id, input) => send<Service>('PATCH', `/v1/services/${id}`, input),
      composePreview: (input) => send<ComposePreviewResponse>('POST', '/v1/services/compose/preview', input),
      remove: async (id) => {
        await request(`/v1/services/${id}`, { method: 'DELETE' });
      },
      stop: (id) => send<ServiceLifecycleResult>('POST', `/v1/services/${id}/stop`),
      start: (id) => send<ServiceLifecycleResult>('POST', `/v1/services/${id}/start`),
      restart: (id) => send<ServiceLifecycleResult>('POST', `/v1/services/${id}/restart`),
      lifecycle: id => get<ServiceLifecycleView>(`/v1/services/${id}/lifecycle`),
      retryLifecycle: id => send<ServiceLifecycleRetry>('POST', `/v1/services/${id}/lifecycle/retry`),
      logs: (id, opts) => get<{ lines: string }>(`/v1/services/${id}/logs${opts?.tail ? `?tail=${opts.tail}` : ''}`),
      clone: (id, input) => send<Service>('POST', `/v1/services/${id}/clone`, input ?? {}),
      exportUrl: (id) => `/v1/services/${id}/export`,
      uploadSource: (id, archive, opts) =>
        request<SourceUpload & { entries: number; deploymentId: number | null }>(
          `/v1/services/${id}/source${opts?.deploy === false ? '?deploy=false' : ''}`,
          { method: 'POST', raw: archive },
          // An upload of up to 100 MiB may outlast the default budget.
          10 * 60_000,
        ),
      files: {
        list: (id) => get<ServiceFileEntry[]>(`/v1/services/${id}/files`),
        get: (id, fileId) => get<ServiceFile>(`/v1/services/${id}/files/${fileId}`),
        put: (id, input) => send<ServiceFileEntry>('PUT', `/v1/services/${id}/files`, input),
        remove: (id, fileId) => request<{ ok: boolean }>(`/v1/services/${id}/files/${fileId}`, { method: 'DELETE' }),
      },
      deployHook: {
        get: (id) => get<{ enabled: boolean; url: string | null; mine: boolean }>(`/v1/services/${id}/deploy-hook`),
        enable: (id) => send<{ enabled: boolean; url: string | null; mine: boolean }>('POST', `/v1/services/${id}/deploy-hook`),
        disable: (id) => request<{ enabled: boolean; url: string | null; mine: boolean }>(`/v1/services/${id}/deploy-hook`, { method: 'DELETE' }),
      },
      badge: {
        get: (id) => get<{ enabled: boolean; url: string | null }>(`/v1/services/${id}/badge`),
        enable: (id) => send<{ enabled: boolean; url: string | null }>('POST', `/v1/services/${id}/badge`),
        disable: (id) => request<{ enabled: boolean; url: string | null }>(`/v1/services/${id}/badge`, { method: 'DELETE' }),
      },
      sourceUploads: (id) => get<{ uploadSourced: boolean; maxBytes: number; uploads: SourceUpload[] }>(`/v1/services/${id}/source`),
      hostAddresses: (id) => get<{ detected: boolean; addresses: Array<{ ip: string; family: 4 | 6; iface: string; label?: string | null; primary?: boolean; dedicated?: 'self' | 'other' | null }> }>(`/v1/services/${id}/host-addresses`),
      importBundle: (bundle) => send<{ ok: boolean; serviceId: number; slug: string; message: string }>('POST', '/v1/services/import', bundle),
      manifest: {
        apply: (serviceId, input) =>
          send<ApplyManifestResult>('POST', `/v1/services/${serviceId}/manifest/apply`, input),
      },
      github: {
        get: (id) => get<ServiceGithubStatus>(`/v1/services/${id}/github`),
        link: (id, input) => send<{ link: ServiceGithubLink }>('PUT', `/v1/services/${id}/github`, input),
        feedback: (id, input) => send<{ link: ServiceGithubLink }>('PATCH', `/v1/services/${id}/github/feedback`, input),
        migrate: (id, sourceId) => send<{ link: ServiceGithubLink }>('POST', `/v1/services/${id}/github/migrate`, { sourceId }),
        finalize: (id) => send<{ link: ServiceGithubLink; webhooksDeactivated: number }>('POST', `/v1/services/${id}/github/finalize`),
        unlink: (id) => send<{ ok: boolean; sourceId: number | null; webhooksReactivated: number }>('DELETE', `/v1/services/${id}/github`),
      },
      // ── 0.16 T8 surfaces ──
      placement: {
        get: (id) => get<ServicePlacementView>(`/v1/services/${id}/placement`),
        set: (id, input) => send<ServicePlacementView>('PUT', `/v1/services/${id}/placement`, input),
      },
      imageTransfers: (id, query) => get<ImageTransfer[]>(apiGetUrl(`/v1/services/${id}/image-transfers`, { ...query })),
      swarm: (id) => get<ServiceSwarmStatus>(`/v1/services/${id}/swarm`),
      routing: (id) => get<ServiceRoutingView>(`/v1/services/${id}/routing`),
      runtimeRecovery: async id => (await get<{ entry: PrimaryRecoveryEntry | null }>(`/v1/services/${id}/runtime-recovery`)).entry,
      retryRuntimeRecovery: id => request<PrimaryRecoveryResult>(`/v1/services/${id}/runtime-recovery`, { method: 'POST' }, 600_000),
      swarmRecovery: async id => (await get<{ entry: SwarmRecoveryEntry | null }>(`/v1/services/${id}/swarm/recovery`)).entry,
      retrySwarmRecovery: id => request<SwarmRecoveryResult>(`/v1/services/${id}/swarm/recovery`, { method: 'POST' }, 600_000),
      autoscale: (id) => get<AutoscaleStatusView>(`/v1/services/${id}/autoscale`),
      sizing: (id) => get<SizingReport>(`/v1/services/${id}/sizing`),
      maintenance: {
        get: (id) => get<MaintenanceView>(`/v1/services/${id}/maintenance`),
        set: (id, maintenance) => send<MaintenanceView>('PUT', `/v1/services/${id}/maintenance`, { maintenance }),
      },
      errorPages: {
        get: (id) => get<ErrorPagesView>(`/v1/services/${id}/error-pages`),
        set: (id, pages) => send<ErrorPagesView>('PUT', `/v1/services/${id}/error-pages`, { pages }),
      },
      errors: {
        list: (id, status) => get<ErrorIssueView[]>(`/v1/services/${id}/errors${status ? `?status=${status}` : ''}`),
        get: (id, issueId) => get<{ issue: ErrorIssueView; events: ErrorEventView[] }>(`/v1/services/${id}/errors/${issueId}`),
        setStatus: (id, issueId, status) => send<ErrorIssueView>('PATCH', `/v1/services/${id}/errors/${issueId}`, { status }),
        ingest: {
          get: (id) => get<ErrorIngestView>(`/v1/services/${id}/error-ingest`),
          create: (id) => send<ErrorIngestView>('POST', `/v1/services/${id}/error-ingest`),
          remove: (id) => send<ErrorIngestView>('DELETE', `/v1/services/${id}/error-ingest`),
        },
      },
      move: {
        get: (id) => get<ServiceMoveView>(`/v1/services/${id}/move`),
        start: (id, serverId) => send<ServiceMoveView>('POST', `/v1/services/${id}/move`, { serverId }),
      },
      inlineDockerfile: {
        get: (id) => get<InlineDockerfileView>(`/v1/services/${id}/inline-dockerfile`),
        set: (id, content) => send<InlineDockerfileView>('PUT', `/v1/services/${id}/inline-dockerfile`, { content }),
      },
      commitStatus: {
        get: (id) => get<ServiceCommitStatusView>(`/v1/services/${id}/commit-status`),
        set: (id, enabled) => send<ServiceCommitStatusView>('PUT', `/v1/services/${id}/commit-status`, { enabled }),
      },
      registryHook: {
        get: (id) => get<RegistryHookView>(`/v1/services/${id}/registry-hook`),
        enable: (id) => send<RegistryHookView>('POST', `/v1/services/${id}/registry-hook`),
        disable: (id) => request<RegistryHookView>(`/v1/services/${id}/registry-hook`, { method: 'DELETE' }),
      },
      restartLimit: {
        get: (id) => get<RestartLimitView>(`/v1/services/${id}/restart-limit`),
        set: (id, limit) => send<RestartLimitView>('PUT', `/v1/services/${id}/restart-limit`, { limit }),
      },
      pending: {
        get: (id) => get<PendingChangesView>(`/v1/services/${id}/pending`),
        stage: (id, patch) => send<PendingChangesView>('PUT', `/v1/services/${id}/pending`, patch),
        setStaging: (id, staging) => send<PendingChangesView>('PUT', `/v1/services/${id}/pending/staging`, { staging }),
        discard: (id) => send<PendingChangesView>('DELETE', `/v1/services/${id}/pending`),
        apply: (id, input) => send<PendingApplyResult>('POST', `/v1/services/${id}/pending/apply`, input ?? {}),
      },
      sleep: (id) => send<{ ok: boolean; asleep: boolean }>('POST', `/v1/services/${id}/sleep`),
      wake: (id) => send<{ ok: boolean; status: string }>('POST', `/v1/services/${id}/wake`),
      // ── end 0.16 T8 ──
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
      update: (id, input) => send<Environment>('PATCH', `/v1/environments/${id}`, input),
      remove: (id) => send<{ ok: boolean }>('DELETE', `/v1/environments/${id}`),
    },
    serviceTags: {
      get: (id) => get<ServiceTags>(`/v1/services/${id}/tags`),
      set: (id, input) => send<ServiceTags>('PUT', `/v1/services/${id}/tags`, input),
    },
    projects: {
      list: (query) => get<ProjectEntry[]>(`/v1/projects${query ?? ''}`),
      create: (input) => send<ProjectEntry>('POST', '/v1/projects', input),
      update: (id, input) => send<ProjectEntry>('PATCH', `/v1/projects/${id}`, input),
      remove: (id) => send<{ ok: boolean }>('DELETE', `/v1/projects/${id}`),
    },
    fanout: {
      recovery: async serviceId => (await get<{ entries: FanoutRecoveryEntry[] }>(`/v1/services/${serviceId}/targets/recovery`)).entries,
      retryRecovery: serviceId => request<FanoutRecoveryResult>(`/v1/services/${serviceId}/targets/recovery`, { method: 'POST' }, 600_000),
      // r201: the route answers `{ targets: [...] }` (like PATCH); the SDK
      // typed and returned it as a bare array, so the panel's fan-out card
      // called `.map` on an object and crashed whenever it rendered.
      get: async (serviceId) =>
        (
          await get<{ targets: Array<{ serverId: number; runtimeId: string | null; status: string }> }>(
            `/v1/services/${serviceId}/targets`,
          )
        ).targets,
      set: (serviceId, serverIds) =>
        send<{ targets: Array<{ serverId: number; runtimeId: string | null; status: string }> }>(
          'PATCH',
          `/v1/services/${serviceId}/targets`,
          { serverIds },
        ),
    },
    limits: {
      setService: (serviceId, input) =>
        send<{ cpuShares: number; cpuLimitMilli: number; memLimitMb: number; liveApplied: boolean }>('PATCH', `/v1/services/${serviceId}/limits`, input),
      setDatabase: (databaseId, input) =>
        send<{ cpuShares: number; cpuLimitMilli: number; memLimitMb: number }>('PATCH', `/v1/databases/${databaseId}/limits`, input),
    },
    attachments: {
      list: (serviceId) => get<Attachment[]>(`/v1/services/${serviceId}/attachments`),
      create: (serviceId, input) => send<Attachment>('POST', `/v1/services/${serviceId}/attachments`, input),
      remove: async (serviceId, attachmentId) => {
        await request(`/v1/services/${serviceId}/attachments/${attachmentId}`, { method: 'DELETE' });
      },
    },
  };
}
