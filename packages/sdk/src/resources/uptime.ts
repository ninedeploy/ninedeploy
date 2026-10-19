// Client surface: monitors, statusPages (0.16.8 uptime monitors and public status pages).
import type {
  MonitorCheckView,
  MonitorCreateInput,
  MonitorPatch,
  MonitorView,
  PublicStatusPage,
  StatusPageCreateInput,
  StatusPagePatch,
  StatusPageView,
} from '@ninedeploy/schemas';
import type { Transport } from '../transport.js';

/** What `monitors.checkNow` answers: the recorded check and the monitor's state after it. */
export interface MonitorCheckNowResult {
  check: MonitorCheckView;
  monitor: MonitorView;
}

export interface UptimeApi {
  monitors: {
    /** Monitors the caller can see (an operator sees all), optionally of one service. */
    list: (opts?: { serviceId?: number }) => Promise<MonitorView[]>;
    get: (id: number) => Promise<MonitorView>;
    /** Checks of the last `hours` (1–168, default 24 on the server), newest first. */
    checks: (id: number, opts?: { hours?: number }) => Promise<MonitorCheckView[]>;
    /** Operator. */
    create: (input: MonitorCreateInput) => Promise<MonitorView>;
    /** Operator. `enabled: false` pauses the monitor, `true` resumes it. */
    update: (id: number, patch: MonitorPatch) => Promise<MonitorView>;
    /** Operator. */
    delete: (id: number) => Promise<{ ok: boolean }>;
    /** Operator: run a check now and record it (state and alerts follow it). */
    checkNow: (id: number) => Promise<MonitorCheckNowResult>;
  };
  statusPages: {
    /** Operator. */
    list: () => Promise<StatusPageView[]>;
    get: (id: number) => Promise<StatusPageView>;
    create: (input: StatusPageCreateInput) => Promise<StatusPageView>;
    update: (id: number, patch: StatusPagePatch) => Promise<StatusPageView>;
    delete: (id: number) => Promise<{ ok: boolean }>;
    /** A published page as its public JSON (`GET /v1/status/:slug`, no auth needed). */
    public: (slug: string) => Promise<PublicStatusPage>;
  };
}

export function uptimeApi(t: Transport): UptimeApi {
  const { get, send } = t;
  return {
    monitors: {
      list: (opts) => get<MonitorView[]>(`/v1/monitors${opts?.serviceId !== undefined ? `?serviceId=${opts.serviceId}` : ''}`),
      get: (id) => get<MonitorView>(`/v1/monitors/${id}`),
      checks: (id, opts) => get<MonitorCheckView[]>(`/v1/monitors/${id}/checks${opts?.hours !== undefined ? `?hours=${opts.hours}` : ''}`),
      create: (input) => send<MonitorView>('POST', '/v1/monitors', input),
      update: (id, patch) => send<MonitorView>('PATCH', `/v1/monitors/${id}`, patch),
      delete: (id) => send<{ ok: boolean }>('DELETE', `/v1/monitors/${id}`),
      checkNow: (id) => send<MonitorCheckNowResult>('POST', `/v1/monitors/${id}/check`),
    },
    statusPages: {
      list: () => get<StatusPageView[]>('/v1/status-pages'),
      get: (id) => get<StatusPageView>(`/v1/status-pages/${id}`),
      create: (input) => send<StatusPageView>('POST', '/v1/status-pages', input),
      update: (id, patch) => send<StatusPageView>('PATCH', `/v1/status-pages/${id}`, patch),
      delete: (id) => send<{ ok: boolean }>('DELETE', `/v1/status-pages/${id}`),
      public: (slug) => get<PublicStatusPage>(`/v1/status/${encodeURIComponent(slug)}`),
    },
  };
}
