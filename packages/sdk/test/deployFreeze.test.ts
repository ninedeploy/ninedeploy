import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

it('addresses deploy freeze operations and URL-encodes the identifier', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{}' } as Response;
  });
  const freezes = createClient({ baseUrl: 'http://api.test', fetch }).deployFreezes;
  const input = { scope: 'project' as const, targetId: 4, reason: 'maintenance' };
  await freezes.list(); await freezes.create(input); await freezes.lift('freeze/id #1');
  expect(calls).toEqual([
    { path: '/v1/deploy-freezes', method: 'GET', body: undefined },
    { path: '/v1/deploy-freezes', method: 'POST', body: input },
    { path: '/v1/deploy-freezes/freeze%2Fid%20%231', method: 'DELETE', body: undefined },
  ]);
});
