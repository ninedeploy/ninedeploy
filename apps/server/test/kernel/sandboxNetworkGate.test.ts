import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sandbox installs spawn a Worker during init; the bootstrap only exists as
// compiled .js. Same stand-in as pluginLoader.test.ts: READY on attach.
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWorker extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);
    override on(event: string, cb: (...args: never[]) => void): this {
      super.on(event, cb as never);
      if (event === 'message') queueMicrotask(() => this.emit('message', { type: 'READY', payload: {} }));
      return this;
    }
  }
  return { Worker: FakeWorker, parentPort: null };
});

import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { installPlugin, SandboxNetworkUnrestrictedError } from '../../src/kernel/pluginLoader.js';
import { SandboxPlugin } from '../../src/kernel/sandbox/sandboxPlugin.js';
import { pluginRoutes } from '../../src/modules/plugins.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

const mockConfig = { paths: { dataDir: '/tmp/test' } } as never;

function loaderDb(existing: Record<string, unknown> | null = null) {
  return {
    query: { installedPlugins: { findFirst: vi.fn().mockResolvedValue(existing), findMany: vi.fn().mockResolvedValue([]) } },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue([]) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
  };
}

const sandboxInput = { source: 'sandbox' as const, target: 'acme-net', code: 'return {};' };

describe('r600 — sandbox plugins on a Node without network permission', () => {
  let netDenied: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    netDenied = vi.spyOn(SandboxPlugin, 'networkDenied');
    delete process.env['NINEDEPLOY_ALLOW_SANDBOX_NETWORK'];
  });
  afterEach(() => {
    netDenied.mockRestore();
    delete process.env['NINEDEPLOY_ALLOW_SANDBOX_NETWORK'];
  });

  it('refuses a NEW sandbox install with 409 naming the Node version and both fixes', async () => {
    netDenied.mockReturnValue(false);
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const db = loaderDb();
    const attempt = installPlugin(db as never, kernel, sandboxInput);
    await expect(attempt).rejects.toBeInstanceOf(SandboxNetworkUnrestrictedError);
    await expect(attempt).rejects.toThrow(process.version);
    await expect(attempt).rejects.toThrow(/Node\.js to 25 or newer/);
    await expect(attempt).rejects.toThrow(/NINEDEPLOY_ALLOW_SANDBOX_NETWORK=1/);
    expect(db.insert).not.toHaveBeenCalled();
    expect(kernel.getPlugin('acme-net')).toBeUndefined();
  });

  it('installs when the operator opted in, or when the Node denies network', async () => {
    netDenied.mockReturnValue(false);
    process.env['NINEDEPLOY_ALLOW_SANDBOX_NETWORK'] = '1';
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    expect(await installPlugin(loaderDb() as never, kernel, sandboxInput)).toEqual({ ok: true, id: 'acme-net', status: 'active' });
    await kernel.unregisterPlugin('acme-net');

    delete process.env['NINEDEPLOY_ALLOW_SANDBOX_NETWORK'];
    netDenied.mockReturnValue(true);
    expect(await installPlugin(loaderDb() as never, kernel, sandboxInput)).toEqual({ ok: true, id: 'acme-net', status: 'active' });
    await kernel.unregisterPlugin('acme-net');
  });

  it('only "1" opts in — a stray value does not', async () => {
    netDenied.mockReturnValue(false);
    process.env['NINEDEPLOY_ALLOW_SANDBOX_NETWORK'] = 'true';
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    await expect(installPlugin(loaderDb() as never, kernel, sandboxInput)).rejects.toBeInstanceOf(SandboxNetworkUnrestrictedError);
  });

  it('marketplace installs are not affected', async () => {
    netDenied.mockReturnValue(false);
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const catalog = [{ id: 'mk', name: 'Mk', version: '1.0.0', description: 'x', author: 'x', icon: 'Box', category: 'x', isOfficial: true, implemented: true, dependencies: [], configSchema: [], menuItems: [] }];
    expect(await installPlugin(loaderDb() as never, kernel, { source: 'marketplace', target: 'mk' }, catalog as never)).toMatchObject({ ok: true });
  });

  it('route: POST /install answers 409 with the actionable message (wired through the real route)', async () => {
    netDenied.mockReturnValue(false);
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(pluginRoutes);
    const res = await app.inject({ method: 'POST', url: '/install', headers: asUser(), payload: sandboxInput });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/NINEDEPLOY_ALLOW_SANDBOX_NETWORK=1/);
    expect(app.kernel.getPlugin('acme-net')).toBeUndefined();
  });

  it('already-installed sandbox plugins keep loading and the list/inspect surface networkRestricted', async () => {
    netDenied.mockReturnValue(false);
    const row = {
      id: 'legacy-sb',
      name: 'Legacy',
      version: '1.0.0',
      isOfficial: false,
      enabled: true,
      status: 'active',
      error: null,
      manifest: { source: 'sandbox', target: 'legacy-sb', code: 'return {};' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const disabledRow = { ...row, id: 'off-sb', enabled: false, status: 'disabled', manifest: { ...row.manifest, target: 'off-sb' } };
    const marketRow = { ...row, id: 'mkt', manifest: { source: 'marketplace', target: 'mkt' } };
    const db = createFakeDb({
      findFirst: { installedPlugins: (() => row) as never },
      findMany: { installedPlugins: (() => [row, disabledRow, marketRow]) as never },
    });
    const app = await buildTestApp({ db });
    await app.register(pluginRoutes);
    // Upgrade safety: the enable/reload restore path does NOT pass the gate.
    const reload = await app.inject({ method: 'POST', url: '/legacy-sb/reload', headers: asUser() });
    expect(reload.statusCode).toBe(200);
    expect(app.kernel.getPlugin('legacy-sb')).toBeInstanceOf(SandboxPlugin);

    const list = (await app.inject({ method: 'GET', url: '/', headers: asUser() })).json().plugins as Array<Record<string, unknown>>;
    expect(list.find((p) => p.id === 'legacy-sb')).toMatchObject({ networkRestricted: false });
    expect(list.find((p) => p.id === 'off-sb')).toMatchObject({ networkRestricted: false });
    expect(list.find((p) => p.id === 'mkt')).not.toHaveProperty('networkRestricted');

    const inspect = (await app.inject({ method: 'GET', url: '/legacy-sb/inspect', headers: asUser() })).json();
    expect(inspect.networkRestricted).toBe(false);

    netDenied.mockReturnValue(true);
    const list2 = (await app.inject({ method: 'GET', url: '/', headers: asUser() })).json().plugins as Array<Record<string, unknown>>;
    expect(list2.find((p) => p.id === 'legacy-sb')).toMatchObject({ networkRestricted: true });
    await app.kernel.unregisterPlugin('legacy-sb');
  });
});
