import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

it('reads the live routing view of a service', async () => {
  const view = { live: true, liveNote: null, container: null, http: [], ports: [] };
  const fetch = vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }));
  const client = createClient({ baseUrl: 'https://panel.test', getToken: () => 'fixture-token', fetch });

  expect(await client.services.routing(7)).toEqual(view);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit | undefined];
  expect(url).toBe('https://panel.test/v1/services/7/routing');
  expect(init?.method ?? 'GET').toBe('GET');
});
