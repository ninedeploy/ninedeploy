import type {
  MonitorCheckView,
  MonitorCreateInput,
  MonitorPatch,
  MonitorView,
  StatusPageCreateInput,
  StatusPagePatch,
  StatusPageView,
} from '@ninedeploy/schemas';
import { apiCall as call } from './apiCall.js';

/**
 * 0.16.8 uptime monitors and status pages. Typed calls over `authedFetch`
 * (see `apiCall`) with the SDK's error shape, so a failed request carries the
 * server's message.
 */

/** React Query keys; `['monitors']` prefixes every monitor listing. */
export const uptimeKeys = {
  monitors: ['monitors'] as const,
  monitorList: (serviceId?: number) => (serviceId === undefined ? (['monitors', 'all'] as const) : (['monitors', 'service', serviceId] as const)),
  checks: (id: number, hours: number) => ['monitor-checks', id, hours] as const,
  statusPages: ['status-pages'] as const,
};

export const uptimeApi = {
  monitors: {
    list: (serviceId?: number) => call<MonitorView[]>(serviceId === undefined ? '/v1/monitors' : `/v1/monitors?serviceId=${serviceId}`),
    get: (id: number) => call<MonitorView>(`/v1/monitors/${id}`),
    /** Newest first; `hours` 1–168. */
    checks: (id: number, hours = 24) => call<MonitorCheckView[]>(`/v1/monitors/${id}/checks?hours=${hours}`),
    create: (input: MonitorCreateInput) => call<MonitorView>('/v1/monitors', 'POST', input),
    update: (id: number, patch: MonitorPatch) => call<MonitorView>(`/v1/monitors/${id}`, 'PATCH', patch),
    remove: (id: number) => call<{ ok: true }>(`/v1/monitors/${id}`, 'DELETE'),
    check: (id: number) => call<{ check: MonitorCheckView; monitor: MonitorView }>(`/v1/monitors/${id}/check`, 'POST'),
  },
  statusPages: {
    list: () => call<StatusPageView[]>('/v1/status-pages'),
    get: (id: number) => call<StatusPageView>(`/v1/status-pages/${id}`),
    create: (input: StatusPageCreateInput) => call<StatusPageView>('/v1/status-pages', 'POST', input),
    update: (id: number, patch: StatusPagePatch) => call<StatusPageView>(`/v1/status-pages/${id}`, 'PATCH', patch),
    remove: (id: number) => call<{ ok: true }>(`/v1/status-pages/${id}`, 'DELETE'),
  },
};
