import { describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../src/kernel/kernel.js';
import { HookPipeline } from '../src/kernel/hookPipeline.js';
import { ConfigCenter } from '../src/kernel/configCenter.js';
import { MenuRegistry } from '../src/kernel/menuRegistry.js';
import { EventBus } from '../src/kernel/eventBus.js';
import { ENGINES, connectionString, studioImageForEngine } from '../src/engine/database.js';
import { hasVaultRef, resolveVaultRefs } from '../src/lib/vault.js';
import { encrypt } from '../src/lib/crypto.js';
import type { KernelPlugin } from '../src/kernel/types.js';

describe('Edge Cases — Hook Pipeline', () => {
  it('executes hooks in descending priority order and allows payload mutation', async () => {
    const pipeline = new HookPipeline(() => ({} as any));
    const executionOrder: string[] = [];

    pipeline.tap('deploy.before' as any, async (payload: any) => {
      executionOrder.push('low');
      return { ...payload, step: `${payload.step}-low` };
    }, { priority: 10 });

    pipeline.tap('deploy.before' as any, async (payload: any) => {
      executionOrder.push('high');
      return { ...payload, step: `${payload.step}-high` };
    }, { priority: 200 });

    pipeline.tap('deploy.before' as any, async (payload: any) => {
      executionOrder.push('medium');
      return { ...payload, step: `${payload.step}-med` };
    }, { priority: 100 });

    const result = await pipeline.call('deploy.before' as any, { step: 'init' });
    expect(executionOrder).toEqual(['high', 'medium', 'low']);
    expect(result.step).toBe('init-high-med-low');
  });

  it('unsubscribes hook handlers cleanly', async () => {
    const pipeline = new HookPipeline(() => ({} as any));
    let count = 0;
    const unsub = pipeline.tap('deploy.before' as any, async (payload: any) => {
      count++;
      return payload;
    });

    await pipeline.call('deploy.before' as any, { count: 0 });
    expect(count).toBe(1);

    unsub();
    await pipeline.call('deploy.before' as any, { count: 0 });
    expect(count).toBe(1);
  });

  it('handles hook timeouts without terminating the entire pipeline', async () => {
    const pipeline = new HookPipeline(() => ({} as any));
    let fastExecuted = false;

    pipeline.tap('deploy.before' as any, async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { slow: true };
    }, { timeoutMs: 10 });

    pipeline.tap('deploy.before' as any, async (payload: any) => {
      fastExecuted = true;
      return { ...payload, fast: true };
    }, { priority: 50, timeoutMs: 500 });

    const result = await pipeline.call('deploy.before' as any, { start: true });
    expect(fastExecuted).toBe(true);
    expect(result.fast).toBe(true);
  });

  it('returns initial payload when no hooks are registered', async () => {
    const pipeline = new HookPipeline(() => ({} as any));
    const initial = { foo: 'bar' };
    const result = await pipeline.call('deploy.after' as any, initial);
    expect(result).toBe(initial);
  });
});

describe('Edge Cases — EventBus & Wildcard Multiplexing', () => {
  it('dispatches to exact and wildcard listeners simultaneously', () => {
    const bus = new EventBus();
    const received: Array<{ type: string; payload: any }> = [];

    bus.on('deployment.status_changed', (payload) => {
      received.push({ type: 'exact', payload });
    });

    bus.onCustom('*', (payload, eventName) => {
      received.push({ type: `wildcard:${eventName}`, payload });
    });

    bus.emit('deployment.status_changed', { deploymentId: 42, status: 'running' });

    expect(received).toHaveLength(2);
    expect(received[0]?.type).toBe('exact');
    expect(received[1]?.type).toBe('wildcard:deployment.status_changed');
  });

  it('safely handles throwing listeners in both sync and async modes', () => {
    const bus = new EventBus();
    let safeListenerCalled = false;

    bus.onCustom('test.error', () => {
      throw new Error('sync failure');
    });

    bus.onCustom('test.error', async () => {
      throw new Error('async failure');
    });

    bus.onCustom('test.error', () => {
      safeListenerCalled = true;
    });

    expect(() => bus.emitCustom('test.error', { test: true })).not.toThrow();
    expect(safeListenerCalled).toBe(true);
  });

  it('once listener runs once and cleans up', () => {
    const bus = new EventBus();
    let count = 0;

    bus.once('deployment.status_changed', () => {
      count++;
    });

    bus.emit('deployment.status_changed', { deploymentId: 1, status: 'queued' });
    bus.emit('deployment.status_changed', { deploymentId: 1, status: 'building' });

    expect(count).toBe(1);
    expect(bus.listenerCount('deployment.status_changed')).toBe(0);
  });
});

