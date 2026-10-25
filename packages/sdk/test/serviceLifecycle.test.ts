import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';
it('retains accepted command state and exposes status/retry without treating 202 as completion', async () => {
  const calls: Array<[string, string]> = [];
  const command = { id: 7, action: 'start', phase: 'preparing' };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init?.method ?? 'GET']);
    return { ok: true, status: 202, text: async () => JSON.stringify(url.endsWith('/start') ? { ok: true, status: 'stopped', pending: true, lifecycle: command }
      : url.endsWith('/retry') ? { ok: true, pending: true, command } : { command }) } as Response;
  });
  const client = createClient({ baseUrl: 'https://panel.test', fetch });
  expect(await client.services.start(1)).toMatchObject({ pending: true, status: 'stopped', lifecycle: { id: 7 } });
  expect(await client.services.lifecycle(1)).toEqual({ command });
  expect(await client.services.retryLifecycle(1)).toEqual({ ok: true, pending: true, command });
  expect(calls).toEqual([['https://panel.test/v1/services/1/start', 'POST'], ['https://panel.test/v1/services/1/lifecycle', 'GET'], ['https://panel.test/v1/services/1/lifecycle/retry', 'POST']]);
});
