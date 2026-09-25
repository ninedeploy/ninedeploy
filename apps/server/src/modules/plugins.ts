import { installedPlugins } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { InstallPluginInput } from '@ninedeploy/schemas';
import { installPluginSchema } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { clearMarketplaceCache, loadMarketplaceCatalog } from '../lib/marketplaceCatalog.js';
import { installPlugin, uninstallPlugin } from '../kernel/pluginLoader.js';

export const pluginRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // List all plugins
  app.get('/', async (req) => {
    const dbPlugins = await app.db.query.installedPlugins.findMany();
    const kernelPlugins = req.kernel.listPlugins();

    const dbMap = new Map(dbPlugins.map((p) => [p.id, p]));
    const result = [];

    // 1. Process active kernel registered plugins
    for (const kp of kernelPlugins) {
      const dbRow = dbMap.get(kp.id);
      result.push({
        id: kp.id,
        name: kp.name,
        version: kp.version,
        description: kp.description,
        isOfficial: dbRow ? dbRow.isOfficial : false,
        enabled: dbRow ? dbRow.enabled : true,
        status: dbRow ? dbRow.status : 'active',
        configSchema: kp.configSchema ?? [],
        menuItems: kp.menuItems ?? [],
        dependencies: kp.dependencies ?? [],
        installedAt: dbRow?.createdAt?.toISOString() ?? new Date().toISOString(),
      });
    }

    // 2. Add disabled or recorded DB plugins not currently loaded in kernel
    for (const row of dbPlugins) {
      if (kernelPlugins.some((kp) => kp.id === row.id)) continue;
      result.push({
        id: row.id,
        name: row.name,
        version: row.version,
        description: (row.manifest as Record<string, any> | null)?.description,
        isOfficial: row.isOfficial,
        enabled: row.enabled,
        status: row.status,
        configSchema: [],
        menuItems: [],
        dependencies: [],
        error: row.error ?? undefined,
        installedAt: row.createdAt.toISOString(),
      });
    }

    return { plugins: result };
  });

  // Get marketplace catalog (admin & members). The live
  // signed index (when `NINEDEPLOY_MARKETPLACE_URL` is
  // configured) is preferred; the in-code catalog is the
  // fallback so a missing upstream never returns an
  // empty list. `?refresh=true` bypasses the 5-minute
  // cache (G-24).
  app.get<{ Querystring: { refresh?: string } }>('/marketplace', async (req) => {
    const dbPlugins = await app.db.query.installedPlugins.findMany();
    const installedIds = new Set(dbPlugins.map((p) => p.id));
    // r286: a forced refresh bypasses the cache and makes the server fetch
    // the upstream index — operator-only, like POST /marketplace/refresh.
    // A non-operator's `?refresh=true` is served from the cache.
    const force = (req.query.refresh === 'true' || req.query.refresh === '1') && req.user?.isOperator === true;
    if (force) clearMarketplaceCache();
    const result = await loadMarketplaceCatalog(installedIds, { force });
    return {
      catalog: result.catalog,
      live: result.live,
      keyId: result.keyId,
      fetchedAt: result.fetchedAt,
    };
  });

  // Force-refresh the in-process catalog cache. Useful
  // for `ninedeploy plugins marketplace refresh` in CI
  // after the upstream rotated its key. r286: operator-only — any seat
  // (viewer included) could force an outbound fetch of the signed index on
  // demand and churn the shared cache.
  app.post('/marketplace/refresh', { preHandler: app.requireOperator }, async (req) => {
    const dbPlugins = await app.db.query.installedPlugins.findMany();
    const installedIds = new Set(dbPlugins.map((p) => p.id));
    const result = await loadMarketplaceCatalog(installedIds, { force: true });
    void audit(
      app.db,
      req.user!.id,
      'plugin.marketplace_refresh',
      `live=${result.live} entries=${result.catalog.length}`,
    );
    return {
      ok: true,
      live: result.live,
      keyId: result.keyId,
      entries: result.catalog.length,
      fetchedAt: result.fetchedAt,
    };
  });

  // Install external/marketplace plugin (admin only)
  app.post<{ Body: InstallPluginInput }>('/install', { preHandler: app.requireAdmin }, async (req, reply) => {
    const parsed = installPluginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.format() });
    }

    try {
      const result = await installPlugin(app.db, req.kernel, parsed.data);
      await audit(app.db, req.user!.id, 'plugin.install', 'system', {
        pluginId: result.id,
        source: parsed.data.source,
        target: parsed.data.target,
      });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Uninstall plugin (admin only)
  app.post<{ Params: { id: string } }>('/:id/uninstall', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params;
    try {
      const result = await uninstallPlugin(app.db, req.kernel, id);
      await audit(app.db, req.user!.id, 'plugin.uninstall', 'system', { pluginId: id });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Enable plugin (admin only)
  app.post<{ Params: { id: string } }>('/:id/enable', { preHandler: app.requireAdmin }, async (req) => {
    const { id } = req.params;
    const existing = await app.db.query.installedPlugins.findFirst({
      where: eq(installedPlugins.id, id),
    });

    if (!existing) {
      // Record and mark enabled
      await app.db.insert(installedPlugins).values({
        id,
        name: id,
        version: '1.0.0',
        enabled: true,
        status: 'active',
      }).onConflictDoUpdate({
        target: installedPlugins.id,
        set: { enabled: true, status: 'active', updatedAt: new Date() },
      });
    } else {
      await app.db.update(installedPlugins).set({ enabled: true, status: 'active', updatedAt: new Date() }).where(eq(installedPlugins.id, id));
    }

    req.kernel.events.emit('plugin.status_changed', { pluginId: id, status: 'active' });
    await audit(app.db, req.user!.id, 'plugin.enable', 'system', { pluginId: id });

    return { ok: true, id, status: 'active' };
  });

  // Disable plugin (admin only)
  app.post<{ Params: { id: string } }>('/:id/disable', { preHandler: app.requireAdmin }, async (req) => {
    const { id } = req.params;
    const existing = await app.db.query.installedPlugins.findFirst({
      where: eq(installedPlugins.id, id),
    });

    if (!existing) {
      await app.db.insert(installedPlugins).values({
        id,
        name: id,
        version: '1.0.0',
        enabled: false,
        status: 'disabled',
      }).onConflictDoUpdate({
        target: installedPlugins.id,
        set: { enabled: false, status: 'disabled', updatedAt: new Date() },
      });
    } else {
      await app.db.update(installedPlugins).set({ enabled: false, status: 'disabled', updatedAt: new Date() }).where(eq(installedPlugins.id, id));
    }

    // Purge runtime menus contributed by disabled plugin
    req.kernel.menuRegistry.purgePluginMenus(id);
    req.kernel.events.emit('plugin.status_changed', { pluginId: id, status: 'disabled' });
    await audit(app.db, req.user!.id, 'plugin.disable', 'system', { pluginId: id });

    return { ok: true, id, status: 'disabled' };
  });

  // Inspect plugin runtime metadata and telemetry
  app.get<{ Params: { id: string } }>('/:id/inspect', async (req, reply) => {
    const { id } = req.params;
    const dbRow = await app.db.query.installedPlugins.findFirst({
      where: eq(installedPlugins.id, id),
    });
    const kernelPlugin = req.kernel.getPlugin(id);

    if (!dbRow && !kernelPlugin) {
      return reply.code(404).send({ error: `Plugin "${id}" not found` });
    }

    const menus = req.kernel.menuRegistry.getPluginMenus(id);
    const manifest = (dbRow?.manifest as Record<string, any> | null) ?? {};

    const name = kernelPlugin ? kernelPlugin.name : dbRow!.name;
    const version = kernelPlugin ? kernelPlugin.version : dbRow!.version;
    const description = kernelPlugin ? kernelPlugin.description : manifest.description;
    const isOfficial = dbRow ? dbRow.isOfficial : true;
    const author = manifest.author ? manifest.author : (isOfficial ? 'NineDeploy Team' : 'Community Developer');
    const enabled = dbRow ? dbRow.enabled : true;
    const status = dbRow ? dbRow.status : 'active';
    const dependencies = kernelPlugin?.dependencies ?? manifest.dependencies ?? [];
    const configSchema = kernelPlugin?.configSchema ?? manifest.configSchema ?? [];
    const installedAt = dbRow?.createdAt ? dbRow.createdAt.toISOString() : undefined;
    const loadedAt = dbRow?.updatedAt ? dbRow.updatedAt.toISOString() : installedAt;

    return {
      id,
      name,
      version,
      description,
      author,
      isOfficial,
      enabled,
      status,
      dependencies,
      // r286: these used to be hard-coded — every plugin "tapped" the same
      // three hooks, ran a `plugin:<id>:worker` and had handled 42 events in
      // 3600 s of uptime. The kernel tracks none of that per plugin, so the
      // honest answer is empty lists and null counters, not invented ones.
      hooks: [] as string[],
      services: [] as string[],
      menus,
      configSchema,
      error: dbRow?.error ?? null,
      installedAt,
      runtimeStats: {
        eventsHandled: null,
        uptimeSeconds: null,
        loadedAt,
      },
    };
  });

  // Hot-reload plugin (admin only)
  app.post<{ Params: { id: string } }>('/:id/reload', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params;
    const dbRow = await app.db.query.installedPlugins.findFirst({
      where: eq(installedPlugins.id, id),
    });
    const kernelPlugin = req.kernel.getPlugin(id);

    if (!dbRow && !kernelPlugin) {
      return reply.code(404).send({ error: `Plugin "${id}" not found` });
    }

    const status = dbRow ? (dbRow.status as 'active' | 'disabled' | 'errored') : 'active';
    req.kernel.events.emit('plugin.reloaded', { pluginId: id, status });
    await audit(app.db, req.user!.id, 'plugin.reload', 'system', { pluginId: id });

    return { ok: true, id, status };
  });
};
