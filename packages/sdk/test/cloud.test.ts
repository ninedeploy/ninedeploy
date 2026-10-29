import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

it('sends cloud actions to their intended routes and includes the creation parameters', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{}' } as Response;
  });
  const cloud = createClient({ baseUrl: 'http://api.test', fetch }).cloud.hetzner;
  const input = { name: 'worker', location: 'fsn1', serverType: 'cx22', image: 'ubuntu-24.04' };
  await cloud.status(); await cloud.setToken('token'); await cloud.deleteToken(); await cloud.options();
  await cloud.servers(); await cloud.createServer(input); await cloud.deleteServer(7);
  expect(calls).toEqual([
    { path: '/v1/cloud/hetzner', method: 'GET', body: undefined },
    { path: '/v1/cloud/hetzner/token', method: 'PUT', body: { token: 'token' } },
    { path: '/v1/cloud/hetzner/token', method: 'DELETE', body: undefined },
    { path: '/v1/cloud/hetzner/options', method: 'GET', body: undefined },
    { path: '/v1/cloud/hetzner/servers', method: 'GET', body: undefined },
    { path: '/v1/cloud/hetzner/servers', method: 'POST', body: input },
    { path: '/v1/cloud/hetzner/servers/7', method: 'DELETE', body: undefined },
  ]);
});

it('sends DigitalOcean actions to their routes', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{}' } as Response;
  });
  const cloud = createClient({ baseUrl: 'http://api.test', fetch }).cloud.digitalocean;
  const input = { name: 'worker', region: 'fra1', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' };
  await cloud.status(); await cloud.setToken('token'); await cloud.deleteToken(); await cloud.options();
  await cloud.servers(); await cloud.createServer(input); await cloud.deleteServer(7);
  expect(calls).toEqual([
    { path: '/v1/cloud/digitalocean', method: 'GET', body: undefined },
    { path: '/v1/cloud/digitalocean/token', method: 'PUT', body: { token: 'token' } },
    { path: '/v1/cloud/digitalocean/token', method: 'DELETE', body: undefined },
    { path: '/v1/cloud/digitalocean/options', method: 'GET', body: undefined },
    { path: '/v1/cloud/digitalocean/servers', method: 'GET', body: undefined },
    { path: '/v1/cloud/digitalocean/servers', method: 'POST', body: input },
    { path: '/v1/cloud/digitalocean/servers/7', method: 'DELETE', body: undefined },
  ]);
});

it('sends Vultr actions to their routes', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{}' } as Response;
  });
  const cloud = createClient({ baseUrl: 'http://api.test', fetch }).cloud.vultr;
  const input = { name: 'worker', region: 'ams', plan: 'vc2-1c-1gb', osId: 2284 };
  await cloud.status(); await cloud.setToken('token'); await cloud.deleteToken(); await cloud.options();
  await cloud.servers(); await cloud.createServer(input); await cloud.deleteServer(7);
  expect(calls).toEqual([
    { path: '/v1/cloud/vultr', method: 'GET', body: undefined },
    { path: '/v1/cloud/vultr/token', method: 'PUT', body: { token: 'token' } },
    { path: '/v1/cloud/vultr/token', method: 'DELETE', body: undefined },
    { path: '/v1/cloud/vultr/options', method: 'GET', body: undefined },
    { path: '/v1/cloud/vultr/servers', method: 'GET', body: undefined },
    { path: '/v1/cloud/vultr/servers', method: 'POST', body: input },
    { path: '/v1/cloud/vultr/servers/7', method: 'DELETE', body: undefined },
  ]);
});
