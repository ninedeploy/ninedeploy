// Client surface: logDrains.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  LogDrain,
  LogDrainCreateInput,
  LogDrainUpdateInput,
  LogDrainTestResult,
  LogQueueStatus,
} from '@ninedeploy/schemas';
import type { LogSearchInput, LogSearchResult } from '../types.js';
import type { Transport } from '../transport.js';

export interface LogsApi {
  logDrains: {
    queue: (id: number) => Promise<LogQueueStatus>;
    retryQueue: (id: number) => Promise<LogQueueStatus>;
    discardQueue: (id: number) => Promise<{ discardedBatches: number }>;
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
}

export function logsApi(t: Transport): LogsApi {
  const { get, send } = t;
  return {
    logDrains: {
      queue: (id) => get<LogQueueStatus>('/v1/log-drains/' + id + '/queue'),
      retryQueue: (id) => send<LogQueueStatus>('POST', '/v1/log-drains/' + id + '/queue/retry'),
      discardQueue: (id) => send<{ discardedBatches: number }>('DELETE', '/v1/log-drains/' + id + '/queue'),
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
  };
}
