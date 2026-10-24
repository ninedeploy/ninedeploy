import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';
describe('database-scoped statistics', () => {
  it('keeps default monitoring local and explicitly selects a database when requested', async () => {
    const calls: string[] = [];
    const api = createClient({ baseUrl: 'https://panel.example', fetch: vi.fn(async url => {
      const parsed = new URL(String(url)); calls.push(parsed.pathname + parsed.search);
      return new Response(JSON.stringify({ host: null, containers: [], ...(parsed.searchParams.has('databaseId') ? { resource: { kind: 'database', id: 13, serverId: 8, state: 'pending', sampledAt: null } } : {}) }), { status: 200 });
    }) });
    await api.stats.snapshot(); await api.stats.snapshot({}); await api.stats.snapshot({ databaseId: 13 });
    expect(calls).toEqual(['/v1/stats', '/v1/stats', '/v1/stats?databaseId=13']);
  });
  it.each([
    { host: { cpuCores: 8 }, containers: [] },
    { host: null, containers: [], resource: { kind: 'database', id: 99, serverId: 8, state: 'live', sampledAt: 1 } },
    { host: null, containers: [{ kind: 'database', refId: 99 }], resource: { kind: 'database', id: 13, serverId: 8, state: 'live', sampledAt: 1 } },
  ])('refuses an old/unscoped/mismatched response instead of returning another host or resource: %j', async payload => {
    const api = createClient({ baseUrl: 'https://panel.example', fetch: vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) });
    await expect(api.stats.snapshot({ databaseId: 13 })).rejects.toThrow(/database-scoped metrics/i);
  });
});
