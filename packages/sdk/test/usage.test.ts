import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

it('reads the usage report and the server costs at their routes', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{}' } as Response;
  });
  const usage = createClient({ baseUrl: 'http://api.test', fetch }).usage;
  const costs = { currency: 'EUR', servers: [{ serverId: null, monthlyCost: 20 }] };
  await usage.report(); await usage.report({ days: 7 }); await usage.costs(); await usage.setCosts(costs);
  expect(calls).toEqual([
    { path: '/v1/usage?days=30', method: 'GET', body: undefined },
    { path: '/v1/usage?days=7', method: 'GET', body: undefined },
    { path: '/v1/usage/costs', method: 'GET', body: undefined },
    { path: '/v1/usage/costs', method: 'PUT', body: costs },
  ]);
});
