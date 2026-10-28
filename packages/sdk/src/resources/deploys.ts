// Client surface: deploys, webhooks, jobs, insights, ai.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  AnalyzeRepoInput,
  CanaryStatusView,
  WebhookCreate,
  CreatedWebhook,
  Deployment,
  QueueResponse,
  ApprovalsResponse,
  AiConfigStatus,
  AiDiagnosisResult,
  RuntimeLogAnalysis,
  AiConfigUpdate,
  RepoInsights,
  TriggerDeploy,
  Webhook,
  ImageTransfer,
  DeployFreeze,
  DeployFreezeCreate,
  ImageScanPolicy,
  ImageScanPolicyPatch,
  ImageScanResult,
} from '@ninedeploy/schemas';
import type { JobKind, ScheduledJob, JobRun } from '../types.js';
import type { Transport } from '../transport.js';

export interface DeploysApi {
  deploys: {
    /**
     * Queue a deployment of the service's configured branch head. Answers
     * `alreadyInProgress: true` with the in-flight deployment's id when one
     * is already building or deploying.
     */
    trigger: (serviceId: number, input?: TriggerDeploy) => Promise<{ deploymentId: number; alreadyInProgress?: boolean }>;
    list: (serviceId: number) => Promise<Deployment[]>;
    /**
     * Global deploy queue view: every in-flight (queued / building /
     * deploying) deployment the caller can see, with service + project
     * metadata. The optional `status` filter is a comma-separated token
     * list (e.g. `?status=queued,building`).
     */
    /** This SDK opts into CI waits; older SDKs keep the original three-status queue response. */
    queue: (query?: string) => Promise<QueueResponse>;
    rollback: (serviceId: number, deploymentId: number) => Promise<{ deploymentId: number }>;
    /** Metadata only; resolved environment and encrypted payload are never returned. */
    releaseInfo: (serviceId: number, deploymentId: number) => Promise<{ available: boolean; mode: 'recorded-compose' | 'recorded-docker' | 'legacy' | 'unavailable'; imageCount: number; reason: string; imageAvailability?: 'present' | 'missing' | 'unknown'; missingImageCount?: number | null }>;
    /** Cancel a queued/in-flight deployment (checkpoints abort at step boundaries). */
    cancel: (serviceId: number, deploymentId: number) => Promise<{ ok: boolean; status: string }>;
    /**
     * Remove a finished deployment from history, with its build log.
     * Refused for an in-flight deployment (cancel it first) and for the one
     * currently serving traffic. Requires the `admin` role on the service.
     */
    remove: (serviceId: number, deploymentId: number) => Promise<{ ok: boolean; id: number; removedContainers?: string[] }>;
    /**
     * Remove many finished deployments at once: `ids`, or every one in
     * `statuses` (e.g. `['failed', 'cancelled']`). In-flight, waiting and live
     * deployments are never removed. Requires the `admin` role.
     */
    removeMany: (
      serviceId: number,
      input: { ids?: number[]; statuses?: Array<'failed' | 'cancelled' | 'superseded'> },
    ) => Promise<{ ok: true; removed: number[]; skipped: number; removedContainers: string[] }>;
    /** Build-config + env-key diff against the previous deployment. */
    configDiff: (serviceId: number, deploymentId: number) => Promise<{ deploymentId: number; previousDeploymentId: number | null; changed: boolean; diff: string }>;
    /** Build log download URL (serves the raw log file as an attachment). */
    logDownloadUrl: (serviceId: number, deploymentId: number) => string;
    /**
     * Promote: deploy ANOTHER service at this service's exact running
     * commit — the staging → production lane hop. Both services must
     * track the same repository and the caller needs `member` on both.
     */
    promote: (serviceId: number, targetServiceId: number, options?: { mode: 'commit' | 'artifact'; sourceDeploymentId?: number }) => Promise<{ ok: boolean; deploymentId: number; commitSha: string; promotedFrom: string; mode?: 'artifact'; imageId?: string }>;
    // ── 0.16 T8 surfaces ──
    /** Image transfers of one deployment (`GET /v1/deployments/:id/image-transfers`, any seat on its service). */
    imageTransfers: (deploymentId: number) => Promise<ImageTransfer[]>;
    // ── end 0.16 T8 ──
    // ── 0.16.9 canary releases ──
    /**
     * The canary of the service's deploy in progress (`active: false` when
     * none is running): step, traffic weight and what each release measured.
     */
    canary: (serviceId: number) => Promise<CanaryStatusView>;
    /**
     * Request canary promotion. A node first finishes and passes its current
     * measured step, then skips the remaining steps; panel-host promotion is early.
     * Resolves when accepted; poll canary/deployment status for completion.
     * Fails with `400 no_canary` when that deployment has no canary in
     * progress. To stop a canary instead, `cancel` the deployment.
     */
    promoteCanary: (serviceId: number, deploymentId: number) => Promise<{ ok: true }>;
    /**
     * 0.16.13: let a deployment waiting for approval build (`awaiting_approval`
     * → `queued`). Needs an admin of the service's lane; fails with
     * `400 not_awaiting_approval` for a deploy that is not waiting.
     */
    approve: (serviceId: number, deploymentId: number) => Promise<{ ok: true; status: 'queued' }>;
    /** 0.16.13: the deployments waiting for approval the caller can see, oldest first. */
    approvals: () => Promise<ApprovalsResponse>;
    /** 0.16.13: turn down a deployment waiting for approval (→ `cancelled`). Same rules as `approve`. */
    reject: (serviceId: number, deploymentId: number) => Promise<{ ok: true; status: 'cancelled' }>;
  };
  webhooks: {
    list: (serviceId: number) => Promise<Webhook[]>;
    create: (serviceId: number, input?: WebhookCreate) => Promise<CreatedWebhook>;
    remove: (serviceId: number, hookId: number) => Promise<void>;
  };
  /**
   * r552: aligned with apps/server/src/modules/jobs.ts — `kind` includes
   * `'backup'`, and create/update return the full serialized job (the PATCH
   * was typed `{ ok }`, a field the server never sent).
   */
  jobs: {
    list: (serviceId: number) => Promise<ScheduledJob[]>;
    create: (serviceId: number, input: { name: string; cron: string; kind: JobKind; command?: string; enabled?: boolean }) => Promise<ScheduledJob>;
    update: (serviceId: number, jobId: number, input: Partial<{ name: string; cron: string; kind: JobKind; command: string; enabled: boolean }>) => Promise<ScheduledJob>;
    remove: (serviceId: number, jobId: number) => Promise<{ ok: boolean }>;
    run: (serviceId: number, jobId: number) => Promise<{ ok: boolean }>;
    runs: (serviceId: number, jobId: number) => Promise<JobRun[]>;
  };
  insights: {
    /** Pre-deploy repository inspection (DeployWizard): clone + framework detection. */
    analyze: (input: AnalyzeRepoInput) => Promise<RepoInsights>;
    /** Latest stored analysis for a service (null before the first deploy/refresh). */
    get: (serviceId: number) => Promise<RepoInsights | null>;
    /** Re-analyze the service's repository now and store the result. */
    refresh: (serviceId: number) => Promise<RepoInsights>;
  };
  /** AI failure diagnosis (BYO-key): operator-configured, OpenAI-compatible. */
  ai: {
    /** Never carries key material — only endpoint/model + hasApiKey. */
    getConfig: () => Promise<AiConfigStatus>;
    updateConfig: (input: AiConfigUpdate) => Promise<{ ok: boolean }>;
    /**
     * Ask the configured provider to diagnose a failed build log. 0.16.16: with
     * `parts` and a `proposal` (settings to PATCH, file edits) when the model
     * answered in the structured form; apply a settings proposal with
     * `services.update`.
     */
    diagnose: (serviceId: number, deploymentId: number) => Promise<AiDiagnosisResult>;
    /** Describe the app in plain language, get a schema-valid .ninedeploy manifest. */
    suggestManifest: (description: string) => Promise<{ manifest: Record<string, unknown>; model: string }>;
    /**
     * 0.16.15: what the provider makes of a running service's recent runtime
     * logs (`tail` lines, 20-5000, default 300; sanitized before they leave the
     * panel). `400 not_running` / `no_logs` when there is nothing to read.
     */
    analyzeLogs: (serviceId: number, input?: { tail?: number }) => Promise<RuntimeLogAnalysis>;
  };
  /**
   * G5.5 deploy freezes (operator only). A freeze holds every deploy of the
   * instance, a workspace, a project or an environment in the queue until it
   * ends (`until`) or is lifted; held deploys then start.
   */
  deployFreezes: {
    list: () => Promise<DeployFreeze[]>;
    create: (input: DeployFreezeCreate) => Promise<DeployFreeze>;
    lift: (id: string) => Promise<DeployFreeze>;
  };
  /**
   * G5.1 image vulnerability scanning (Trivy on the panel host). The policy is
   * operator only; a service's latest scan is readable by its viewers, and
   * `scan` (service admin) starts a scan of what runs now in the background.
   */
  imageScans: {
    policy: () => Promise<{ policy: ImageScanPolicy; trivyImage: string }>;
    setPolicy: (patch: ImageScanPolicyPatch) => Promise<{ policy: ImageScanPolicy; trivyImage: string }>;
    get: (serviceId: number) => Promise<{ result: ImageScanResult | null; scanning: boolean }>;
    scan: (serviceId: number) => Promise<{ started: true; imageId: string }>;
  };
}

