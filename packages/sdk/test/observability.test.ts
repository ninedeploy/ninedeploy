import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';
describe('observability request mapping', () => {
  it('maps settings, collector tests and log queue actions to the documented routes', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const api = createClient({ baseUrl: 'https://panel.example', fetch: vi.fn(async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response('{}', { status: 200 });
    }) });
    await api.stats.observability.get();
    await api.stats.observability.update({ retentionDays: 30 });
    await api.stats.observability.test();
    await api.logDrains.queue(4); await api.logDrains.retryQueue(4); await api.logDrains.discardQueue(4);
    expect(calls).toEqual([
      { path: '/v1/stats/observability', method: 'GET', body: undefined },
      { path: '/v1/stats/observability', method: 'PATCH', body: { retentionDays: 30 } },
      { path: '/v1/stats/observability/test', method: 'POST', body: undefined },
      { path: '/v1/log-drains/4/queue', method: 'GET', body: undefined },
      { path: '/v1/log-drains/4/queue/retry', method: 'POST', body: undefined },
      { path: '/v1/log-drains/4/queue', method: 'DELETE', body: undefined },
    ]);
  });
});
