import { expect, it, vi } from 'vitest';
import { createClient, NineDeployError } from '../src/index.js';

it('reads and updates the panel allow-list with authenticated requests and returns the caller address', async () => {
  const disabled = { enabled: false, cidrs: [], includeTokens: false, yourIp: '203.0.113.9', overridden: false };
  const input = { enabled: true, cidrs: ['203.0.113.0/24', '2001:db8::/32'], includeTokens: true };
  const updated = { ...input, yourIp: disabled.yourIp, overridden: false };
  const replies = [disabled, updated, disabled];
  const fetch = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 }));
  const client = createClient({ baseUrl: 'https://panel.test', getToken: () => 'session-fixture', fetch });

  expect(await client.settings.panelAccess.get()).toEqual(disabled);
  expect(await client.settings.panelAccess.set(input)).toEqual(updated);
  const off = { enabled: false, cidrs: [], includeTokens: false };
  expect(await client.settings.panelAccess.set(off)).toEqual(disabled);

  const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls.map(([url, init]) => [url, init.method])).toEqual([
    ['https://panel.test/v1/settings/panel-access', 'GET'],
    ['https://panel.test/v1/settings/panel-access', 'PUT'],
    ['https://panel.test/v1/settings/panel-access', 'PUT'],
  ]);
  expect(calls[0]![1].body).toBeUndefined();
  expect(JSON.parse(calls[1]![1].body as string)).toEqual(input);
  expect(JSON.parse(calls[2]![1].body as string)).toEqual(off);
  for (const [, init] of calls) expect(new Headers(init.headers).get('authorization')).toBe('Bearer session-fixture');
});

it('surfaces the server’s lockout refusal without pretending the new list was saved', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'The list does not include your address' } }), { status: 409 }));
  const client = createClient({ baseUrl: 'https://panel.test', token: 'session-fixture', fetch });
  const save = client.settings.panelAccess.set({ enabled: true, cidrs: ['198.51.100.1'], includeTokens: false });
  await expect(save).rejects.toBeInstanceOf(NineDeployError);
  await expect(save).rejects.toMatchObject({ status: 409, code: 'conflict' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
