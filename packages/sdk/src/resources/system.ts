// Client surface: system, health, about, dashboard, stats, usage, topology, activity, alerts, metricHistory, buildCache, housekeeping, doctor, demo.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  ActivityEntry,
  AlertRule,
  CreateAlertRuleInput,
  DoctorFixRequestInput,
  DoctorFixResponse,
  DoctorReport,
  DemoSeedResult,
  DockerResources,
  MetricSeries,
  ObservabilityResponse,
  ObservabilityPatch,
  ObservabilityExportResult,
  StatsSnapshot,
  TopologyGraph,
  UpdateCheckResult,
  SelfUpdateStatus,
  AutoPruneConfigUpdateInput,
  AutoPruneStatus,
  AutoPruneRunResult,
  PanelBackupObject,
  PanelBackupRestore,
  PanelBackupSettingsPatch,
  PanelBackupStatus,
  GitopsApplyStep,
  GitopsCheck,
  GitopsConfigInput,
  GitopsView,
  UsageCosts,
  UsageCostsInput,
  UsageReport,
} from '@ninedeploy/schemas';
import type { HealthStatus, ImageInfo, PruneImagesInput, PruneImagesResult } from '../types.js';
import type { Transport } from '../transport.js';

export interface SystemApi {
  /** G5.3 instance GitOps (operators): the instance as a file in a repository. */
  gitops: {
    get: () => Promise<GitopsView>;
    configure: (input: GitopsConfigInput) => Promise<GitopsView>;
    remove: () => Promise<{ ok: true }>;
    /** Read the file now and report the drift. */
    check: () => Promise<GitopsCheck>;
    /** Create and update what the file names (never deletes). */
    apply: () => Promise<{ steps: GitopsApplyStep[]; check: GitopsCheck }>;
    /** The live instance as the file, to commit. */
    export: () => Promise<{ file: string }>;
  };
  system: {
    resources: () => Promise<DockerResources>;
    pruneImages: () => Promise<{ ok: boolean }>;
    exportUrl: () => string;
    /** Latest-release check (admin). updateAvailable is null when offline/disabled. */
    updateCheck: (force?: boolean) => Promise<UpdateCheckResult>;
    /** State of a panel-initiated upgrade (idle/running/success/failed/unsupported). */
    updateStatus: () => Promise<SelfUpdateStatus>;
    /**
     * Start upgrading the panel itself to an exact release tag; the updater survives the restart it performs.
     * Refused with 409 `deploys_in_flight` while deployments are executing unless `force` is set (r572).
     */
    updateStart: (version: string, opts?: { force?: boolean }) => Promise<{ ok: boolean }>;
    /** Recent docker daemon events (single-shot, for the Docker dashboard feed). */
    dockerEvents: (minutes?: number) => Promise<{ events: Array<{ time: string; type: string; action: string; name: string }> }>;
    /**
     * Panel self-backup (0.12, operator-only): the `/system/export` archive sealed with a
     * recovery passphrase and written to a backup destination on a schedule.
     */
    panelBackup: {
      /** Settings, last run, next run (passphrase never returned — only `hasPassphrase`). */
      get: () => Promise<PanelBackupStatus>;
      /** Omitted fields keep their stored value; `passphrase` omitted = keep the stored one. */
      update: (input: PanelBackupSettingsPatch) => Promise<PanelBackupStatus>;
      /** "Back up now": starts a run in the background (409 while one is running); poll `get()`. */
      run: () => Promise<{ ok: boolean; started: boolean }>;
      /** Panel backups in a destination (default: the configured one), newest first. */
      list: (destinationId?: number) => Promise<{ destinationId: number; items: PanelBackupObject[] }>;
      /**
       * DESTRUCTIVE: replaces this panel's database, master key, .env and Traefik config with
       * the backup's. `confirm` must repeat the object's file name. Restart the panel afterwards.
       */
      restore: (input: PanelBackupRestore) => Promise<{ ok: boolean; message: string; meta: unknown; backupPath: string }>;
    };
  };
  health: () => Promise<HealthStatus>;
  about: {
    get: () => Promise<{
      name: string; version: string; description: string; license: string; repo: string; docs: string;
      techStack: Array<{ category: string; items: string[] }>;
      changelog: Array<{ version: string; date: string; title: string; changes: string[] }>;
      /** Instance counts are only returned for authenticated requests. */
      stats?: { services: number; databases: number; deployments: number; users: number };
    }>;
  };
  dashboard: {
    get: () => Promise<{
      stats: { services: number; databases: number; deployments: number; domains: number; webhooks: number; running: number; stopped: number; errored: number; dbRunning: number; /** Whole-node count — operators only, null for members (r470). */ containers: number | null };
      health: Array<{ serviceId: number; name: string; slug: string; type: string; status: string; healthy: boolean | null; responseMs: number | null; port: number | null; runtimeId: string | null; commitSha: string | null; lastDeploy: string | null }>;
      recentDeploys: Array<{ id: number; serviceId: number; serviceName: string; status: string; commitSha: string | null; message: string | null; trigger: string; finishedAt: string | null; createdAt: string }>;
    }>;
  };
  stats: {
    observability: {
      get: () => Promise<ObservabilityResponse>;
      update: (input: ObservabilityPatch) => Promise<ObservabilityResponse>;
      test: () => Promise<ObservabilityExportResult>;
    };
    /** Omit the filter for local-host monitoring; databaseId returns only that authorized database on its recorded host. */
    snapshot: (opts?: { databaseId?: number }) => Promise<StatsSnapshot>;
    metrics: (serviceId: number, opts?: { kind?: 'cpu' | 'memory'; minutes?: number }) => Promise<MetricSeries>;
  };
  /** Usage and cost (operator only): CPU-hours, memory, bandwidth and cost per service, project and workspace. */
  usage: {
    /** The last `days` days (1–90, default 30). */
    report: (opts?: { days?: number }) => Promise<UsageReport>;
    costs: () => Promise<UsageCosts>;
    /** The monthly cost of each server (`serverId: null` is the panel host). */
    setCosts: (input: UsageCostsInput) => Promise<UsageCosts>;
  };
  topology: {
    get: () => Promise<TopologyGraph>;
  };
  activity: {
    /**
     * Filter + paginate the audit trail. Omitted filters return the newest page.
     * `entity` matches the bare name and `<name> #<id>`; `serviceId` (with the
     * service name as `entity`) narrows to one service's trail.
     */
    list: (query?: { entity?: string; serviceId?: number; action?: string; userId?: number; before?: number }) => Promise<{ entries: ActivityEntry[]; nextCursor: number | null }>;
  };
  alerts: {
    list: () => Promise<AlertRule[]>;
    create: (input: CreateAlertRuleInput) => Promise<AlertRule>;
    update: (id: number, input: Partial<CreateAlertRuleInput>) => Promise<AlertRule>;
    remove: (id: number) => Promise<void>;
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
  demo: {
    seed: () => Promise<DemoSeedResult>;
  };
}

export function systemApi(t: Transport): SystemApi {
  const { get, send, request } = t;
  return {
    gitops: {
      get: () => get<GitopsView>('/v1/gitops'),
      configure: (input) => send<GitopsView>('PUT', '/v1/gitops', input),
      remove: () => send<{ ok: true }>('DELETE', '/v1/gitops'),
      check: () => send<GitopsCheck>('POST', '/v1/gitops/check'),
      apply: () => send<{ steps: GitopsApplyStep[]; check: GitopsCheck }>('POST', '/v1/gitops/apply'),
      export: () => get<{ file: string }>('/v1/gitops/export?format=json'),
    },
    system: {
      resources: () => get<DockerResources>('/v1/system/resources'),
      pruneImages: () => send<{ ok: boolean }>('POST', '/v1/system/prune-images'),
      updateCheck: (force) => get<UpdateCheckResult>(`/v1/system/update-check${force ? '?force=1' : ''}`),
      updateStatus: () => get<SelfUpdateStatus>('/v1/system/update-status'),
      updateStart: (version, opts) => send<{ ok: boolean }>('POST', '/v1/system/update-start', { version, ...opts }),
      exportUrl: () => '/v1/system/export',
      dockerEvents: (minutes) =>
        get<{ events: Array<{ time: string; type: string; action: string; name: string }> }>(
          `/v1/system/docker-events?minutes=${minutes ?? 60}`,
        ),
      panelBackup: {
        get: () => get<PanelBackupStatus>('/v1/system/panel-backup'),
        update: (input) => send<PanelBackupStatus>('PUT', '/v1/system/panel-backup', input),
        run: () => send<{ ok: boolean; started: boolean }>('POST', '/v1/system/panel-backup/run'),
        list: (destinationId) =>
          get<{ destinationId: number; items: PanelBackupObject[] }>(
            `/v1/system/panel-backup/remote${destinationId != null ? `?destinationId=${destinationId}` : ''}`,
          ),
        restore: (input) =>
          send<{ ok: boolean; message: string; meta: unknown; backupPath: string }>('POST', '/v1/system/panel-backup/restore', input),
      },
    },
    health: () => get<HealthStatus>('/health'),
    about: {
      get: () => get('/v1/about'),
    },
    dashboard: {
      get: () => get('/v1/dashboard'),
    },
    stats: {
      observability: {
        get: () => get<ObservabilityResponse>('/v1/stats/observability'),
        update: (input) => send<ObservabilityResponse>('PATCH', '/v1/stats/observability', input),
        test: () => send<ObservabilityExportResult>('POST', '/v1/stats/observability/test'),
      },
      snapshot: async (opts) => {
        const result = await get<StatsSnapshot>('/v1/stats' + (opts?.databaseId === undefined ? '' : `?databaseId=${encodeURIComponent(opts.databaseId)}`));
        if (opts?.databaseId !== undefined && (result?.resource?.kind !== 'database' || result.resource.id !== opts.databaseId || result.host !== null
          || !Array.isArray(result.containers) || result.containers.some(entry => entry.kind !== 'database' || entry.refId !== opts.databaseId))) {
          throw new Error('Database-scoped metrics were not confirmed by this panel; upgrade the panel to 0.18.0 or newer and retry');
        }
        return result;
      },
      metrics: (serviceId, opts) =>
        get<MetricSeries>(
          `/v1/services/${serviceId}/metrics?kind=${opts?.kind ?? 'cpu'}&minutes=${opts?.minutes ?? 60}`,
        ),
    },
    usage: {
      report: (opts) => get<UsageReport>(`/v1/usage?days=${opts?.days ?? 30}`),
      costs: () => get<UsageCosts>('/v1/usage/costs'),
      setCosts: (input) => send<UsageCosts>('PUT', '/v1/usage/costs', input),
    },
    topology: {
      get: () => get<TopologyGraph>('/v1/topology'),
    },
    activity: {
      list: (query) => {
        const parts: string[] = [];
        if (query?.entity) parts.push(`entity=${encodeURIComponent(query.entity)}`);
        if (query?.serviceId) parts.push(`serviceId=${query.serviceId}`);
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
    housekeeping: {
      getAutoPrune: () => get<AutoPruneStatus>('/v1/housekeeping/prune/config'),
      updateAutoPrune: (input) => send<AutoPruneStatus>('PATCH', '/v1/housekeeping/prune/config', input),
      runPrune: () => send<AutoPruneRunResult>('POST', '/v1/housekeeping/prune'),
      listImages: () =>
        get<{ images: ImageInfo[]; totalCount: number; totalBytes: number }>('/v1/housekeeping/images'),
      pruneImages: (input) =>
        send<PruneImagesResult>('POST', '/v1/housekeeping/images/prune', input),
    },
    doctor: {
      /** Full host scan: dead containers, orphan volumes/networks, row-vs-runtime
       *  desyncs, dangling images, disk pressure — with guarded repair actions. */
      scan: () => get<DoctorReport>('/v1/doctor'),
      /** Execute one finding's repair. The server re-scans and re-locates the
       *  finding first; a stale finding answers 409 instead of acting. */
      fix: (input: DoctorFixRequestInput) => send<DoctorFixResponse>('POST', '/v1/doctor/fix', input),
    },
    demo: {
      seed: () => send<DemoSeedResult>('POST', '/v1/demo/seed'),
    },
  };
}
