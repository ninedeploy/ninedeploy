// Client surface: servers, swarm, orchestrators.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  ServerSshTest,
  ServerSshTestResult,
  ServerSshBootstrap,
  ServerBootstrapResult,
  ServerRolesInput,
  SwarmInitInput,
  SwarmSettingsInput,
  SwarmStatus,
} from '@ninedeploy/schemas';
import type { ServerListEntry, ServerRolesResult, SwarmJoinResult, SwarmLeaveResult } from '../types.js';
import type { Transport } from '../transport.js';

/** Long Swarm calls: a leave drains for up to 5 minutes; init and join run Docker on two hosts. */
const SWARM_CALL_TIMEOUT_MS = 10 * 60_000;

export interface ServersApi {
  servers: {
    /**
     * 0.15: `terminal` says what the node's agent offers terminals (absent on
     * a 0.14 panel). `container: false` with a `reason` usually means the
     * agent predates v0.15.0.
     */
    list: () => Promise<ServerListEntry[]>;
    /** Register a server — the agent token + its sha256 are returned exactly once. */
    create: (input: { name: string; host: string; port?: number }) => Promise<{ id: number; token: string; tokenSha256: string; agentCommand: string }>;
    remove: (id: number, options?: { force?: boolean }) => Promise<{ ok: boolean }>;
    test: (id: number) => Promise<{ ok: boolean; status: string }>;
    approve: (id: number) => Promise<{ ok: boolean; status: string }>;
    reject: (id: number) => Promise<{ ok: boolean }>;
    sshTest: (input: ServerSshTest) => Promise<ServerSshTestResult>;
    sshBootstrap: (input: ServerSshBootstrap) => Promise<ServerBootstrapResult>;
    bootstrapLogs: (id: number) => Promise<{ logs: string[] }>;
    /** r467: live host + per-container telemetry from a node's agent. */
    stats: (id: number) => Promise<{
      host: { cpuCores: number; load1: number; memTotalBytes: number; memUsedBytes: number } | null;
      disk: { totalBytes: number; usedBytes: number };
      containers: Array<{ name: string; kind: 'service'; refId: number; refName: string; cpuPct: number; memMb: number; memLimitMb: number }>;
    }>;
    // ── 0.16 T8 surfaces ──
    /** The build-server role (`PATCH /v1/servers/:id`, operator). Partial. */
    update: (id: number, input: ServerRolesInput) => Promise<ServerRolesResult>;
    /**
     * Join the node to the panel host's swarm as a worker (operator). 422
     * `node_agent_outdated` for an older agent, 422 `node_swarm_not_enabled`
     * until the node's owner sets {@link AGENT_SWARM_MANAGER_VAR}, 409
     * `swarm_already_joined` / `swarm_not_manager`, 502
     * `swarm_overlay_unavailable` / `swarm_node_unverified`.
     */
    swarmJoin: (id: number) => Promise<SwarmJoinResult>;
    /** Drain the node and take it out of the swarm (operator; can take minutes). 409 `swarm_not_joined`. */
    swarmLeave: (id: number) => Promise<SwarmLeaveResult>;
    // ── end 0.16 T8 ──
  };
  // ── end 0.15 T6 ──
  // ── 0.16 T8 surfaces ──
  /**
   * Swarm on the panel host (operator only). `init`, and enabling through
   * `settings`, need step-up: an interactive session plus the account
   * `password` (or a sign-in within 10 minutes). Join tokens are never returned.
   */
  swarm: {
    get: () => Promise<SwarmStatus>;
    /** `docker swarm init` on the panel host. 409 `swarm_already_active`; 502 `swarm_overlay_unavailable`. */
    init: (input: SwarmInitInput) => Promise<SwarmStatus>;
    /** Enable (step-up; 409 `swarm_not_manager`) or disable Swarm deploys. */
    settings: (input: SwarmSettingsInput) => Promise<SwarmStatus>;
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
}

export function serversApi(t: Transport): ServersApi {
  const { get, send, request } = t;
  return {
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
      stats: (id) => get(`/v1/servers/${id}/stats`),
      // ── 0.16 T8 surfaces ──
      update: (id, input) => send<ServerRolesResult>('PATCH', `/v1/servers/${id}`, input),
      swarmJoin: (id) => request<SwarmJoinResult>(`/v1/servers/${id}/swarm/join`, { method: 'POST' }, SWARM_CALL_TIMEOUT_MS),
      swarmLeave: (id) => request<SwarmLeaveResult>(`/v1/servers/${id}/swarm/leave`, { method: 'POST' }, SWARM_CALL_TIMEOUT_MS),
      // ── end 0.16 T8 ──
    },
    // ── end 0.15 T6 ──
    // ── 0.16 T8 surfaces ──
    swarm: {
      get: () => get<SwarmStatus>('/v1/swarm'),
      init: (input) => request<SwarmStatus>('/v1/swarm/init', { method: 'POST', body: input }, SWARM_CALL_TIMEOUT_MS),
      settings: (input) => send<SwarmStatus>('PUT', '/v1/swarm/settings', input),
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
  };
}
