// Client surface: services, labels, environments, serviceTags, projects, fanout, limits, attachments.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  Attachment,
  ComposePreviewRequestInput,
  ComposePreviewResponse,
  CreateProjectInput,
  CreateServiceInput,
  Label,
  CreateLabelInput,
  LabelPatchInput,
  Environment,
  EnvironmentCreateInput,
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
} from '@ninedeploy/schemas';
import { apiGetUrl } from '../apiPath.js';
import type { ApplyManifestResult, ApplyManifestInput, ServiceDetail } from '../types.js';
import type { Transport } from '../transport.js';

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
  projects: {
    /** `query` is appended verbatim, e.g. `?workspaceId=2` (workspace scoping). */
    list: (query?: string) => Promise<ProjectEntry[]>;
    create: (input: CreateProjectInput) => Promise<ProjectEntry>;
    update: (id: number, input: ProjectPatchInput) => Promise<ProjectEntry>;
    remove: (id: number) => Promise<{ ok: boolean }>;
  };
  fanout: {
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
