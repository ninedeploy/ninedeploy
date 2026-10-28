import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

describe('OS updates API', () => {
  it('addresses the panel and individual nodes with the requested action', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET',
        body: init.body === undefined ? undefined : JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => '{}' } as Response;
    });
    const api = createClient({ baseUrl: 'http://api.test', fetch });
    await api.osUpdates.get(null);
    await api.osUpdates.get(7, { refresh: true });
    await api.osUpdates.get(7, { refresh: false });
    await api.osUpdates.setAuto(null, true);
    await api.osUpdates.setAuto(7, false);
    expect(calls).toEqual([
      { path: '/v1/os-updates', method: 'GET', body: undefined },
      { path: '/v1/servers/7/os-updates?refresh=1', method: 'GET', body: undefined },
      { path: '/v1/servers/7/os-updates', method: 'GET', body: undefined },
      { path: '/v1/os-updates/auto', method: 'POST', body: { enabled: true } },
      { path: '/v1/servers/7/os-updates/auto', method: 'POST', body: { enabled: false } },
    ]);
  });
});