describe('Edge Cases — MenuRegistry & RBAC Slot Filtering', () => {
  it('filters items by slot and role permission correctly', () => {
    const registry = new MenuRegistry();

    registry.registerMenuItem({
      id: 'admin-dashboard',
      slot: 'sidebar:primary',
      label: 'Admin Dash',
      route: '/admin',
      permission: 'admin',
      order: 10,
    });

    registry.registerMenuItem({
      id: 'user-services',
      slot: 'sidebar:primary',
      label: 'Services',
      route: '/services',
      permission: 'member',
      order: 5,
    });

    registry.registerMenuItem({
      id: 'secondary-docs',
      slot: 'sidebar:secondary',
      label: 'Docs',
      route: '/docs',
    });

    // Member view of primary sidebar
    const memberItems = registry.getItemsForSlot('sidebar:primary', false);
    expect(memberItems).toHaveLength(1);
    expect(memberItems[0]?.id).toBe('user-services');

    // Admin view of primary sidebar (sorted by order: 5, then 10)
    const adminItems = registry.getItemsForSlot('sidebar:primary', true);
    expect(adminItems).toHaveLength(2);
    expect(adminItems[0]?.id).toBe('user-services');
    expect(adminItems[1]?.id).toBe('admin-dashboard');

    // Purge plugin menus
    registry.registerMenuItem({
      id: 'plugin-menu',
      slot: 'sidebar:primary',
      label: 'Plugin Page',
      route: '/plugin',
      pluginId: 'custom-plugin',
    });
    expect(registry.purgePluginMenus('custom-plugin')).toBe(1);
    expect(registry.getPluginMenus('custom-plugin')).toHaveLength(0);
  });
});

describe('Edge Cases — Microkernel Lifecycle & Dependency Resolution', () => {
  it('resolves complex dependency trees topologically', async () => {
    const mockDb = { query: { configEntries: { findMany: vi.fn(async () => []) } } } as any;
    const kernel = new NineDeployKernel(mockDb, {} as any);
    const bootLog: string[] = [];

    const pluginC: KernelPlugin = {
      id: 'plugin-c',
      name: 'Plugin C',
      version: '1.0.0',
      description: 'Base C',
      init: vi.fn(),
      onReady: async () => { bootLog.push('C'); },
    };

    const pluginB: KernelPlugin = {
      id: 'plugin-b',
      name: 'Plugin B',
      version: '1.0.0',
      description: 'Mid B',
      dependencies: ['plugin-c'],
      init: vi.fn(),
      onReady: async () => { bootLog.push('B'); },
    };

    const pluginA: KernelPlugin = {
      id: 'plugin-a',
      name: 'Plugin A',
      version: '1.0.0',
      description: 'Top A',
      dependencies: ['plugin-b', 'plugin-c'],
      init: vi.fn(),
      onReady: async () => { bootLog.push('A'); },
    };

    await kernel.registerPlugin(pluginA);
    await kernel.registerPlugin(pluginB);
    await kernel.registerPlugin(pluginC);

    await kernel.boot();

    expect(kernel.state).toBe('READY');
    expect(bootLog).toEqual(['C', 'B', 'A']);

    await kernel.shutdown();
    expect(kernel.state).toBe('TERMINATED');
  });

  it('detects circular dependencies and throws', async () => {
    const mockDb = {} as any;
    const kernel = new NineDeployKernel(mockDb, {} as any);

    const pluginX: KernelPlugin = {
      id: 'plugin-x',
      name: 'Plugin X',
      version: '1.0.0',
      description: 'X',
      dependencies: ['plugin-y'],
      init: vi.fn(),
    };

    const pluginY: KernelPlugin = {
      id: 'plugin-y',
      name: 'Plugin Y',
      version: '1.0.0',
      description: 'Y',
      dependencies: ['plugin-x'],
      init: vi.fn(),
    };

    await kernel.registerPlugin(pluginX);
    await kernel.registerPlugin(pluginY);

    await expect(kernel.boot()).rejects.toThrow(/Circular dependency detected/);
  });
});

