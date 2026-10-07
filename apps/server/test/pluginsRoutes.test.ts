import { describe, expect, it, vi } from 'vitest';
import { pluginRoutes } from '../src/modules/plugins.js';
import { asUser, buildTestApp, createFakeDb, trackStatusUpdates } from './helpers.js';

describe('Plugins HTTP API', () => {
  it('lists plugins and allows enabling/disabling with admin authorization', async () => {
    const pluginStore = new Map<string, any>();
    const fakeDb = createFakeDb({
      findFirst: {
        installedPlugins: ((args: any) => {
          const chunks = args?.where?.queryChunks;
          if (Array.isArray(chunks)) {
            for (const chunk of chunks) {
              if (chunk && typeof chunk === 'object' && 'value' in chunk && typeof chunk.value === 'string') {
                if (pluginStore.has(chunk.value)) return pluginStore.get(chunk.value);
              }
            }
          }
          for (const [k, v] of pluginStore.entries()) {
            if (args?.where?.value === k || args?.where?.right?.value === k) return v;
          }
          return undefined;
        }) as any,
      },
      findMany: {
        installedPlugins: (() => Array.from(pluginStore.values())) as any,
      },
      insert: {
        installed_plugins: ((val: any) => {
          const row = { ...val, installedAt: new Date(), updatedAt: new Date() };
          pluginStore.set(val.id, row);
          return [row];
        }) as any,
      },
      update: {
        installed_plugins: ((val: any) => {
          if (val.id && pluginStore.has(val.id)) {
            pluginStore.set(val.id, { ...pluginStore.get(val.id), ...val, updatedAt: new Date() });
          } else if (pluginStore.has('test-notifier')) {
            pluginStore.set('test-notifier', { ...pluginStore.get('test-notifier'), ...val, updatedAt: new Date() });
          }
          return [val];
        }) as any,
      },
    });

    const app = await buildTestApp({ db: fakeDb });
    await app.register(pluginRoutes);

    // Register a plugin in the kernel
    await app.kernel.registerPlugin({
      id: 'test-notifier',
      name: 'Test Notifier',
      version: '1.2.0',
      description: 'Sends alerts',
      init: () => {},
    });

    await app.kernel.registerPlugin({
      id: 'kernel-only-addon',
      name: 'Kernel Only Addon',
      version: '1.0.0',
      description: 'Kernel only',
      init: () => {},
    });

    await app.kernel.registerPlugin({
      id: 'active-in-db',
      name: 'Active In DB',
      version: '1.0.0',
      description: 'Full Plugin',
      configSchema: [{ key: 'k1', type: 'string', isSecret: false, label: 'L1' }],
      menuItems: [
        {
          id: 'active-menu',
          slot: 'sidebar:main',
          label: 'Active Plugin',
          route: '/plugins/active',
        },
      ],
      dependencies: ['test-notifier'],
      init: () => {},
    });

    pluginStore.set('active-in-db', {
      id: 'active-in-db',
      name: 'Active In DB',
      version: '1.0.0',
      isOfficial: true,
      enabled: true,
      status: 'active',
      // r420: reload re-registers from the row, so the row must be loadable.
      manifest: { source: 'marketplace', target: 'datadog-apm' },
      createdAt: new Date(),
    });

    pluginStore.set('manifest-plugin', {
      id: 'manifest-plugin',
      name: 'Manifest Plugin',
      version: '2.0.0',
      isOfficial: false,
      enabled: false,
      status: 'errored',
      error: 'Crash on boot',
      manifest: {
        author: 'Custom Author',
        dependencies: ['dep1'],
        configSchema: [{ key: 'custom_key' }],
      },
      createdAt: new Date(),
    });

    // Add an offline plugin in DB not loaded in kernel
    pluginStore.set('offline-plugin', {
      id: 'offline-plugin',
      name: 'Offline Plugin',
      version: '0.9.0',
      isOfficial: false,
      enabled: false,
      status: 'disabled',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 1. List plugins as member
    const listRes = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: false }),
    });
    expect(listRes.statusCode).toBe(200);
    const plugins = listRes.json().plugins;
    expect(plugins.some((p: any) => p.id === 'test-notifier')).toBe(true);
    expect(plugins.some((p: any) => p.id === 'offline-plugin')).toBe(true);

    // 2. Disable plugin as admin. r420: the route refuses ids with no DB row
    // (it used to FABRICATE one for a plugin that never existed) and actually
    // unregisters the runtime — so seed the row first, like a real install.
    const disableUnknown = await app.inject({
      method: 'POST',
      url: '/never-installed/disable',
      headers: asUser({ isOperator: true }),
    });
    expect(disableUnknown.statusCode).toBe(404);

    pluginStore.set('test-notifier', {
      id: 'test-notifier',
      name: 'Test Notifier',
      version: '1.2.0',
      isOfficial: false,
      enabled: true,
      status: 'active',
      // A loadable manifest so r420's enable can actually re-register the
      // plugin from the row (sandbox source with trivial code).
      manifest: { source: 'marketplace', target: 's3-backups' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const disableRes = await app.inject({
      method: 'POST',
      url: '/test-notifier/disable',
      headers: asUser({ isOperator: true }),
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json()).toEqual({ ok: true, id: 'test-notifier', status: 'disabled' });
    // r420: the runtime instance is torn down with the row, not left running.
    expect(app.kernel.getPlugin('test-notifier')).toBeUndefined();

    // Disable plugin when already existing in DB (update branch)
    const disableExistingRes = await app.inject({
      method: 'POST',
      url: '/test-notifier/disable',
      headers: asUser({ isOperator: true }),
    });
    expect(disableExistingRes.statusCode).toBe(200);

    // Verify menu item was purged
    expect(app.kernel.menuRegistry.getAllItems().some((m) => m.id === 'test-notifier-menu')).toBe(false);

    // r420: disabling an id with no row is a 404, not a fabricated row.
    const disableNewRes = await app.inject({
      method: 'POST',
      url: '/unregistered-plugin/disable',
      headers: asUser({ isOperator: true }),
    });
    expect(disableNewRes.statusCode).toBe(404);

    // 3. Enable plugin as admin
    const enableRes = await app.inject({
      method: 'POST',
      url: '/test-notifier/enable',
      headers: asUser({ isOperator: true }),
    });
    expect(enableRes.statusCode).toBe(200);
    expect(enableRes.json()).toEqual({ ok: true, id: 'test-notifier', status: 'active' });

    // r420: enabling an id that was never installed is a 404 too — the old
    // route fabricated an 'active' row for a plugin that does not exist.
    const enableNewRes = await app.inject({
      method: 'POST',
      url: '/brand-new-plugin/enable',
      headers: asUser({ isOperator: true }),
    });
    expect(enableNewRes.statusCode).toBe(404);

    // 4. Member forbidden
    const memberMutateRes = await app.inject({
      method: 'POST',
      url: '/test-notifier/disable',
      headers: asUser({ isOperator: false }),
    });
    expect(memberMutateRes.statusCode).toBe(403);

    // 5. Get marketplace catalog
    const marketplaceRes = await app.inject({
      method: 'GET',
      url: '/marketplace',
      headers: asUser({ isOperator: false }),
    });
    expect(marketplaceRes.statusCode).toBe(200);
    const catalogJson = marketplaceRes.json();
    expect(catalogJson.catalog).toBeDefined();
    expect(Array.isArray(catalogJson.catalog)).toBe(true);

    // 6. Installing a catalog entry that has no behaviour behind it is refused
    //    and points at the feature that actually ships. It used to answer 200
    //    and mark the plugin "active", so an operator could enter a bucket and
    //    secret key and believe their backups were syncing off-site.
    const installRes = await app.inject({
      method: 'POST',
      url: '/install',
      headers: asUser({ isOperator: true }),
      payload: { source: 'marketplace', target: 's3-backups' },
    });
    expect(installRes.statusCode).toBe(400);
    expect(installRes.json().error).toMatch(/Backups → Storage destinations/);

    // Installing from a source this build cannot load code from is refused too.
    const installNpmRes = await app.inject({
      method: 'POST',
      url: '/install',
      headers: asUser({ isOperator: true }),
      payload: { source: 'npm', target: 'some-plugin' },
    });
    expect(installNpmRes.statusCode).toBe(400);
    expect(installNpmRes.json().error).toMatch(/does not load third-party plugin code/);

    // Install invalid payload (400 validation)
    const installInvalidRes = await app.inject({
      method: 'POST',
      url: '/install',
      headers: asUser({ isOperator: true }),
      payload: { source: 'unknown-source', target: '' },
    });
    expect(installInvalidRes.statusCode).toBe(400);

    // Install error (not found in marketplace)
    const installNotFoundRes = await app.inject({
      method: 'POST',
      url: '/install',
      headers: asUser({ isOperator: true }),
      payload: { source: 'marketplace', target: 'ghost-pkg' },
    });
    expect(installNotFoundRes.statusCode).toBe(400);

    // 7. Inspect plugin (valid)
    const inspectRes = await app.inject({
      method: 'GET',
      url: '/active-in-db/inspect',
      headers: asUser({ isOperator: false }),
    });
    expect(inspectRes.statusCode).toBe(200);
    expect(inspectRes.json()).toMatchObject({
      id: 'active-in-db',
      name: 'Active In DB',
      version: '1.0.0',
      status: 'active',
      dependencies: ['test-notifier'],
    });

    // Inspect kernel-only plugin (kernel-only-addon)
    const inspectKernelRes = await app.inject({
      method: 'GET',
      url: '/kernel-only-addon/inspect',
      headers: asUser({ isOperator: false }),
    });
    expect(inspectKernelRes.statusCode).toBe(200);
    expect(inspectKernelRes.json()).toMatchObject({
      id: 'kernel-only-addon',
      name: 'Kernel Only Addon',
      author: 'NineDeploy Team',
      status: 'active',
    });

    // Inspect manifest-plugin with custom author and error
    const inspectManifestRes = await app.inject({
      method: 'GET',
      url: '/manifest-plugin/inspect',
      headers: asUser({ isOperator: false }),
    });
    expect(inspectManifestRes.statusCode).toBe(200);
    expect(inspectManifestRes.json()).toMatchObject({
      id: 'manifest-plugin',
      name: 'Manifest Plugin',
      author: 'Custom Author',
      isOfficial: false,
      status: 'errored',
      error: 'Crash on boot',
      dependencies: ['dep1'],
    });

    // Inspect DB-only plugin (offline-plugin)
    const inspectDbRes = await app.inject({
      method: 'GET',
      url: '/offline-plugin/inspect',
      headers: asUser({ isOperator: false }),
    });
    expect(inspectDbRes.statusCode).toBe(200);
    expect(inspectDbRes.json()).toMatchObject({
      id: 'offline-plugin',
      name: 'Offline Plugin',
      author: 'Community Developer',
      status: 'disabled',
    });

    // Inspect not found (404)
    const inspectNotFoundRes = await app.inject({
      method: 'GET',
      url: '/non-existent-plugin/inspect',
      headers: asUser({ isOperator: false }),
    });
    expect(inspectNotFoundRes.statusCode).toBe(404);

    // 8. Hot-reload plugin (valid admin)
    const reloadRes = await app.inject({
      method: 'POST',
      url: '/active-in-db/reload',
      headers: asUser({ isOperator: true }),
    });
    expect(reloadRes.statusCode).toBe(200);
    expect(reloadRes.json()).toEqual({ ok: true, id: 'active-in-db', status: 'active' });

    // r420: reload of a kernel-only plugin with no installed row is a 404 —
    // the old route pretended to reload it (emit + ok) while doing nothing.
    const reloadKernelRes = await app.inject({
      method: 'POST',
      url: '/kernel-only-addon/reload',
      headers: asUser({ isOperator: true }),
    });
    expect(reloadKernelRes.statusCode).toBe(404);

    // Hot-reload not found (404)
    const reloadNotFoundRes = await app.inject({
      method: 'POST',
      url: '/non-existent-plugin/reload',
      headers: asUser({ isOperator: true }),
    });
    expect(reloadNotFoundRes.statusCode).toBe(404);

    // 9. Uninstall plugin (valid). Uses a row seeded directly rather than one
    //    created by the install call above — installing a catalog entry with no
    //    behaviour behind it is refused now, and uninstall is what is under
    //    test here anyway.
    const uninstallRes = await app.inject({
      method: 'POST',
      url: '/offline-plugin/uninstall',
      headers: asUser({ isOperator: true }),
    });
    expect(uninstallRes.statusCode).toBe(200);
    expect(uninstallRes.json()).toEqual({ ok: true, id: 'offline-plugin' });

    // Uninstall not found (400)
    const uninstallNotFoundRes = await app.inject({
      method: 'POST',
      url: '/ghost-plugin/uninstall',
      headers: asUser({ isOperator: true }),
    });
    expect(uninstallNotFoundRes.statusCode).toBe(400);

    await app.close();
  });

  // r527: disable → unregisterPlugin → purgePluginConfigs erased the plugin's
  // saved settings and secrets; re-enabling started it from nothing. Only an
  // uninstall erases config now — including for a plugin that is not loaded.
  it('r527: disable keeps the saved config, uninstall purges it', async () => {
    const row = {
      id: 'keeper',
      name: 'Keeper',
      version: '1.0.0',
      isOfficial: false,
      enabled: true,
      status: 'active',
      manifest: { source: 'marketplace', target: 's3-backups' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { installedPlugins: row }, update: { installed_plugins: [row] } }),
    });
    await app.register(pluginRoutes);
    await app.kernel.registerPlugin({ id: 'keeper', name: 'Keeper', version: '1.0.0', init: () => {} });
    const purge = vi.spyOn(app.kernel.configCenter, 'purgePluginConfigs').mockResolvedValue(0);

    const disabled = await app.inject({ method: 'POST', url: '/keeper/disable', headers: asUser({ isOperator: true }) });
    expect(disabled.statusCode).toBe(200);
    expect(app.kernel.getPlugin('keeper')).toBeUndefined();
    expect(purge).not.toHaveBeenCalled();

    // Uninstalling the (now unloaded) plugin is what erases its config.
    const uninstalled = await app.inject({ method: 'POST', url: '/keeper/uninstall', headers: asUser({ isOperator: true }) });
    expect(uninstalled.statusCode).toBe(200);
    expect(purge).toHaveBeenCalledWith('keeper');
    await app.close();
  });

  // F572: reload never consulted `enabled` — it re-initialised a DISABLED
  // plugin's runtime and wrote status 'active' while the row kept
  // enabled=false. Enable is the only route that loads a disabled plugin.
  it('F572: reload refuses a disabled plugin; enable still loads it', async () => {
    const row = {
      id: 'datadog-apm',
      name: 'Datadog APM',
      version: '1.0.0',
      isOfficial: true,
      enabled: false,
      status: 'disabled',
      manifest: { source: 'marketplace', target: 'datadog-apm' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = createFakeDb({ findFirst: { installedPlugins: (() => row) as never } });
    const { updates } = trackStatusUpdates(db);
    const app = await buildTestApp({ db });
    await app.register(pluginRoutes);

    const reload = await app.inject({ method: 'POST', url: '/datadog-apm/reload', headers: asUser({ isOperator: true }) });
    expect(reload.statusCode).toBe(409);
    expect(reload.json().error).toMatch(/is disabled/);
    expect(app.kernel.getPlugin('datadog-apm')).toBeUndefined();
    expect(updates).toHaveLength(0);

    const enable = await app.inject({ method: 'POST', url: '/datadog-apm/enable', headers: asUser({ isOperator: true }) });
    expect(enable.statusCode).toBe(200);
    expect(app.kernel.getPlugin('datadog-apm')).toBeDefined();
    await app.close();
  });
});

