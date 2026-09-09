import { describe, expect, it, vi } from 'vitest';
import {
  createDynamicPlugin,
  getMarketplaceCatalog,
  installPlugin,
  MARKETPLACE_CATALOG,
  uninstallPlugin,
} from '../../src/kernel/pluginLoader.js';
import { NineDeployKernel } from '../../src/kernel/kernel.js';

// Sandbox plugins spawn a real Worker during init. The default bootstrap
// script only exists as compiled .js next to the source — unavailable under
// vitest — so substitute a Worker that reports READY as soon as the main
// side attaches a message listener.
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWorker extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);
    override on(event: string, cb: (...args: never[]) => void): this {
      super.on(event, cb as never);
      if (event === 'message') {
        queueMicrotask(() => this.emit('message', { type: 'READY', payload: {} }));
      }
      return this;
    }
  }
  return { Worker: FakeWorker, parentPort: null };
});

describe('PluginLoader', () => {
  const mockDb = {
    query: {
      installedPlugins: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      configEntries: { findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  };

  const mockConfig = {
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-at-least-32-chars-long-12345',
    dataDir: '/tmp/ninedeploy-test',
  };

  describe('getMarketplaceCatalog', () => {
    it('returns catalog items with isInstalled flag correctly calculated', () => {
      const installed = new Set(['s3-backups', 'redis-sentinel']);
      const catalog = getMarketplaceCatalog(installed);

      expect(catalog).toHaveLength(MARKETPLACE_CATALOG.length);
      const s3 = catalog.find((c) => c.id === 's3-backups');
      const slack = catalog.find((c) => c.id === 'slack-alerts');

      expect(s3?.isInstalled).toBe(true);
      expect(slack?.isInstalled).toBe(false);
    });

    // The marketplace catalog ships entries that the user can install with
    // one click. A regression here (typo in an id, missing name, malformed
    // menuItem) would break the install flow silently — the panel would
    // just refuse to load the row. Pin every entry against the same shape
    // the loader expects.
    it('every catalog entry has the shape the loader requires', () => {
      const idPattern = /^[a-z0-9-_]+$/;
      for (const entry of MARKETPLACE_CATALOG) {
        expect(entry.id, `entry ${entry.id} id`).toMatch(idPattern);
        expect(typeof entry.name, `entry ${entry.id} name`).toBe('string');
        expect(entry.name.length, `entry ${entry.id} name length`).toBeGreaterThan(0);
        expect(typeof entry.version, `entry ${entry.id} version`).toBe('string');
        // semver-ish — strict check is overkill, but it must include digits.
        expect(entry.version, `entry ${entry.id} version`).toMatch(/\d/);
        for (const item of entry.menuItems ?? []) {
          expect(item.id, `${entry.id}/${item.id} id`).toBeTruthy();
          expect(item.slot, `${entry.id}/${item.id} slot`).toBeTruthy();
          expect(item.label, `${entry.id}/${item.id} label`).toBeTruthy();
          expect(item.route, `${entry.id}/${item.id} route`).toMatch(/^\//);
        }
        for (const opt of entry.configSchema ?? []) {
          expect(opt.key, `${entry.id}/${opt.key} key`).toBeTruthy();
          expect(opt.label, `${entry.id}/${opt.key} label`).toBeTruthy();
          expect(typeof opt.isSecret, `${entry.id}/${opt.key} isSecret`).toBe('boolean');
        }
      }
    });
  });

  describe('createDynamicPlugin', () => {
    it('creates plugin from marketplace catalog', () => {
      const p = createDynamicPlugin({ source: 'marketplace', target: 's3-backups' });
      expect(p.id).toBe('s3-backups');
      expect(p.name).toBe('Amazon S3 & Cloudflare R2 Sync');
      expect(p.isOfficial).toBe(true);
    });

    it('throws when marketplace item is not found', () => {
      expect(() =>
        createDynamicPlugin({ source: 'marketplace', target: 'non-existent' }),
      ).toThrow('Marketplace plugin "non-existent" not found');
    });

    it('creates plugin from npm package name', () => {
      const p = createDynamicPlugin({
        source: 'npm',
        target: '@ninedeploy/plugin-datadog',
        name: 'Datadog Plugin',
      });
      expect(p.id).toBe('ninedeploy-plugin-datadog');
      expect(p.name).toBe('Datadog Plugin');
    });

    it('creates plugin from git repository url', () => {
      const p = createDynamicPlugin({
        source: 'git',
        target: 'https://github.com/ninedeploy/my-custom-plugin.git',
      });
      expect(p.id).toBe('my-custom-plugin');
    });

    it('creates plugin from local/custom manifest', () => {
      const p = createDynamicPlugin({
        source: 'local',
        target: 'custom-local-plugin',
        name: 'Local Plugin',
        version: '2.0.0',
        description: 'Local dev plugin',
        author: 'Dev',
      });
      expect(p.id).toBe('custom-local-plugin');
      expect(p.version).toBe('2.0.0');
    });

    it('builds a sandbox plugin that carries its code and manifest', () => {
      const p = createDynamicPlugin({
        source: 'sandbox',
        target: 'sb-1',
        name: 'My Sandbox',
        code: 'module.exports = { init() {} };',
        manifest: { menuItems: [{ label: 'X' }] },
      });
      expect(p.id).toBe('sb-1');
      // SandboxPlugin keeps the payload for the worker: an install that lost
      // its code used to register as "active" while executing nothing.
      expect((p as unknown as { code: string }).code).toBe('module.exports = { init() {} };');
      expect((p as unknown as { manifest: unknown }).manifest).toEqual({ menuItems: [{ label: 'X' }] });
    });

    it('refuses a sandbox plugin that ships no code', () => {
      expect(() => createDynamicPlugin({ source: 'sandbox', target: 'sb-empty' })).toThrow(/carries no code/);
    });
  });

  describe('installPlugin & uninstallPlugin', () => {
    // Every SHIPPED catalog entry is `implemented: false` — nothing loads
    // third-party code, so installing one would create a row that reports
    // itself active while doing nothing. The install path is therefore
    // exercised through an injected catalog: it stays covered without
    // pretending a real entry works.
    const READY_CATALOG = [
      {
        id: 'slack-alerts',
        name: 'Slack Notification Dispatcher',
        version: '1.0.0',
        description: 'test entry',
        author: 'NineDeploy Official',
        icon: 'MessageSquare',
        category: 'notifications',
        isOfficial: true,
        implemented: true,
        dependencies: [],
        configSchema: [],
        menuItems: [],
      },
    ];

    it('installs an implemented marketplace plugin into db and registers it in the kernel', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      mockDb.query.installedPlugins.findFirst.mockResolvedValue(null);

      const res = await installPlugin(
        mockDb as never,
        kernel,
        { source: 'marketplace', target: 'slack-alerts' },
        READY_CATALOG as never,
      );

      expect(res).toEqual({ ok: true, id: 'slack-alerts', status: 'active' });
      expect(kernel.getPlugin('slack-alerts')).toBeDefined();

      // Test init callback
      const dynamic = kernel.getPlugin('slack-alerts')!;
      await dynamic.init(kernel);
      if (dynamic.destroy) await dynamic.destroy(kernel);
    });

    it('rejects installation if plugin is already active in kernel', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      mockDb.query.installedPlugins.findFirst.mockResolvedValue({ id: 'slack-alerts', enabled: true });

      // Pre-register
      await kernel.registerPlugin({
        id: 'slack-alerts',
        name: 'Slack Alerts',
        version: '1.0.0',
        init: vi.fn(),
      });

      await expect(
        installPlugin(
          mockDb as never,
          kernel,
          { source: 'marketplace', target: 'slack-alerts' },
          READY_CATALOG as never,
        ),
      ).rejects.toThrow('Plugin "slack-alerts" is already installed and active');
    });

    it('uninstalls plugin and purges runtime components', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const destroySpy = vi.fn();

      await kernel.registerPlugin({
        id: 'to-remove',
        name: 'To Remove',
        version: '1.0.0',
        init: vi.fn(),
        destroy: destroySpy,
      });

      mockDb.query.installedPlugins.findFirst.mockResolvedValue({ id: 'to-remove' });

      const res = await uninstallPlugin(mockDb as never, kernel, 'to-remove');
      expect(res).toEqual({ ok: true, id: 'to-remove' });
      expect(destroySpy).toHaveBeenCalled();
    });

    it('handles uninstall error inside destroy without failing uninstall', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await kernel.registerPlugin({
        id: 'boom-plugin',
        name: 'Boom',
        version: '1.0.0',
        init: vi.fn(),
        destroy: vi.fn().mockRejectedValue(new Error('Destroy failure')),
      });

      mockDb.query.installedPlugins.findFirst.mockResolvedValue({ id: 'boom-plugin' });

      const res = await uninstallPlugin(mockDb as never, kernel, 'boom-plugin');
      expect(res.ok).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('creates plugin from git repository without slash in url', () => {
      const p = createDynamicPlugin({
        source: 'git',
        target: 'plain-git-repo',
      });
      expect(p.id).toBe('plain-git-repo');
    });

    it('installs when plugin is already present in kernel (re-enabling)', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      await kernel.registerPlugin({
        id: 'slack-alerts',
        name: 'Existing',
        version: '1.0.0',
        init: vi.fn(),
      });

      // existing in DB but enabled=false
      mockDb.query.installedPlugins.findFirst.mockResolvedValue({ id: 'slack-alerts', enabled: false });

      const res = await installPlugin(
        mockDb as never,
        kernel,
        { source: 'marketplace', target: 'slack-alerts' },
        READY_CATALOG as never,
      );
      expect(res.ok).toBe(true);
    });

    it('refuses a source this build cannot load code from', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      for (const source of ['local', 'npm', 'git'] as const) {
        await expect(
          installPlugin(mockDb as never, kernel, { source, target: 'anything' }),
        ).rejects.toThrow(/does not load third-party plugin code/);
      }
    });

    it('uninstalls plugin when plugin is in kernel without destroy method or not in kernel', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);

      // Plugin without destroy method
      await kernel.registerPlugin({
        id: 'no-destroy',
        name: 'No Destroy',
        version: '1.0.0',
        init: vi.fn(),
      });

      mockDb.query.installedPlugins.findFirst.mockResolvedValue({ id: 'no-destroy' });
      const res1 = await uninstallPlugin(mockDb as never, kernel, 'no-destroy');
      expect(res1.ok).toBe(true);

      // Plugin in DB but not loaded in kernel
      mockDb.query.installedPlugins.findFirst.mockResolvedValue({ id: 'db-only' });
      const res2 = await uninstallPlugin(mockDb as never, kernel, 'db-only');
      expect(res2.ok).toBe(true);
    });

    it('throws when uninstalling a non-installed plugin', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      mockDb.query.installedPlugins.findFirst.mockResolvedValue(null);

      await expect(uninstallPlugin(mockDb as never, kernel, 'ghost-plugin')).rejects.toThrow(
        'Plugin "ghost-plugin" is not installed',
      );
    });
  });

  describe('loadInstalledPlugins', () => {
    it('restores all enabled plugins from database and handles registration failures gracefully', async () => {
      const { loadInstalledPlugins } = await import('../../src/kernel/pluginLoader.js');
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // 1. Pre-load one plugin so it gets skipped
      await kernel.registerPlugin({
        id: 'already-loaded',
        name: 'Already Loaded',
        version: '1.0.0',
        init: () => {},
      });

      mockDb.query.installedPlugins.findMany.mockResolvedValue([
        {
          id: 'already-loaded',
          name: 'Already Loaded',
          version: '1.0.0',
          enabled: true,
          manifest: { source: 'local', target: 'already-loaded' },
        },
        {
          id: 's3-backups',
          name: 'S3 Sync',
          version: '1.1.0',
          enabled: true,
          isOfficial: true,
          manifest: {}, // triggers source: 'marketplace' and target: 's3-backups'
        },
        {
          id: 'custom-untyped',
          name: 'Custom Untyped',
          version: '1.0.0',
          description: 'Custom untyped plugin',
          author: 'Alice',
          icon: 'Sparkles',
          enabled: true,
          isOfficial: false,
          manifest: null, // triggers manifest || {} and fallback source: 'local', target: 'custom-untyped'
        },
        {
          id: 'broken-plugin',
          name: 'Broken',
          version: '1.0.0',
          enabled: true,
          manifest: { source: 'marketplace', target: 'non-existent-item' },
        },
      ]);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const count = await loadInstalledPlugins(mockDb as never, kernel);
      // Only s3-backups is restored. `custom-untyped` has no manifest, so it
      // falls back to source 'local' — a source this build cannot load code
      // from. It used to come back as a shell reporting itself active; it is
      // now skipped with a one-line warning naming the row.
      expect(count).toBe(1);
      expect(kernel.getPlugin('s3-backups')).toBeDefined();
      expect(kernel.getPlugin('custom-untyped')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('custom-untyped'));
      expect(errSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('restores a sandbox plugin WITH its persisted code and manifest', async () => {
      const { loadInstalledPlugins } = await import('../../src/kernel/pluginLoader.js');
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const code = 'module.exports = { hooks: { onDeploy() {} } };';
      mockDb.query.installedPlugins.findMany.mockResolvedValue([
        {
          id: 'sb-1',
          name: 'My Sandbox',
          version: '1.0.0',
          enabled: true,
          manifest: { source: 'sandbox', target: 'sb-1', code, sandboxManifest: { menuItems: [] } },
        },
      ]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const count = await loadInstalledPlugins(mockDb as never, kernel);

      expect(count).toBe(1);
      const restored = kernel.getPlugin('sb-1');
      expect(restored).toBeDefined();
      // The persisted payload must survive the restart: a restore that loses
      // the code re-registers an "active" plugin that executes nothing.
      expect((restored as unknown as { code: string }).code).toBe(code);
      expect((restored as unknown as { manifest: unknown }).manifest).toEqual({ menuItems: [] });
      expect(warnSpy).not.toHaveBeenCalled();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});
