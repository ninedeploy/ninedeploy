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
