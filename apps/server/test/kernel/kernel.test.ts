import { describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../../src/kernel/index.js';
import type { KernelPlugin } from '../../src/kernel/types.js';
import { createFakeDb } from '../helpers.js';

describe('NineDeployKernel', () => {
  const mockConfig = { paths: { dataDir: '/tmp/test' } } as any;

  it('manages full lifecycle, dependencies, config and menu registrations', async () => {
    const db = createFakeDb();
    const kernel = new NineDeployKernel(db, mockConfig);
    const trace: string[] = [];

    expect(kernel.state).toBe('INIT');

    const pluginA: KernelPlugin = {
      id: 'plugin-a',
      name: 'Plugin A',
      version: '1.0.0',
      configSchema: [
        {
          key: 'a.setting',
          type: 'string',
          isSecret: false,
          label: 'Setting A',
        },
        {
          key: 'plugin:plugin-a:already_prefixed',
          type: 'string',
          isSecret: false,
          label: 'Already Prefixed',
        },
      ],
      menuItems: [
        {
          id: 'menu-a',
          slot: 'sidebar:main',
          label: 'Menu A',
          route: '/a',
        },
      ],
      init: vi.fn(async () => {
        trace.push('init-a');
      }),
      onReady: vi.fn(async () => {
        trace.push('ready-a');
      }),
      onShutdown: vi.fn(async () => {
        trace.push('shutdown-a');
      }),
    };

    const pluginB: KernelPlugin = {
      id: 'plugin-b',
      name: 'Plugin B',
      version: '1.0.0',
      dependencies: ['plugin-a'],
      init: vi.fn(async () => {
        trace.push('init-b');
      }),
      onReady: vi.fn(async () => {
        trace.push('ready-b');
      }),
      onShutdown: vi.fn(async () => {
        trace.push('shutdown-b');
      }),
    };

    const pluginC: KernelPlugin = {
      id: 'plugin-c',
      name: 'Plugin C',
      version: '1.0.0',
      dependencies: ['plugin-a'],
      init: vi.fn(async () => {
        trace.push('init-c');
      }),
      onReady: vi.fn(async () => {
        trace.push('ready-c');
      }),
    };

    // Plugin without onReady or onShutdown
    const pluginBare: KernelPlugin = {
      id: 'bare',
      name: 'Bare',
      version: '1.0.0',
      init: () => {},
    };

    await kernel.registerPlugin(pluginA);
    await kernel.registerPlugin(pluginB);
    await kernel.registerPlugin(pluginC);
    await kernel.registerPlugin(pluginBare);

    // Verify config and menu were auto-registered
    expect(kernel.configCenter.getDefinition('plugin:plugin-a:a.setting')).toBeDefined();
    expect(kernel.configCenter.getDefinition('plugin:plugin-a:already_prefixed')).toBeDefined();
    expect(kernel.menuRegistry.getAllItems()).toHaveLength(1);

    expect(kernel.getPlugin('plugin-a')).toBe(pluginA);
    expect(kernel.getPlugin('nonexistent')).toBeUndefined();
    expect(kernel.listPlugins()).toHaveLength(4);

    // Test hook execution through kernel context
    kernel.hooks.tap('deploy:before', async (payload, ctx) => {
      expect(ctx).toBe(kernel);
      return payload;
    });
    await kernel.hooks.call('deploy:before', { service: { id: 1 } as any });

    // Boot kernel
    await kernel.boot();
    expect(kernel.state).toBe('READY');
    expect(trace).toEqual(['init-a', 'init-b', 'init-c', 'ready-a', 'ready-b', 'ready-c']);

    // Shutdown kernel
    await kernel.shutdown();
    expect(kernel.state).toBe('TERMINATED');
    expect(trace).toEqual(['init-a', 'init-b', 'init-c', 'ready-a', 'ready-b', 'ready-c', 'shutdown-b', 'shutdown-a']);

    // Second shutdown is a no-op
    await kernel.shutdown();
  });

  it('rejects duplicate plugin registrations', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const p: KernelPlugin = { id: 'dup', name: 'Dup', version: '1.0.0', init: () => {} };

    await kernel.registerPlugin(p);
    await expect(kernel.registerPlugin(p)).rejects.toThrow('Plugin "dup" is already registered');
  });

  it('handles plugin init failures', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const bad: KernelPlugin = {
      id: 'bad',
      name: 'Bad',
      version: '1.0.0',
      init: () => {
        throw new Error('Init crash');
      },
    };

    await expect(kernel.registerPlugin(bad)).rejects.toThrow('Failed to initialize plugin "bad": Init crash');
  });

  it('r235: a plugin whose init failed is fully unregistered and can be installed again', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const destroy = vi.fn();
    let attempts = 0;
    const flaky: KernelPlugin = {
      id: 'flaky',
      name: 'Flaky',
      version: '1.0.0',
      menuItems: [{ id: 'flaky-menu', slot: 'sidebar:main', label: 'Flaky', route: '/flaky' } as never],
      init: () => {
        if (++attempts === 1) throw new Error('timed out');
      },
      destroy,
    };
    await expect(kernel.registerPlugin(flaky)).rejects.toThrow(/timed out/);
    expect(kernel.getPlugin('flaky')).toBeUndefined();
    expect(kernel.menuRegistry.getAllItems()).toHaveLength(0);
    expect(destroy).toHaveBeenCalledTimes(1);
    // The retry is not refused as "already registered".
    await expect(kernel.registerPlugin(flaky)).resolves.toBeUndefined();
    expect(kernel.getPlugin('flaky')).toBeDefined();
  });

  it('detects circular dependencies and missing dependencies', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const p1: KernelPlugin = { id: 'p1', name: 'P1', version: '1.0.0', dependencies: ['missing-dep'], init: () => {} };

    // r236: a broken plugin is skipped — it no longer aborts the whole boot.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const healthyReady = vi.fn();
    const healthy: KernelPlugin = { id: 'ok', name: 'OK', version: '1.0.0', init: () => {}, onReady: healthyReady };
    const p1Ready = vi.fn();
    p1.onReady = p1Ready;
    await kernel.registerPlugin(p1);
    await kernel.registerPlugin(healthy);
    await kernel.boot();
    expect(kernel.state).toBe('READY');
    expect(healthyReady).toHaveBeenCalledTimes(1);
    expect(p1Ready).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping plugin "p1"'), expect.stringContaining('missing dependency "missing-dep"'));

    const kernel2 = new NineDeployKernel(createFakeDb(), mockConfig);
    const c1Ready = vi.fn();
    const c1: KernelPlugin = { id: 'c1', name: 'C1', version: '1.0.0', dependencies: ['c2'], init: () => {}, onReady: c1Ready };
    const c2: KernelPlugin = { id: 'c2', name: 'C2', version: '1.0.0', dependencies: ['c1'], init: () => {} };
    const dependentReady = vi.fn();
    const dependent: KernelPlugin = { id: 'd', name: 'D', version: '1.0.0', dependencies: ['c1'], init: () => {}, onReady: dependentReady };

    await kernel2.registerPlugin(c1);
    await kernel2.registerPlugin(c2);
    await kernel2.registerPlugin(dependent);
    await kernel2.boot();
    expect(kernel2.state).toBe('READY');
    expect(c1Ready).not.toHaveBeenCalled();
    expect(dependentReady).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping plugin'), expect.stringMatching(/Circular dependency/));
    errorSpy.mockRestore();
  });

  it('prevents booting twice and handles onReady/onShutdown errors', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const errPlugin: KernelPlugin = {
      id: 'err-plugin',
      name: 'Err',
      version: '1.0.0',
      init: () => {},
      onReady: () => {
        throw new Error('Ready boom');
      },
      onShutdown: () => {
        throw new Error('Shutdown boom');
      },
    };

    await kernel.registerPlugin(errPlugin);
    await kernel.boot();
    expect(kernel.state).toBe('READY');

    await expect(kernel.boot()).rejects.toThrow('Cannot boot kernel from state "READY"');

    await kernel.shutdown();
    expect(kernel.state).toBe('TERMINATED');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('unregisters plugin cleanly, handles destroy errors and missing plugins', async () => {
    const db = createFakeDb();
    const kernel = new NineDeployKernel(db, mockConfig);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Unregister non-existent
    const resFalse = await kernel.unregisterPlugin('ghost');
    expect(resFalse).toBe(false);

    // Register a plugin with menu, config and destroy
    const destroySpy = vi.fn();
    const goodPlugin: KernelPlugin = {
      id: 'good-plugin',
      name: 'Good',
      version: '1.0.0',
      menuItems: [{ id: 'm-good', slot: 'sidebar:main', label: 'Good', route: '/good' }],
      configSchema: [{ key: 'g.val', type: 'string', isSecret: false, label: 'G Val' }],
      init: () => {},
      destroy: destroySpy,
    };
    await kernel.registerPlugin(goodPlugin);
    expect(kernel.getPlugin('good-plugin')).toBeDefined();
    expect(kernel.menuRegistry.getAllItems()).toHaveLength(1);

    const resTrue = await kernel.unregisterPlugin('good-plugin');
    expect(resTrue).toBe(true);
    expect(destroySpy).toHaveBeenCalled();
    expect(kernel.getPlugin('good-plugin')).toBeUndefined();
    expect(kernel.menuRegistry.getAllItems()).toHaveLength(0);

    // Register a plugin whose destroy throws
    const throwingPlugin: KernelPlugin = {
      id: 'throw-plugin',
      name: 'Throw',
      version: '1.0.0',
      init: () => {},
      destroy: () => {
        throw new Error('Destroy crash');
      },
    };
    await kernel.registerPlugin(throwingPlugin);
    const resThrow = await kernel.unregisterPlugin('throw-plugin');
    expect(resThrow).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('triggers rollback in reverse order when a subsequent hook handler errors or vetos', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const rollbackTrace: string[] = [];

    // Step 1: creates side-effect resource
    kernel.hooks.tap(
      'deploy:before',
      async (payload) => {
        return payload;
      },
      {
        id: 'step-1',
        priority: 200,
        rollback: async (_payload, _ctx, error) => {
          rollbackTrace.push(`rollback-1:${error?.message}`);
        },
      },
    );

    // Step 2: creates another resource
    kernel.hooks.tap(
      'deploy:before',
      async (payload) => {
        return payload;
      },
      {
        id: 'step-2',
        priority: 150,
        rollback: async () => {
          rollbackTrace.push('rollback-2');
        },
      },
    );

    // Step 3: fails with an exception
    kernel.hooks.tap(
      'deploy:before',
      async () => {
        throw new Error('Pipeline exploded at step 3');
      },
      {
        id: 'step-3',
        priority: 100,
      },
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await kernel.hooks.call('deploy:before', { service: { id: 42 } as any });

    // Rollback should run in reverse (LIFO): step 2 first, then step 1
    expect(rollbackTrace).toEqual(['rollback-2', 'rollback-1:Pipeline exploded at step 3']);
    errSpy.mockRestore();
  });

  it('triggers rollback when a hook handler aborts via allowOrAbort veto', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const rollbackTrace: string[] = [];

    kernel.hooks.tap(
      'database:before_delete',
      async (payload) => {
        return payload;
      },
      {
        priority: 200,
        rollback: async (_payload, _ctx, error) => {
          rollbackTrace.push(`rb-db-1:${error?.message}`);
        },
      },
    );

    // Handler that vetoes the deletion
    kernel.hooks.tap(
      'database:before_delete',
      async (payload) => {
        return { ...payload, allowOrAbort: false, reason: 'Production protected' };
      },
      {
        priority: 100,
      },
    );

    const result = await kernel.hooks.call('database:before_delete', {
      database: { id: 1 } as any,
      allowOrAbort: true,
    });

    expect(result.allowOrAbort).toBe(false);
    expect(result.reason).toBe('Production protected');
    expect(rollbackTrace).toHaveLength(1);
    expect(rollbackTrace[0]).toContain('Operation vetoed');
  });
});
