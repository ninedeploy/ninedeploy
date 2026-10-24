import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';
afterEach(() => vi.restoreAllMocks());
describe('database Studio browser grant and bounded preparation', () => {
  const fetcher = () => vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, port: null, serverId: 7, url: '/v1/databases/7/studio-proxy/' }) }));
  it('allows image preparation and includes the browser cookie on the API origin', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout'), fetch = fetcher();
    const result = await createClient({ baseUrl: 'https://owned.example', fetch }).databases.startStudio(7);
    expect(result).toMatchObject({ port: null, serverId: 7 }); expect(timeout).toHaveBeenLastCalledWith(240000);
    expect(fetch).toHaveBeenCalledWith('https://owned.example/v1/databases/7/studio', expect.objectContaining({ method: 'POST', credentials: 'include', body: '{}' }));
  });
  it('allows clear to wait for an outstanding preparation without timing out the SDK first', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout'), fetch = fetcher();
    await createClient({ baseUrl: 'https://owned.example', fetch }).databases.stopStudio(7);
    expect(timeout).toHaveBeenLastCalledWith(270000); expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'DELETE', credentials: 'include' }));
  });
  it('preserves custom larger and disabled budgets and the optional local port', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout'), fetch = fetcher();
    await createClient({ baseUrl: 'https://owned.example', fetch, timeoutMs: 360000 }).databases.startStudio(7, 18077);
    expect(timeout).toHaveBeenLastCalledWith(360000); expect(fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: '{"port":18077}' }));
    timeout.mockClear(); const client = createClient({ baseUrl: 'https://owned.example', fetch, timeoutMs: 0 });
    await client.databases.startStudio(7); await client.databases.stopStudio(7); expect(timeout).not.toHaveBeenCalled();
  });
  it('retains ordinary database request budgets', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await createClient({ baseUrl: 'https://owned.example', fetch: fetcher() }).databases.get(7); expect(timeout).toHaveBeenLastCalledWith(30000);
  });
});
