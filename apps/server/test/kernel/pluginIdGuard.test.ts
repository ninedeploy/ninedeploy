import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  BUILT_IN_PLUGIN_IDS,
  installPlugin,
  loadInstalledPlugins,
  PluginIdConflictError,
  uninstallPlugin,
} from '../../src/kernel/pluginLoader.js';
import { BuildCachePlugin } from '../../src/kernel/plugins/buildCachePlugin.js';
import { CloudflareTunnelsPlugin } from '../../src/kernel/plugins/cloudflareTunnels.js';
import { ConfigPresetsPlugin } from '../../src/kernel/plugins/configPresets.js';
import { DomainPresetsPlugin } from '../../src/kernel/plugins/domainPresets.js';
import { ManifestGeneratorPlugin } from '../../src/kernel/plugins/manifestGenerator.js';
import { MetricHistoryPlugin } from '../../src/kernel/plugins/metricHistory.js';
import { NotificationsDispatcherPlugin } from '../../src/kernel/plugins/notifications.js';
import { StickyIpPlugin } from '../../src/kernel/plugins/stickyIpPlugin.js';
import { StickySessionPlugin } from '../../src/kernel/plugins/stickySession.js';
import { TelemetryStreamerPlugin } from '../../src/kernel/plugins/telemetry.js';
import { TemplateBundlesPlugin } from '../../src/kernel/plugins/templateBundles.js';
import { WebhookOutPlugin } from '../../src/kernel/plugins/webhookOut.js';
import { pluginRoutes } from '../../src/modules/plugins.js';
import { SandboxPlugin } from '../../src/kernel/sandbox/sandboxPlugin.js';
import { asUser, buildTestApp, createFakeDb, trackStatusUpdates } from '../helpers.js';

const BUILT_IN_CLASSES: Record<string, new () => { id: string }> = {
  BuildCachePlugin,
  CloudflareTunnelsPlugin,
  ConfigPresetsPlugin,
  DomainPresetsPlugin,
  ManifestGeneratorPlugin,
  MetricHistoryPlugin,
  NotificationsDispatcherPlugin,
  StickyIpPlugin,
  StickySessionPlugin,
  TelemetryStreamerPlugin,
  TemplateBundlesPlugin,
  WebhookOutPlugin,
};

const mockConfig = { paths: { dataDir: '/tmp/test' } } as never;

// r600: these cases are about ids, not the network gate — run them as on a
// Node >= 25 (CI's node:26) regardless of the Node executing the suite.
beforeEach(() => {
  vi.spyOn(SandboxPlugin, 'networkDenied').mockReturnValue(true);
});

