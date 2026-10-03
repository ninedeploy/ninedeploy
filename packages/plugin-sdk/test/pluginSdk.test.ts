import { describe, expect, it, vi } from 'vitest';
import { definePlugin, createScopedConfig, sanitizeKey } from '../src/index.js';
import type { UnderlyingConfigCenter } from '../src/scopedConfig.js';

describe('@ninedeploy/plugin-sdk', () => {
  describe('definePlugin', () => {
    it('defines a valid plugin with all options', () => {
      const plugin = definePlugin({
        id: 'cloudflare-tunnels',
        name: 'Cloudflare Tunnels',
        version: '1.2.0',
        description: 'Zero Trust tunnels for secure routing',
        author: 'NineDeploy Team',
        icon: 'Shield',
        isOfficial: true,
        dependencies: ['traefik-proxy'],
        configSchema: [
          {
            key: 'account_id',
            type: 'string',
            isSecret: false,
            label: 'Account ID',
            category: 'network',
            tags: ['cloudflare'],
          },
        ],
        menuItems: [
          {
            id: 'cf-tunnels-nav',
            slot: 'sidebar:main',
            label: 'Cloudflare',
            route: '/tunnels',
            icon: 'Globe',
            order: 10,
            permission: 'admin',
          },
        ],
        init: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        destroy: vi.fn(),
      });

      expect(plugin.id).toBe('cloudflare-tunnels');
      expect(plugin.name).toBe('Cloudflare Tunnels');
      expect(plugin.version).toBe('1.2.0');
    });

    it('defines a minimal plugin without configSchema or menuItems', () => {
      const plugin = definePlugin({
        id: 'minimal-plugin',
        name: 'Minimal Plugin',
        version: '1.0.0',
      });

      expect(plugin.id).toBe('minimal-plugin');
      expect(plugin.configSchema).toBeUndefined();
      expect(plugin.menuItems).toBeUndefined();
    });

    it('rejects invalid plugin definitions', () => {
      expect(() => definePlugin(null as never)).toThrow('Plugin definition cannot be null or undefined');
      expect(() => definePlugin({} as never)).toThrow('Plugin ID is required and must be a non-empty string');
      expect(() => definePlugin({ id: '' } as never)).toThrow('Plugin ID is required and must be a non-empty string');
      expect(() => definePlugin({ id: 'INVALID/NAME' } as never)).toThrow('Plugin ID must only contain lowercase');
      expect(() => definePlugin({ id: 'my-plugin' } as never)).toThrow('Plugin name is required and must be a non-empty string');
      expect(() => definePlugin({ id: 'my-plugin', name: 'My Plugin' } as never)).toThrow('Plugin version is required');

      // Invalid configSchema
      expect(() =>
        definePlugin({
          id: 'my-plugin',
          name: 'My Plugin',
          version: '1.0.0',
          configSchema: [{ key: '', label: 'Label' } as never],
        }),
      ).toThrow('key is required');

      expect(() =>
        definePlugin({
          id: 'my-plugin',
          name: 'My Plugin',
          version: '1.0.0',
          configSchema: [{ key: 'api_key', label: '' } as never],
        }),
      ).toThrow('label is required');

      // Invalid menuItems
      expect(() =>
        definePlugin({
          id: 'my-plugin',
          name: 'My Plugin',
          version: '1.0.0',
          menuItems: [{ id: '' } as never],
        }),
      ).toThrow('id is required');

      expect(() =>
        definePlugin({
          id: 'my-plugin',
          name: 'My Plugin',
          version: '1.0.0',
          menuItems: [{ id: 'menu-1', slot: '' } as never],
        }),
      ).toThrow('slot is required');

      expect(() =>
        definePlugin({
          id: 'my-plugin',
          name: 'My Plugin',
          version: '1.0.0',
          menuItems: [{ id: 'menu-1', slot: 'sidebar:main', label: '' } as never],
        }),
      ).toThrow('label is required');

      expect(() =>
        definePlugin({
          id: 'my-plugin',
          name: 'My Plugin',
          version: '1.0.0',
          menuItems: [{ id: 'menu-1', slot: 'sidebar:main', label: 'Label', route: '' } as never],
        }),
      ).toThrow('route is required');
    });
  });

  describe('sanitizeKey', () => {
    it('sanitizes short keys to namespaced keys', () => {
      expect(sanitizeKey('datadog', 'api_key')).toBe('plugin:datadog:api_key');
      expect(sanitizeKey('datadog', 'plugin:datadog:api_key')).toBe('plugin:datadog:api_key');
    });

    it('rejects invalid or unsafe keys', () => {
      expect(() => sanitizeKey('datadog', '')).toThrow('Config key must be a non-empty string');
      expect(() => sanitizeKey('datadog', null as never)).toThrow('Config key must be a non-empty string');
      expect(() => sanitizeKey('datadog', '../escape')).toThrow('Path traversal is prohibited');
      expect(() => sanitizeKey('datadog', '/root/key')).toThrow('Path traversal is prohibited');
      expect(() => sanitizeKey('datadog', '\\windows\\key')).toThrow('Path traversal is prohibited');
      expect(() => sanitizeKey('datadog', 'plugin:other-plugin:secret')).toThrow('Access Denied: Plugin "datadog" cannot access namespace');
    });
  });

  describe('createScopedConfig', () => {
    it('validates pluginId presence', () => {
      expect(() => createScopedConfig('', {} as never)).toThrow('Plugin ID is required');
    });

    it('exercises get, getSecret, set and delete with proper scoping', async () => {
      const mockUnderlying: UnderlyingConfigCenter = {
        get: vi.fn().mockResolvedValue('test-val'),
        getSecret: vi.fn().mockResolvedValue('secret-val'),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const scoped = createScopedConfig('my-plugin', mockUnderlying);

      // 1. get
      const val = await scoped.get('timeout', 5000);
      expect(val).toBe('test-val');
      expect(mockUnderlying.get).toHaveBeenCalledWith('plugin:my-plugin:timeout', 5000);

      // 2. getSecret
      const secret = await scoped.getSecret('api_token');
      expect(secret).toBe('secret-val');
      expect(mockUnderlying.getSecret).toHaveBeenCalledWith('plugin:my-plugin:api_token');

      // 3. set with tags
      await scoped.set('webhook_url', 'https://example.com', {
        isSecret: false,
        description: 'Target webhook',
        tags: ['custom'],
      });
      expect(mockUnderlying.set).toHaveBeenCalledWith('plugin:my-plugin:webhook_url', 'https://example.com', {
        isSecret: false,
        description: 'Target webhook',
        tags: ['custom', 'plugin:my-plugin'],
      });

      // 4. set without tags
      await scoped.set('retries', 3);
      expect(mockUnderlying.set).toHaveBeenCalledWith('plugin:my-plugin:retries', 3, {
        isSecret: undefined,
        description: undefined,
        tags: ['plugin:my-plugin'],
      });

      // 5. delete
      await scoped.delete('old_key');
      expect(mockUnderlying.delete).toHaveBeenCalledWith('plugin:my-plugin:old_key');
    });
  });
});
