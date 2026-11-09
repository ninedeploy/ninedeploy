import { expect, it, vi } from 'vitest';
import { createClient, NineDeployError } from '../src/index.js';

it('reads the selected service capability view with an authenticated GET and preserves all statuses', async () => {
  const view = {
    serviceId: 17,
    runtime: 'node-docker',
    capabilities: {
      maintenance: { status: 'unavailable', reason: 'Not available on this runtime' },
      errorPages: { status: 'limited', reason: 'Only selected responses are handled' },
      forwardAuth: { status: 'available', reason: null },
      restartLimit: { status: 'in_progress', reason: 'Waiting for runtime support' },
      inlineDockerfile: { status: 'available', reason: null },
      fileMounts: { status: 'available', reason: null },
      autoscale: { status: 'limited', reason: 'Capacity is held' },
      scaleToZero: { status: 'unavailable', reason: 'Wake cannot be confirmed' },
      canary: { status: 'available', reason: null },
    },
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }));
  const client = createClient({ baseUrl: 'https://panel.test', getToken: () => 'capability-fixture', fetch });
  expect(await client.services.capabilities(17)).toEqual(view);
  const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe('https://panel.test/v1/services/17/capabilities');
  expect(calls[0]![1].method).toBe('GET');
  expect(calls[0]![1].body).toBeUndefined();
  expect(new Headers(calls[0]![1].headers).get('authorization')).toBe('Bearer capability-fixture');
});

it('propagates a capability-view refusal without returning a fabricated view', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Service access denied' } }), { status: 403 }));
  const client = createClient({ baseUrl: 'https://panel.test', token: 'capability-fixture', fetch });
  const request = client.services.capabilities(99);
  await expect(request).rejects.toBeInstanceOf(NineDeployError);
  await expect(request).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'Service access denied' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