describe('r531 — reserved built-in plugin ids', () => {
  it('BUILT_IN_PLUGIN_IDS is exactly what plugins/kernel.ts registers', () => {
    // Wiring guard: read the boot module's registrations instead of trusting
    // a hand-kept list — a new built-in added there without being reserved
    // here would be shadowable by an install.
    const kernelSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'plugins', 'kernel.ts'),
      'utf8',
    );
    const registered = [...kernelSrc.matchAll(/registerPlugin\(new (\w+)\(\)\)/g)].map((m) => m[1]!);
    expect(registered.sort()).toEqual(Object.keys(BUILT_IN_CLASSES).sort());
    const ids = registered.map((name) => new BUILT_IN_CLASSES[name]!().id);
    expect([...ids].sort()).toEqual([...BUILT_IN_PLUGIN_IDS].sort());
  });

  function loaderDb(existing: Record<string, unknown> | null = null) {
    return {
      query: { installedPlugins: { findFirst: vi.fn().mockResolvedValue(existing), findMany: vi.fn().mockResolvedValue([]) } },
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue([]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    };
  }

  it('a sandbox install cannot take a built-in id (and the built-in survives)', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const builtIn = new DomainPresetsPlugin();
    await kernel.registerPlugin(builtIn);
    const db = loaderDb();

    const attempt = installPlugin(db as never, kernel, { source: 'sandbox', target: 'domain-presets', code: 'return {};' });
    await expect(attempt).rejects.toBeInstanceOf(PluginIdConflictError);
    await expect(attempt).rejects.toThrow(/reserved by a built-in plugin/);
    // Pre-r531 the install unregistered the built-in and put the sandbox in
    // its place, inheriting `plugin:domain-presets:*` (the DNS record ledger).
    expect(kernel.getPlugin('domain-presets')).toBe(builtIn);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses namespace-escaping ids, catalog ids and cross-source takeovers', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    await expect(
      installPlugin(loaderDb() as never, kernel, { source: 'sandbox', target: 'domain-presets:record', code: 'return {};' }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      installPlugin(loaderDb() as never, kernel, { source: 'sandbox', target: 'acme.notifier', code: 'return {};' }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      installPlugin(loaderDb() as never, kernel, { source: 'sandbox', target: 's3-backups', code: 'return {};' }),
    ).rejects.toThrow(/marketplace catalog/);
    const marketplaceRow = { id: 'acme', name: 'Acme', enabled: false, manifest: { source: 'marketplace', target: 'acme' } };
    await expect(
      installPlugin(loaderDb(marketplaceRow) as never, kernel, { source: 'sandbox', target: 'acme', code: 'return {};' }),
    ).rejects.toThrow(/already used by an installed marketplace plugin/);
  });

  it('reinstalling a sandbox plugin over its own row stays allowed (r420 upgrade path)', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const ownRow = { id: 'acme', name: 'Acme', enabled: false, manifest: { source: 'sandbox', target: 'acme', code: 'x' } };
    const res = await installPlugin(loaderDb(ownRow) as never, kernel, { source: 'sandbox', target: 'acme', code: 'return {};' });
    expect(res).toEqual({ ok: true, id: 'acme', status: 'active' });
    await kernel.unregisterPlugin('acme');
  });

  it('boot: a previously-installed colliding plugin is skipped with a visible error, boot continues', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const builtIn = new WebhookOutPlugin();
    await kernel.registerPlugin(builtIn);
    const db = loaderDb();
    db.query.installedPlugins.findMany.mockResolvedValue([
      { id: 'webhook-out', name: 'Shadow', version: '1.0.0', enabled: true, manifest: { source: 'sandbox', target: 'webhook-out', code: 'return {};' } },
      { id: 'evil:record', name: 'Colon', version: '1.0.0', enabled: true, manifest: { source: 'sandbox', target: 'evil:record', code: 'return {};' } },
      { id: 'fine-one', name: 'Fine', version: '1.0.0', enabled: true, manifest: { source: 'sandbox', target: 'fine-one', code: 'return {};' } },
    ]);
    const sets: Array<Record<string, unknown>> = [];
    db.update.mockImplementation(() => ({
      set: vi.fn((s: Record<string, unknown>) => {
        sets.push(s);
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const loaded = await loadInstalledPlugins(db as never, kernel);
      expect(loaded).toBe(1);
      expect(kernel.getPlugin('webhook-out')).toBe(builtIn);
      expect(kernel.getPlugin('fine-one')).toBeDefined();
      expect(kernel.getPlugin('evil:record')).toBeUndefined();
      expect(sets).toHaveLength(2);
      expect(sets[0]).toMatchObject({ status: 'errored' });
      expect(String(sets[0]!['error'])).toMatch(/reserved by the built-in "webhook-out"/);
      expect(String(sets[1]!['error'])).toMatch(/configuration namespace/);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('webhook-out'));
    } finally {
      errSpy.mockRestore();
      await kernel.unregisterPlugin('fine-one');
    }
  });

  it('boot: recording the conflict on the row failing does not abort the restore', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const db = loaderDb();
    db.query.installedPlugins.findMany.mockResolvedValue([
      { id: 'sticky-ip', name: 'Shadow', version: '1.0.0', enabled: true, manifest: { source: 'sandbox', target: 'sticky-ip', code: 'x' } },
    ]);
    db.update.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadInstalledPlugins(db as never, kernel)).resolves.toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('uninstalling a stray row under a built-in id removes the row, not the built-in', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const builtIn = new DomainPresetsPlugin();
    await kernel.registerPlugin(builtIn);
    const db = loaderDb({ id: 'domain-presets', name: 'Shadow' });
    await uninstallPlugin(db as never, kernel, 'domain-presets');
    expect(db.delete).toHaveBeenCalled();
    expect(kernel.getPlugin('domain-presets')).toBe(builtIn);
  });

  it('routes: enable/disable/reload refuse a built-in id with 409; list keeps the built-in active', async () => {
    const stray = {
      id: 'domain-presets',
      name: 'Shadow',
      version: '1.0.0',
      isOfficial: false,
      enabled: true,
      status: 'errored',
      error: 'collision recorded at boot',
      manifest: { source: 'sandbox', target: 'domain-presets', code: 'return {};' },
      createdAt: new Date(),
    };
    const db = createFakeDb({
      findFirst: { installedPlugins: (() => stray) as never },
      findMany: { installedPlugins: (() => [stray]) as never },
    });
    const { updates } = trackStatusUpdates(db);
    const app = await buildTestApp({ db });
    await app.register(pluginRoutes);
    const builtIn = new DomainPresetsPlugin();
    await app.kernel.registerPlugin(builtIn);

    for (const action of ['enable', 'disable', 'reload']) {
      const res = await app.inject({ method: 'POST', url: `/domain-presets/${action}`, headers: asUser() });
      expect(res.statusCode, action).toBe(409);
      expect(res.json().error, action).toMatch(/reserved by the built-in/);
    }
    expect(updates).toHaveLength(0);
    expect(app.kernel.getPlugin('domain-presets')).toBe(builtIn);

    const list = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    const entries = list.json().plugins.filter((p: { id: string }) => p.id === 'domain-presets');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'active', enabled: true, isOfficial: true, error: 'collision recorded at boot' });

    const install = await app.inject({
      method: 'POST',
      url: '/install',
      headers: asUser(),
      payload: { source: 'sandbox', target: 'notifications-dispatcher', code: 'return {};' },
    });
    expect(install.statusCode).toBe(409);
  });
});
