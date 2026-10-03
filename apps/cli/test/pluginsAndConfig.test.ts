import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NineDeployClient } from '@ninedeploy/sdk';
import {
  pluginsDisable,
  pluginsEnable,
  pluginsInstall,
  pluginsList,
  pluginsMarketplace,
  pluginsUninstall,
  pluginsInspect,
  pluginsReload,
} from '../src/commands/plugins.js';
import {
  configCenterDelete,
  configCenterGet,
  configCenterList,
  configCenterSet,
} from '../src/commands/configCenter.js';

describe('CLI plugins & configCenter commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  const fakeClient = {
    plugins: {
      list: vi.fn(),
      marketplace: vi.fn(),
      install: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      reload: vi.fn(),
      inspect: vi.fn(),
      uninstall: vi.fn(),
    },
    config: {
      list: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as NineDeployClient;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('plugins', () => {
    it('pluginsList handles empty and populated lists', async () => {
      vi.mocked(fakeClient.plugins.list).mockResolvedValueOnce({ plugins: [] });
      await pluginsList(fakeClient);
      expect(logSpy).toHaveBeenCalledWith('  No plugins installed.');

      vi.mocked(fakeClient.plugins.list).mockResolvedValueOnce({
        plugins: [
          {
            id: 'traefik',
            name: 'Traefik',
            version: '1.0.0',
            isOfficial: true,
            status: 'active',
            enabled: true,
          } as any,
          {
            id: 'custom',
            name: 'Custom',
            version: '2.0.0',
            isOfficial: false,
            status: 'disabled',
            enabled: false,
          } as any,
        ],
      });
      await pluginsList(fakeClient);
      expect(logSpy).toHaveBeenCalled();
    });

    it('pluginsMarketplace handles empty and populated catalog', async () => {
      vi.mocked(fakeClient.plugins.marketplace).mockResolvedValueOnce({ catalog: [] });
      await pluginsMarketplace(fakeClient);
      expect(logSpy).toHaveBeenCalledWith('  Marketplace catalog is currently empty.');

      vi.mocked(fakeClient.plugins.marketplace).mockResolvedValueOnce({
        catalog: [
          {
            id: 's3-backups',
            name: 'S3 Sync',
            category: 'storage',
            version: '1.0.0',
            isOfficial: true,
            isInstalled: true,
            description: 'Backup sync',
            author: 'NineDeploy',
          },
          {
            id: 'discord',
            name: 'Discord Alerts',
            category: 'notifications',
            version: '1.0.0',
            isOfficial: false,
            isInstalled: false,
            description: 'Discord bot',
            author: 'Community',
          },
        ],
      });
      await pluginsMarketplace(fakeClient);
      expect(logSpy).toHaveBeenCalled();
    });

    it('pluginsInstall calls install with default and custom options', async () => {
      vi.mocked(fakeClient.plugins.install).mockResolvedValue({
        ok: true,
        id: 's3-backups',
        status: 'active',
      });

      await pluginsInstall(fakeClient, 's3-backups', {});
      expect(fakeClient.plugins.install).toHaveBeenCalledWith({
        source: 'marketplace',
        target: 's3-backups',
        name: undefined,
        version: undefined,
        description: undefined,
      });
      expect(logSpy).toHaveBeenCalledWith('  ✓ Installed plugin "s3-backups" (status: active).');

      await pluginsInstall(fakeClient, '@ninedeploy/plugin-datadog', {
        source: 'npm',
        name: 'Datadog',
        version: '2.0.0',
        desc: 'APM monitoring',
      });
      expect(fakeClient.plugins.install).toHaveBeenCalledWith({
        source: 'npm',
        target: '@ninedeploy/plugin-datadog',
        name: 'Datadog',
        version: '2.0.0',
        description: 'APM monitoring',
      });
    });

    it('pluginsEnable, pluginsDisable, and pluginsUninstall call corresponding methods', async () => {
      vi.mocked(fakeClient.plugins.enable).mockResolvedValue({ ok: true, id: 's3-backups', status: 'active' });
      vi.mocked(fakeClient.plugins.disable).mockResolvedValue({ ok: true, id: 's3-backups', status: 'disabled' });
      vi.mocked(fakeClient.plugins.uninstall).mockResolvedValue({ ok: true, id: 's3-backups' });

      await pluginsEnable(fakeClient, 's3-backups');
      expect(fakeClient.plugins.enable).toHaveBeenCalledWith('s3-backups');
      expect(logSpy).toHaveBeenCalledWith('  ✓ Plugin "s3-backups" enabled.');

      await pluginsDisable(fakeClient, 's3-backups');
      expect(fakeClient.plugins.disable).toHaveBeenCalledWith('s3-backups');
      expect(logSpy).toHaveBeenCalledWith('  ✓ Plugin "s3-backups" disabled.');

      await pluginsUninstall(fakeClient, 's3-backups');
      expect(fakeClient.plugins.uninstall).toHaveBeenCalledWith('s3-backups');
      expect(logSpy).toHaveBeenCalledWith('  ✓ Plugin "s3-backups" uninstalled.');
    });

    it('pluginsInspect prints plugin details and handles errors/empty arrays', async () => {
      vi.mocked(fakeClient.plugins.inspect).mockResolvedValueOnce({
        id: 's3-backups',
        name: 'S3 Sync',
        version: '1.0.0',
        isOfficial: true,
        enabled: true,
        status: 'active',
        author: 'NineDeploy',
        description: 'Sync files to S3',
        dependencies: ['core-storage'],
        hooks: ['deploy.completed'],
        services: ['worker'],
        configSchema: [{ key: 'bucket' }],
        menus: [{ id: 's3-menu', label: 'S3', route: '/s3', slot: 'sidebar:main' }],
        error: 'Network failure on sync',
        runtimeStats: { eventsHandled: 15, uptimeSeconds: 1200 },
      });

      await pluginsInspect(fakeClient, 's3-backups');
      expect(fakeClient.plugins.inspect).toHaveBeenCalledWith('s3-backups');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('S3 Sync (s3-backups)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));

      // Test with empty/null optional fields
      vi.mocked(fakeClient.plugins.inspect).mockResolvedValueOnce({
        id: 'minimal',
        name: 'Minimal',
        version: '0.1.0',
        isOfficial: false,
        enabled: false,
        status: 'disabled',
        author: undefined,
        description: undefined,
        dependencies: [],
        hooks: [],
        services: [],
        configSchema: [],
        menus: [],
        error: null,
        runtimeStats: { eventsHandled: 0, uptimeSeconds: 0 },
      });

      await pluginsInspect(fakeClient, 'minimal');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Author:       N/A'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Dependencies: none'));
    });

    it('pluginsReload hot-reloads plugin and prints status', async () => {
      vi.mocked(fakeClient.plugins.reload).mockResolvedValue({ ok: true, id: 's3-backups', status: 'active' });
      await pluginsReload(fakeClient, 's3-backups');
      expect(fakeClient.plugins.reload).toHaveBeenCalledWith('s3-backups');
      expect(logSpy).toHaveBeenCalledWith('  ✓ Plugin "s3-backups" reloaded (status: active).');
    });
  });

  describe('configCenter', () => {
    it('configCenterList handles empty and populated lists', async () => {
      vi.mocked(fakeClient.config.list).mockResolvedValueOnce({ entries: [] });
      await configCenterList(fakeClient, {});
      expect(logSpy).toHaveBeenCalledWith('  No configuration entries found.');

      vi.mocked(fakeClient.config.list).mockResolvedValueOnce({
        entries: [
          {
            key: 'system.site_name',
            category: 'general',
            type: 'string',
            isSecret: false,
            value: 'NineDeploy',
            isConfigured: true,
            label: 'Site Name',
            tags: ['branding'],
          },
          {
            key: 'plugin:smtp:password',
            category: 'plugin:smtp',
            type: 'string',
            isSecret: true,
            value: null,
            isConfigured: false,
            label: 'SMTP Password',
            tags: [],
          },
        ],
      });
      await configCenterList(fakeClient, { category: 'general', reveal: true });
      expect(fakeClient.config.list).toHaveBeenCalledWith({
        category: 'general',
        pluginId: undefined,
        reveal: true,
      });
      expect(logSpy).toHaveBeenCalled();
    });

    it('configCenterGet displays detailed config key information', async () => {
      vi.mocked(fakeClient.config.get).mockResolvedValue({
        key: 'system.site_name',
        label: 'Site Name',
        category: 'general',
        type: 'string',
        isSecret: true,
        value: 'NineDeploy',
        isConfigured: true,
        description: 'Brand site name',
        tags: ['branding', 'ui'],
      });

      await configCenterGet(fakeClient, 'system.site_name');
      expect(fakeClient.config.get).toHaveBeenCalledWith('system.site_name');
      expect(logSpy).toHaveBeenCalled();

      // Without description and empty tags
      vi.mocked(fakeClient.config.get).mockResolvedValue({
        key: 'system.node_name',
        label: 'Node Name',
        category: 'general',
        type: 'string',
        isSecret: false,
        value: null,
        isConfigured: false,
        tags: [],
      });
      await configCenterGet(fakeClient, 'system.node_name');
    });

    it('configCenterSet parses boolean, number and string values and tags', async () => {
      vi.mocked(fakeClient.config.set).mockResolvedValue({ ok: true, key: 'k1' });

      // String value
      await configCenterSet(fakeClient, 'k1', 'hello', { desc: 'Greeting', tags: 'tag1, tag2' });
      expect(fakeClient.config.set).toHaveBeenCalledWith('k1', {
        value: 'hello',
        isSecret: undefined,
        description: 'Greeting',
        tags: ['tag1', 'tag2'],
      });

      // Boolean true
      await configCenterSet(fakeClient, 'k2', 'true', { secret: true });
      expect(fakeClient.config.set).toHaveBeenCalledWith('k2', {
        value: true,
        isSecret: true,
        description: undefined,
        tags: undefined,
      });

      // Boolean false
      await configCenterSet(fakeClient, 'k3', 'false', {});
      expect(fakeClient.config.set).toHaveBeenCalledWith('k3', {
        value: false,
        isSecret: undefined,
        description: undefined,
        tags: undefined,
      });

      // Number
      await configCenterSet(fakeClient, 'k4', '4096', {});
      expect(fakeClient.config.set).toHaveBeenCalledWith('k4', {
        value: 4096,
        isSecret: undefined,
        description: undefined,
        tags: undefined,
      });

      // Empty string
      await configCenterSet(fakeClient, 'k5', '', {});
      expect(fakeClient.config.set).toHaveBeenCalledWith('k5', {
        value: '',
        isSecret: undefined,
        description: undefined,
        tags: undefined,
      });
    });

    it('configCenterDelete deletes configuration key', async () => {
      vi.mocked(fakeClient.config.delete).mockResolvedValue({ ok: true, key: 'custom.key' });
      await configCenterDelete(fakeClient, 'custom.key');
      expect(fakeClient.config.delete).toHaveBeenCalledWith('custom.key');
      expect(logSpy).toHaveBeenCalledWith('  ✓ Configuration key "custom.key" deleted.');
    });
  });
});
