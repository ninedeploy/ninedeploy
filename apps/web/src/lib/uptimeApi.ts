import { NineDeployError } from '@ninedeploy/sdk';
import type {
  MonitorCheckView,
  MonitorCreateInput,
  MonitorPatch,
  MonitorView,
  StatusPageCreateInput,
  StatusPagePatch,
  StatusPageView,
} from '@ninedeploy/schemas';
import { authedFetch } from './api.js';

/**
 * 0.16.8 uptime monitors and status pages. Typed calls over `authedFetch`
 * (bearer + refresh-on-401, same as the SDK client) with the SDK's error
 * shape, so a failed request carries the server's message.
 */
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await authedFetch(path, init);
  const text = await res.text();
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
  if (parsed === undefined) {
    if (text === '') return {} as T;
    throw new NineDeployError(res.status, 'invalid_response', `Expected JSON but received a non-JSON body (status ${res.status})`);
  }
  return parsed as T;
}

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