export function deploysApi(t: Transport): DeploysApi {
  const { get, send, request } = t;
  return {
    imageScans: {
      policy: () => get<{ policy: ImageScanPolicy; trivyImage: string }>('/v1/image-scanning'),
      setPolicy: (patch) => send<{ policy: ImageScanPolicy; trivyImage: string }>('PUT', '/v1/image-scanning', patch),
      get: (serviceId) => get<{ result: ImageScanResult | null; scanning: boolean }>(`/v1/services/${serviceId}/image-scan`),
      scan: (serviceId) => send<{ started: true; imageId: string }>('POST', `/v1/services/${serviceId}/image-scan`),
    },
    deployFreezes: {
      list: () => get<DeployFreeze[]>('/v1/deploy-freezes'),
      create: (input) => send<DeployFreeze>('POST', '/v1/deploy-freezes', input),
      lift: (id) => send<DeployFreeze>('DELETE', `/v1/deploy-freezes/${encodeURIComponent(id)}`),
    },
    deploys: {
      trigger: (serviceId, input) =>
        send<{ deploymentId: number; alreadyInProgress?: boolean }>('POST', `/v1/services/${serviceId}/deploys`, input ?? {}),
      list: (serviceId) => get<Deployment[]>(`/v1/services/${serviceId}/deploys`),
      queue: (query) => {
        const filter = query?.replace(/^\?/, '');
        return get<QueueResponse>(`/v1/services/queue?includeCi=true${filter ? `&${filter}` : ''}`);
      },
      rollback: (serviceId, deploymentId) =>
        send<{ deploymentId: number }>('POST', `/v1/services/${serviceId}/deploys/${deploymentId}/rollback`),
      releaseInfo: (serviceId, deploymentId) => get(`/v1/services/${serviceId}/deploys/${deploymentId}/release`),
      cancel: (serviceId, deploymentId) =>
        send<{ ok: boolean; status: string }>('POST', `/v1/services/${serviceId}/deploys/${deploymentId}/cancel`),
      remove: (serviceId, deploymentId) =>
        send<{ ok: boolean; id: number; removedContainers?: string[] }>('DELETE', `/v1/services/${serviceId}/deploys/${deploymentId}`),
      removeMany: (serviceId, input) =>
        send<{ ok: true; removed: number[]; skipped: number; removedContainers: string[] }>('POST', `/v1/services/${serviceId}/deploys/bulk-delete`, input),
      configDiff: (serviceId, deploymentId) =>
        get<{ deploymentId: number; previousDeploymentId: number | null; changed: boolean; diff: string }>(
          `/v1/services/${serviceId}/deploys/${deploymentId}/diff`,
        ),
      promote: (serviceId, targetServiceId, options) =>
        send<{ ok: boolean; deploymentId: number; commitSha: string; promotedFrom: string; mode?: 'artifact'; imageId?: string }>(
          'POST',
          `/v1/services/${serviceId}/promote`,
          { targetServiceId, ...options },
        ),
      logDownloadUrl: (serviceId, deploymentId) =>
        `/v1/services/${serviceId}/deploys/${deploymentId}/logs/download`,
      // ── 0.16 T8 surfaces ──
      imageTransfers: (deploymentId) => get<ImageTransfer[]>(`/v1/deployments/${deploymentId}/image-transfers`),
      // ── end 0.16 T8 ──
      canary: (serviceId) => get<CanaryStatusView>(`/v1/services/${serviceId}/canary`),
      promoteCanary: (serviceId, deploymentId) =>
        send<{ ok: true }>('POST', `/v1/services/${serviceId}/deploys/${deploymentId}/canary/promote`),
      approve: (serviceId, deploymentId) =>
        send<{ ok: true; status: 'queued' }>('POST', `/v1/services/${serviceId}/deploys/${deploymentId}/approve`),
      approvals: () => get<ApprovalsResponse>('/v1/services/approvals'),
      reject: (serviceId, deploymentId) =>
        send<{ ok: true; status: 'cancelled' }>('POST', `/v1/services/${serviceId}/deploys/${deploymentId}/reject`),
    },
    webhooks: {
      list: (serviceId) => get<Webhook[]>(`/v1/services/${serviceId}/webhooks`),
      create: (serviceId, input) => send<CreatedWebhook>('POST', `/v1/services/${serviceId}/webhooks`, input ?? {}),
      remove: async (serviceId, hookId) => {
        await request(`/v1/services/${serviceId}/webhooks/${hookId}`, { method: 'DELETE' });
      },
    },
    jobs: {
      list: (serviceId) => get(`/v1/services/${serviceId}/jobs`),
      create: (serviceId, input) => send<ScheduledJob>('POST', `/v1/services/${serviceId}/jobs`, input),
      update: (serviceId, jobId, input) => send<ScheduledJob>('PATCH', `/v1/services/${serviceId}/jobs/${jobId}`, input),
      remove: (serviceId, jobId) => send<{ ok: boolean }>('DELETE', `/v1/services/${serviceId}/jobs/${jobId}`),
      run: (serviceId, jobId) => send<{ ok: boolean }>('POST', `/v1/services/${serviceId}/jobs/${jobId}/run`),
      runs: (serviceId, jobId) => get(`/v1/services/${serviceId}/jobs/${jobId}/runs`),
    },
    insights: {
      analyze: (input) => send<RepoInsights>('POST', '/v1/insights', input),
      get: (serviceId) => get<RepoInsights | null>(`/v1/services/${serviceId}/insights`),
      refresh: (serviceId) => send<RepoInsights>('POST', `/v1/services/${serviceId}/insights/refresh`),
    },
    ai: {
      getConfig: () => get<AiConfigStatus>('/v1/ai/config'),
      updateConfig: (input) => send<{ ok: boolean }>('PUT', '/v1/ai/config', input),
      diagnose: (serviceId, deploymentId) =>
        send<AiDiagnosisResult>(
          'POST',
          `/v1/ai/services/${serviceId}/deploys/${deploymentId}/diagnose`,
        ),
      suggestManifest: (description) =>
        send<{ manifest: Record<string, unknown>; model: string }>('POST', '/v1/ai/suggest-manifest', { description }),
      analyzeLogs: (serviceId, input) => send<RuntimeLogAnalysis>('POST', `/v1/ai/services/${serviceId}/logs/analyze`, input ?? {}),
    },
  };
}
