import { describe, expect, it, vi } from 'vitest';
import { NineDeployError, apiGetUrl, createClient } from '../src/index.js';

/**
 * `client.api.get` (0.15, DESIGN §3.4): raw, read-only access to the
 * documented API, used by the generated MCP read tools. GET only, and the path
 * is validated so a caller (or a model) cannot steer it outside `/v1/`.
 */
function client() {
  const calls: Array<{ url: string; method: string }> = [];
  const fetch = vi.fn(async (url: string, init: { method?: string }) => {
    calls.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET' });
    return { ok: true, status: 200, text: async () => '{"ok":true}' } as unknown as Response;
  });
  return { calls, c: createClient({ baseUrl: 'http://api.test', fetch, getToken: () => 't' }) };
}

describe('client.api.get', () => {
  it('GETs the path with an encoded query, dropping undefined values', async () => {
    const { calls, c } = client();
    expect(await c.api.get<{ ok: boolean }>('/v1/databases/3/backups', { limit: 5, q: 'a b&c', all: true, skip: undefined })).toEqual({ ok: true });
    expect(calls).toEqual([{ url: '/v1/databases/3/backups?limit=5&q=a%20b%26c&all=true', method: 'GET' }]);
    await c.api.get('/v1/openapi.json');
    expect(calls[1]).toEqual({ url: '/v1/openapi.json', method: 'GET' });
  });

  it('refuses a path outside /v1, with a query or traversal in it, before any request', async () => {
    const { calls, c } = client();
    for (const bad of ['/health', '/v1/', '/v1/services?x=1', '/v1/../health', '/v1/a/../../x', '/v1/a%2f..', '/v1/a b', 'http://evil/v1/x']) {
      await expect(c.api.get(bad as `/v1/${string}`)).rejects.toMatchObject({ code: 'invalid_path' });
    }
    expect(calls).toEqual([]);
  });

  it('apiGetUrl builds the same URL and throws a typed error', () => {
    expect(apiGetUrl('/v1/servers')).toBe('/v1/servers');
    expect(apiGetUrl('/v1/servers', {})).toBe('/v1/servers');
    expect(apiGetUrl('/v1/x', { a: 1, b: undefined })).toBe('/v1/x?a=1');
    expect(() => apiGetUrl('/v2/x')).toThrow(NineDeployError);
  });
});
