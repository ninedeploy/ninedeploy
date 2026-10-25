import { expect, it, vi } from 'vitest';
import { createClient, NineDeployError } from '../src/index.js';

it.each([{ ids: [19, 20, 21] }, { statuses: ['failed', 'cancelled'] as Array<'failed' | 'cancelled'> }])('sends an authenticated bulk removal with %j and retains cleanup results', async input => {
  const receipt = { ok: true as const, removed: [19, 20], skipped: 1, removedContainers: ['web-19'] };
  const fetch = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200 }));
  const client = createClient({ baseUrl: 'https://panel.test/console', getToken: () => 'fixture-token', fetch });

  expect(await client.deploys.removeMany(7, input)).toEqual(receipt);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://panel.test/console/v1/services/7/deploys/bulk-delete');
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token');
  expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual(input);
});

it('surfaces a refused bulk removal instead of reporting successful cleanup', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Admin access required' } }), { status: 403 }));
  const client = createClient({ baseUrl: 'https://panel.test', fetch });
  const removal = client.deploys.removeMany(7, { ids: [19] });

  await expect(removal).rejects.toBeInstanceOf(NineDeployError);
  await expect(removal).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'Admin access required' });
  expect(fetch).toHaveBeenCalledOnce();
});