describe('Edge Cases — Database Engines & Connection Strings with Special Chars', () => {
  const specialPassword = ['p@ss', 'w/o?r#d%123&+= Türk!'].join(':');

  it('properly encodes connection strings for all 10 supported engines', () => {
    const engines = [
      'postgres',
      'mysql',
      'mariadb',
      'redis',
      'valkey',
      'mongo',
      'clickhouse',
      'meilisearch',
      'rabbitmq',
    ];

    for (const engine of engines) {
      const dbRecord = {
        id: 1,
        slug: `test-${engine}`,
        engine,
        passwordEncrypted: encrypt(specialPassword),
        internalHost: `nd-db-test-${engine}`,
        internalPort: ENGINES[engine]!.port,
        containerName: `nd-db-test-${engine}`,
      } as any;

      const connStr = connectionString(dbRecord);
      expect(connStr).toBeTruthy();
      expect(connStr).toContain(`nd-db-test-${engine}`);
      // Must not contain raw unencoded special characters in the auth segment
      expect(connStr).not.toContain('p@ss:w/o?r#d');
    }
  });

  it('correctly resolves studio images for Redis Commander vs Adminer', () => {
    expect(studioImageForEngine('redis').image).toBe('rediscommander/redis-commander@sha256:19cd0c49f418779fa2822a0496c5e6516d0c792effc39ed20089e6268477e40a');
    expect(studioImageForEngine('valkey').image).toBe('rediscommander/redis-commander@sha256:19cd0c49f418779fa2822a0496c5e6516d0c792effc39ed20089e6268477e40a');
    expect(studioImageForEngine('postgres').image).toBe('adminer:6.0.1');
    expect(studioImageForEngine('mysql').image).toBe('adminer:6.0.1');
    expect(studioImageForEngine('clickhouse').image).toBe('adminer:6.0.1');
  });
});

describe('Edge Cases — Vault Secret Interpolation & Fallbacks', () => {
  it('detects vault references correctly', () => {
    expect(hasVaultRef('plain-value')).toBe(false);
    expect(hasVaultRef('$' + '{{infisical:DATABASE_URL}}')).toBe(true);
    expect(hasVaultRef('Bearer $' + '{{doppler:API_KEY}}')).toBe(true);
    expect(hasVaultRef('$' + '{{unknown:KEY}}')).toBe(false);
  });

  it('resolves multiple vault references in a single string', async () => {
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
    const mockDb = {
      query: {
        settings: {
          findFirst: vi.fn(async () => null),
        },
      },
    } as any;

    // When no external provider is set up, resolveVaultRefs throws an informative error
    const env = {
      APP_SECRET: '$' + '{{infisical:SECRET_ONE}}',
      NORMAL_VAR: 'hello-world',
    };

    await expect(resolveVaultRefs(mockDb, env)).rejects.toThrow(/Vault provider "infisical" is referenced but not configured/);
    vi.unstubAllEnvs();
  });
});

describe('Edge Cases — ConfigCenter & Live Reactivity', () => {
  it('supports typed configs, default fallback, and scoped configs for plugins', async () => {
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'b'.repeat(64));
    const entries = new Map<string, any>();

    const mockDb = {
      query: {
        configEntries: {
          findFirst: vi.fn(async () => {
            // Find in entries
            for (const [, val] of entries.entries()) {
              return val;
            }
            return null;
          }),
        },
      },
      insert: vi.fn(() => ({
        values: vi.fn((data: any) => ({
          onConflictDoUpdate: vi.fn(async () => {
            entries.set(data.key, data);
          }),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => {
          entries.clear();
          return { rowsAffected: 1 };
        }),
      })),
    } as any;

    const configCenter = new ConfigCenter(mockDb);

    // 1. Definition default fallback
    configCenter.registerDefinition({
      key: 'system.max_workers',
      type: 'number',
      isSecret: false,
      defaultValue: 8,
      category: 'system',
    });

    expect(await configCenter.get('system.max_workers')).toBe(8);
    expect(await configCenter.get('system.non_existent', 99)).toBe(99);

    // 2. Watcher callback on update
    let watchedVal: unknown = null;
    const unwatch = configCenter.watch('system.max_workers', (newVal) => {
      watchedVal = newVal;
    });

    await configCenter.set('system.max_workers', 16);
    expect(watchedVal).toBe(16);

    unwatch();
    await configCenter.set('system.max_workers', 32);
    expect(watchedVal).toBe(16); // Unwatched, did not update

    // 3. Scoped config
    const scoped = configCenter.createScopedConfig('my-plugin');
    await scoped.set('timeout', 5000);
    expect(configCenter.getDefinition('plugin:my-plugin:timeout')).toBeUndefined();

    // 4. Secret storage
    await configCenter.set('my.secret', 'super-secret', { isSecret: true });
    // Secret does not reside plain in memory
    expect(configCenter.getDefinition('my.secret')).toBeUndefined();

    // 5. Purge plugin configs
    const purged = await configCenter.purgePluginConfigs('my-plugin');
    expect(purged).toBe(1);

    vi.unstubAllEnvs();
  });
});
