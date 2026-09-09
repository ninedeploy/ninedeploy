import { z } from 'zod';

// ─── Configuration Center Schemas ───────────────────────────────────────────
export const configItemSchema = z.object({
  key: z.string(),
  pluginId: z.string().nullable().optional(),
  type: z.enum(['string', 'number', 'boolean', 'enum', 'json']).default('string'),
  isSecret: z.boolean(),
  label: z.string(),
  category: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  options: z.array(z.string()).optional(),
  value: z.unknown(),
  isConfigured: z.boolean(),
  updatedAt: z.string().optional(),
});
export type ConfigItem = z.infer<typeof configItemSchema>;

export const configListSchema = z.object({
  entries: z.array(configItemSchema),
});
export type ConfigListResponse = z.infer<typeof configListSchema>;

export const setConfigSchema = z.object({
  // Optional: an omitted value keeps the current one (metadata-only update).
  value: z.unknown().optional(),
  isSecret: z.boolean().optional(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).optional(),
});
export type SetConfigInput = z.infer<typeof setConfigSchema>;

// ─── Plugin Ecosystem Schemas ───────────────────────────────────────────────
export const pluginItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  icon: z.string().optional(),
  isOfficial: z.boolean(),
  enabled: z.boolean(),
  status: z.enum(['active', 'disabled', 'errored', 'installing']),
  configSchema: z.array(z.record(z.string(), z.unknown())).optional(),
  menuItems: z.array(z.record(z.string(), z.unknown())).optional(),
  dependencies: z.array(z.string()).optional(),
  error: z.string().optional(),
  installedAt: z.string().optional(),
});
export type PluginItem = z.infer<typeof pluginItemSchema>;

export const pluginListSchema = z.object({
  plugins: z.array(pluginItemSchema),
});
export type PluginListResponse = z.infer<typeof pluginListSchema>;

export const installPluginSchema = z.object({
  source: z.enum(['marketplace', 'npm', 'git', 'local', 'sandbox']).default('marketplace'),
  target: z.string().min(1),
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  icon: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  configSchema: z.array(z.record(z.string(), z.unknown())).optional(),
  menuItems: z.array(z.record(z.string(), z.unknown())).optional(),
  /**
   * Sandbox-source only: the worker script the plugin runs. This field (and
   * `manifest`) MUST travel with the install — a sandbox plugin installed
   * without its code used to register as "active" while silently executing
   * nothing, and after a restart the restored row had no way to reload the
   * code at all. Bounded so one install cannot balloon the SQLite row.
   */
  code: z.string().min(1).max(256 * 1024).optional(),
  manifest: z.record(z.string(), z.unknown()).optional(),
});
export type InstallPluginInput = z.infer<typeof installPluginSchema>;

export const marketplacePluginItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.string(),
  icon: z.string().optional(),
  category: z.string(),
  isOfficial: z.boolean(),
  isInstalled: z.boolean().default(false),
  /**
   * Whether installing this entry actually does anything.
   *
   * NineDeploy does not load third-party plugin code, so every catalog entry is
   * a roadmap item until the behaviour is compiled into the server. Marking it
   * matters because several entries shadow features that already exist by
   * another name — an operator who "installed" the S3 sync plugin, filled in a
   * bucket and secret key, and saw it reported as active would reasonably
   * believe their backups were being copied off-site. They were not.
   */
  implemented: z.boolean().default(false),
  /** Where the real feature lives, for entries that shadow a shipped one. */
  builtIn: z
    .object({
      label: z.string(),
      /** Panel route, e.g. `/settings?tab=storage`. */
      path: z.string(),
    })
    .optional(),
  dependencies: z.array(z.string()).optional(),
  configSchema: z.array(z.record(z.string(), z.unknown())).optional(),
  menuItems: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type MarketplacePluginItem = z.infer<typeof marketplacePluginItemSchema>;

export const marketplaceCatalogSchema = z.object({
  catalog: z.array(marketplacePluginItemSchema),
  /** True when the live signed index was reached and
   *  verified; false when the upstream was unreachable
   *  and the static catalog was served. */
  live: z.boolean().default(false),
  /** The verifying key id, when the live index was used. */
  keyId: z.string().nullable().optional(),
  /** When the cache was last refreshed (ms since epoch). */
  fetchedAt: z.number().optional(),
});
export type MarketplaceCatalogResponse = z.infer<typeof marketplaceCatalogSchema>;

// ─── Menu & Navigation Schemas ──────────────────────────────────────────────
export const menuItemSchema = z.object({
  id: z.string(),
  pluginId: z.string().optional(),
  slot: z.string(),
  label: z.string(),
  route: z.string(),
  icon: z.string().optional(),
  order: z.number().optional(),
  permission: z.enum(['admin', 'member']).optional(),
});
export type MenuItem = z.infer<typeof menuItemSchema>;

export const menuListSchema = z.object({
  slots: z.record(z.string(), z.array(menuItemSchema)),
  items: z.array(menuItemSchema),
});
export type MenuListResponse = z.infer<typeof menuListSchema>;

export const pluginInspectSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  isOfficial: z.boolean(),
  enabled: z.boolean(),
  status: z.enum(['active', 'disabled', 'errored', 'installing']),
  dependencies: z.array(z.string()),
  hooks: z.array(z.string()),
  services: z.array(z.string()),
  menus: z.array(menuItemSchema),
  configSchema: z.array(z.record(z.string(), z.unknown())),
  error: z.string().nullable().optional(),
  installedAt: z.string().optional(),
  runtimeStats: z.object({
    eventsHandled: z.number(),
    uptimeSeconds: z.number(),
    loadedAt: z.string().optional(),
  }),
});
export type PluginInspectResponse = z.infer<typeof pluginInspectSchema>;

