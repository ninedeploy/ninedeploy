import { expect, it, vi } from 'vitest';
import { createClient, NineDeployError } from '../src/index.js';

it('uses the image scan policy and service routes with authenticated requests', async () => {
  const replies = [
    { policy: { enabled: false, gate: 'off', gateFixableOnly: true, rescanHours: 24 }, trivyImage: 'trivy:test' },
    { policy: { enabled: true, gate: 'high', gateFixableOnly: true, rescanHours: 24 }, trivyImage: 'trivy:test' },
    { result: null, scanning: true },
    { started: true, imageId: 'sha256:example' },
  ];
  const fetch = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 }));
  const client = createClient({ baseUrl: 'https://panel.test/console', getToken: () => 'fixture-token', fetch });

  expect(await client.imageScans.policy()).toMatchObject({ policy: { enabled: false }, trivyImage: 'trivy:test' });
  expect(await client.imageScans.setPolicy({ enabled: true, gate: 'high' })).toMatchObject({ policy: { enabled: true, gate: 'high' } });
  expect(await client.imageScans.get(7)).toEqual({ result: null, scanning: true });
  expect(await client.imageScans.scan(7)).toEqual({ started: true, imageId: 'sha256:example' });

  const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls.map(([url, init]) => [url, init.method])).toEqual([
    ['https://panel.test/console/v1/image-scanning', 'GET'],
    ['https://panel.test/console/v1/image-scanning', 'PUT'],
    ['https://panel.test/console/v1/services/7/image-scan', 'GET'],
    ['https://panel.test/console/v1/services/7/image-scan', 'POST'],
  ]);
  expect(JSON.parse(calls[1]![1].body as string)).toEqual({ enabled: true, gate: 'high' });
  for (const [, init] of calls) expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token');
});

it('surfaces a rejected scan instead of reporting it started', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Admin access required' } }), { status: 403 }));
  const client = createClient({ baseUrl: 'https://panel.test', fetch });
  const scan = client.imageScans.scan(7);
  await expect(scan).rejects.toBeInstanceOf(NineDeployError);
  await expect(scan).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'Admin access required' });
});

it('returns a pending node scan before its image id is known', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ started: true, imageId: null }), { status: 202 }));
  const client = createClient({ baseUrl: 'https://panel.test', fetch });
  expect(await client.imageScans.scan(7)).toEqual({ started: true, imageId: null });
});
