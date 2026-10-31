import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

it('R4: reads and changes the remote MCP policy with authenticated requests', async () => {
  const replies = [
    { policy: { enabled: false, readOnly: false }, path: '/v1/mcp' },
    { policy: { enabled: true, readOnly: true }, path: '/v1/mcp' },
  ];
  const fetch = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 }));
  const client = createClient({ baseUrl: 'https://panel.test', getToken: () => 'fixture-token', fetch });

  expect(await client.mcpRemote.policy()).toEqual({ policy: { enabled: false, readOnly: false }, path: '/v1/mcp' });
  expect(await client.mcpRemote.setPolicy({ enabled: true, readOnly: true })).toMatchObject({ policy: { enabled: true, readOnly: true } });

  const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls.map(([url, init]) => [url, init.method])).toEqual([
    ['https://panel.test/v1/mcp/policy', 'GET'],
    ['https://panel.test/v1/mcp/policy', 'PUT'],
  ]);
  expect(JSON.parse(calls[1]![1].body as string)).toEqual({ enabled: true, readOnly: true });
  for (const [, init] of calls) expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token');
});

it('R4: checks and decides an OAuth authorization for the consent page', async () => {
  const replies = [{ client: { name: 'Claude', redirectHost: 'claude.ai' }, requestedAccess: 'read' }, { redirect: 'https://claude.ai/cb?code=c' }];
  const fetch = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 }));
  const client = createClient({ baseUrl: 'https://panel.test', getToken: () => 'session', fetch });
  const request = { client_id: 'ndc_x', redirect_uri: 'https://claude.ai/cb', state: 'a b&c' };
  expect(await client.mcpRemote.checkAuthorization(request)).toMatchObject({ requestedAccess: 'read' });
  expect(await client.mcpRemote.decideAuthorization({ request, approve: true, access: 'full' })).toEqual({ redirect: 'https://claude.ai/cb?code=c' });
  const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls[0]![0]).toBe('https://panel.test/v1/oauth/authorize?client_id=ndc_x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=a%20b%26c');
  expect(calls[1]![1].method).toBe('POST');
  expect(JSON.parse(calls[1]![1].body as string)).toEqual({ request, approve: true, access: 'full' });
});
