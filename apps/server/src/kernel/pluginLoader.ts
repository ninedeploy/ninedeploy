import type { DB } from '@ninedeploy/db';
import { installedPlugins } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import type { InstallPluginInput, MarketplacePluginItem } from '@ninedeploy/schemas';
import type { KernelContext, KernelPlugin } from './types.js';
import { SandboxPlugin } from './sandbox/sandboxPlugin.js';

/**
 * The roadmap index the Plugins page renders. `builtIn.path` is a PANEL route,
 * rendered as a link — Settings selects its page with `?section=`, not `?tab=`
 * (see `apps/web/src/routes/settings/index.tsx`), and a wrong one silently
 * lands the operator on the default page. `test/kernelHonesty.test.ts` checks
 * every entry's shape.
 */
export const MARKETPLACE_CATALOG: Omit<MarketplacePluginItem, 'isInstalled'>[] = [
  {
    id: 's3-backups',
    implemented: false,
    builtIn: { label: 'Backups → Storage destinations', path: '/backups' },
    name: 'Amazon S3 & Cloudflare R2 Sync',
    version: '1.1.0',
    description: 'Automated off-site backup synchronization to Amazon S3, Cloudflare R2, Wasabi, or MinIO',
    author: 'NineDeploy Official',
    icon: 'HardDrive',
    category: 'storage',
    isOfficial: true,
    dependencies: [],
    configSchema: [
      {
        key: 'bucket_name',
        type: 'string',
        isSecret: false,
        label: 'S3 Bucket Name',
        category: 'plugin:s3-backups',
        tags: ['s3', 'storage'],
      },
      {
        key: 'access_key_id',
        type: 'string',
        isSecret: false,
        label: 'Access Key ID',
        category: 'plugin:s3-backups',
        tags: ['s3', 'auth'],
      },
      {
        key: 'secret_access_key',
        type: 'string',
        isSecret: true,
        label: 'Secret Access Key',
        category: 'plugin:s3-backups',
        tags: ['s3', 'secret'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'slack-alerts',
    implemented: false,
    builtIn: { label: 'Settings → Notifications', path: '/settings?section=notifications' },
    name: 'Slack Notification Dispatcher',
    version: '1.0.0',
    description: 'Post deployment summaries, container crash alerts, and health warnings directly into Slack channels',
    author: 'NineDeploy Official',
    icon: 'MessageSquare',
    category: 'notifications',
    isOfficial: true,
    dependencies: ['notifications-dispatcher'],
    configSchema: [
      {
        key: 'webhook_url',
        type: 'string',
        isSecret: true,
        label: 'Slack Webhook URL',
        category: 'plugin:slack-alerts',
        tags: ['slack', 'notifications'],
      },
      {
        key: 'channel_override',
        type: 'string',
        isSecret: false,
        label: 'Channel Name',
        category: 'plugin:slack-alerts',
        tags: ['slack'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'discord-alerts',
    implemented: false,
    builtIn: { label: 'Settings → Notifications', path: '/settings?section=notifications' },
    name: 'Discord Webhook Notifier',
    version: '1.0.0',
    description: 'Send color-coded rich embeds and server statistics to your Discord guild channels',
    author: 'Community Verified',
    icon: 'Bot',
    category: 'notifications',
    isOfficial: false,
    dependencies: ['notifications-dispatcher'],
    configSchema: [
      {
        key: 'webhook_url',
        type: 'string',
        isSecret: true,
        label: 'Discord Webhook URL',
        category: 'plugin:discord-alerts',
        tags: ['discord'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'datadog-apm',
    implemented: false,
    name: 'Datadog APM & DogStatsD',
    version: '1.0.0',
    description: 'Stream container resource metrics and trace logs to your Datadog monitoring dashboard',
    author: 'Community Verified',
    icon: 'BarChart',
    category: 'monitoring',
    isOfficial: false,
    dependencies: ['telemetry-streamer'],
    configSchema: [
      {
        key: 'api_key',
        type: 'string',
        isSecret: true,
        label: 'Datadog API Key',
        category: 'plugin:datadog-apm',
        tags: ['datadog', 'apm'],
      },
      {
        key: 'site',
        type: 'string',
        isSecret: false,
        label: 'Datadog Site (e.g. datadoghq.eu)',
        category: 'plugin:datadog-apm',
        tags: ['datadog'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'redis-sentinel',
    implemented: false,
    name: 'Redis Sentinel High Availability',
    version: '1.0.0',
    description: 'Automatic master failover and client routing for high-availability Redis topologies',
    author: 'NineDeploy Official',
    icon: 'Layers',
    category: 'database',
    isOfficial: true,
    dependencies: [],
    configSchema: [
      {
        key: 'master_name',
        type: 'string',
        isSecret: false,
        label: 'Sentinel Master Name',
        category: 'plugin:redis-sentinel',
        tags: ['redis'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'postgres-wal-g',
    implemented: false,
    name: 'PostgreSQL WAL-G Continuous Archiving',
    version: '1.0.0',
    description: 'Continuous WAL streaming and Point-in-Time-Recovery (PITR) for mission-critical PostgreSQL databases',
    author: 'Community Verified',
    icon: 'Database',
    category: 'database',
    isOfficial: false,
    dependencies: ['s3-backups'],
    configSchema: [],
    menuItems: [],
  },
  {
    id: 'github-app',
    implemented: false,
    builtIn: { label: 'Sources → GitHub Apps (built in since 0.13)', path: '/sources' },
    name: 'GitHub App & CI/CD Webhooks',
    version: '1.0.0',
    description: 'Built in since 0.13: register a GitHub App under Sources → GitHub Apps (one-click manifest setup, or manual entry for GitHub Enterprise Server), sync its installations, and deploy with short-lived installation tokens, commit statuses and PR preview comments. This catalog entry stays a placeholder; its settings are not read.',
    author: 'NineDeploy Official',
    icon: 'Github',
    category: 'automation',
    isOfficial: true,
    dependencies: [],
    configSchema: [
      {
        key: 'app_id',
        type: 'string',
        isSecret: false,
        label: 'GitHub App ID',
        category: 'plugin:github-app',
        tags: ['github', 'ci'],
      },
      {
        key: 'private_key',
        type: 'string',
        isSecret: true,
        label: 'GitHub App Private Key (.pem)',
        category: 'plugin:github-app',
        tags: ['github', 'secret'],
      },
      {
        key: 'webhook_secret',
        type: 'string',
        isSecret: true,
        label: 'Webhook Secret',
        category: 'plugin:github-app',
        tags: ['github', 'webhook'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'prometheus-exporter',
    implemented: false,
    builtIn: { label: 'Monitoring', path: '/monitoring' },
    name: 'Prometheus & OpenTelemetry Exporter',
    version: '1.0.0',
    description: 'Exposes scrapeable /metrics endpoint with container CPU/Memory, network I/O, Traefik request counts, and system telemetry',
    author: 'NineDeploy Official',
    icon: 'Activity',
    category: 'monitoring',
    isOfficial: true,
    dependencies: [],
    configSchema: [
      {
        key: 'metrics_port',
        type: 'number',
        isSecret: false,
        label: 'Prometheus Metrics Port (default: 9100)',
        category: 'plugin:prometheus-exporter',
        tags: ['metrics', 'prometheus'],
      },
      {
        key: 'enable_auth',
        type: 'boolean',
        isSecret: false,
        label: 'Require Bearer Authentication',
        category: 'plugin:prometheus-exporter',
        tags: ['security'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'cloudflare-dns',
    implemented: false,
    builtIn: { label: 'Settings → Integrations → DNS records', path: '/settings?section=integrations' },
    name: 'Cloudflare DNS & Zero-Trust Automation',
    version: '1.0.0',
    description: 'Automated Cloudflare DNS record creation, proxy mode management, and Cloudflare Access service tokens',
    author: 'NineDeploy Official',
    icon: 'Cloud',
    category: 'networking',
    isOfficial: true,
    dependencies: [],
    configSchema: [
      {
        key: 'api_token',
        type: 'string',
        isSecret: true,
        label: 'Cloudflare API Token',
        category: 'plugin:cloudflare-dns',
        tags: ['cloudflare', 'dns'],
      },
      {
        key: 'zone_id',
        type: 'string',
        isSecret: false,
        label: 'Cloudflare Zone ID',
        category: 'plugin:cloudflare-dns',
        tags: ['cloudflare'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'sentry-tracking',
    implemented: false,
    name: 'Sentry Error & Performance Tracking',
    version: '1.0.0',
    description: 'Real-time error capturing, stack trace analysis, and deployment performance release tracking via Sentry',
    author: 'Community Verified',
    icon: 'AlertTriangle',
    category: 'monitoring',
    isOfficial: false,
    dependencies: [],
    configSchema: [
      {
        key: 'dsn',
        type: 'string',
        isSecret: true,
        label: 'Sentry Project DSN',
        category: 'plugin:sentry-tracking',
        tags: ['sentry', 'apm'],
      },
      {
        key: 'environment',
        type: 'string',
        isSecret: false,
        label: 'Release Environment (production/staging)',
        category: 'plugin:sentry-tracking',
        tags: ['sentry'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'tailscale-vpn',
    implemented: false,
    name: 'Tailscale Mesh VPN Integration',
    version: '1.0.0',
    description: 'Connect your NineDeploy instance and private deployment nodes to your Tailscale mesh network for secure, overlay networking',
    author: 'Community Verified',
    icon: 'Shield',
    category: 'networking',
    isOfficial: false,
    dependencies: [],
    configSchema: [
      {
        key: 'auth_key',
        type: 'string',
        isSecret: true,
        label: 'Tailscale Reusable Auth Key',
        category: 'plugin:tailscale-vpn',
        tags: ['tailscale', 'vpn'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'telegram-bot',
    implemented: false,
    builtIn: { label: 'Settings → Notifications', path: '/settings?section=notifications' },
    name: 'Telegram Bot Incident Responder',
    version: '1.0.0',
    description: 'Interactive Telegram Bot for instant deployment alerts, container restart commands, and database backup reports',
    author: 'NineDeploy Official',
    icon: 'Send',
    category: 'notifications',
    isOfficial: true,
    dependencies: ['notifications-dispatcher'],
    configSchema: [
      {
        key: 'bot_token',
        type: 'string',
        isSecret: true,
        label: 'Telegram Bot Token',
        category: 'plugin:telegram-bot',
        tags: ['telegram'],
      },
      {
        key: 'chat_id',
        type: 'string',
        isSecret: false,
        label: 'Chat / Channel ID',
        category: 'plugin:telegram-bot',
        tags: ['telegram'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'crowdsec-security',
    implemented: false,
    name: 'CrowdSec Security & Intrusion Prevention',
    version: '1.0.0',
    description: 'Collaborative intrusion prevention system blocking brute-force attacks, port scans, and malicious bots on Traefik ingress',
    author: 'Community Verified',
    icon: 'Lock',
    category: 'security',
    isOfficial: false,
    dependencies: [],
    configSchema: [
      {
        key: 'lapi_url',
        type: 'string',
        isSecret: false,
        label: 'CrowdSec Local API URL',
        category: 'plugin:crowdsec-security',
        tags: ['crowdsec', 'security'],
      },
      {
        key: 'api_key',
        type: 'string',
        isSecret: true,
        label: 'Bouncer API Key',
        category: 'plugin:crowdsec-security',
        tags: ['crowdsec', 'secret'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'minio-s3-gateway',
    implemented: false,
    builtIn: { label: 'Backups → Storage destinations', path: '/backups' },
    name: 'MinIO S3 Self-Hosted Storage Gateway',
    version: '1.0.0',
    description: 'High-performance, S3-compatible private object storage cluster provisioning and volume mirroring engine',
    author: 'NineDeploy Official',
    icon: 'HardDrive',
    category: 'storage',
    isOfficial: true,
    dependencies: [],
    configSchema: [
      {
        key: 'endpoint',
        type: 'string',
        isSecret: false,
        label: 'MinIO API Endpoint (e.g. minio.internal:9000)',
        category: 'plugin:minio-s3-gateway',
        tags: ['storage', 's3'],
      },
      {
        key: 'root_user',
        type: 'string',
        isSecret: false,
        label: 'MinIO Root User',
        category: 'plugin:minio-s3-gateway',
        tags: ['auth'],
      },
      {
        key: 'root_password',
        type: 'string',
        isSecret: true,
        label: 'MinIO Root Password',
        category: 'plugin:minio-s3-gateway',
        tags: ['secret'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'health-pinger',
    implemented: false,
    builtIn: { label: 'Monitoring → Alert rules', path: '/monitoring' },
    name: 'Uptime Sentinel & Health Pinger',
    version: '1.0.0',
    description: 'Multi-target active HTTP/TCP heartbeat pinger with latency histograms, auto-restart triggers, and SLA reports',
    author: 'NineDeploy Official',
    icon: 'Activity',
    category: 'monitoring',
    isOfficial: true,
    dependencies: ['notifications-dispatcher'],
    configSchema: [
      {
        key: 'ping_interval_seconds',
        type: 'number',
        isSecret: false,
        label: 'Ping Interval (seconds, default: 30)',
        category: 'plugin:health-pinger',
        tags: ['health'],
      },
      {
        key: 'timeout_ms',
        type: 'number',
        isSecret: false,
        label: 'Request Timeout (ms, default: 5000)',
        category: 'plugin:health-pinger',
        tags: ['health'],
      },
    ],
    menuItems: [],
  },
  {
    id: 'vault-secrets',
    implemented: false,
    builtIn: { label: 'Settings → Integrations → Vault provider', path: '/settings?section=integrations' },
    name: 'HashiCorp Vault Secret Synchronization',
    version: '1.0.0',
    description: 'Dynamic secret leasing, token renewal, and automatic environment variable injection directly from HashiCorp Vault KV v2 engines',
    author: 'Community Verified',
    icon: 'Shield',
    category: 'security',
    isOfficial: false,
    dependencies: [],
    configSchema: [
      {
        key: 'vault_addr',
        type: 'string',
        isSecret: false,
        label: 'Vault Address URL (e.g. https://vault.internal:8200)',
        category: 'plugin:vault-secrets',
        tags: ['vault', 'security'],
      },
      {
        key: 'vault_token',
        type: 'string',
        isSecret: true,
        label: 'Vault Token / AppRole Secret ID',
        category: 'plugin:vault-secrets',
        tags: ['secret'],
      },
      {
        key: 'mount_path',
        type: 'string',
        isSecret: false,
        label: 'KV v2 Mount Path (default: secret)',
        category: 'plugin:vault-secrets',
        tags: ['vault'],
      },
    ],
    menuItems: [],
  },
];

export function getMarketplaceCatalog(installedIds: Set<string>): MarketplacePluginItem[] {
  return MARKETPLACE_CATALOG.map((item) => ({
    ...item,
    isInstalled: installedIds.has(item.id),
  }));
}

/**
 * Sources this build can actually honour.
 *
 * Nothing in this file ever `import()`s anything, so an "installed" npm, git or
 * local plugin was only ever a DB row plus a shell object whose `init` emits
 * one event and returns — while the panel reported it as active. An operator
 * could therefore believe they had added functionality that does not exist.
 * Only the official catalog (whose entries map onto behaviour compiled into the
 * server) can be installed.
 *
 * Loading third-party code into the panel process is a real feature with real
 * requirements — fetch, integrity verification, sandboxing, an upgrade story —
 * not something to fake.
 */
const LOADABLE_SOURCES = new Set(['marketplace', 'sandbox']);

/** True when this build can actually run a plugin from `source`. */
export function isLoadableSource(source: string): boolean {
  return LOADABLE_SOURCES.has(source);
}

/**
 * Thrown when someone tries to install a plugin from a source this build cannot
 * load code from. Carries a 400-shaped status so the route answers with a
 * client error rather than a generic failure.
 */
export class UnsupportedPluginSourceError extends Error {
  readonly statusCode = 400;
  constructor(readonly source: string) {
    super(
      `Installing plugins from "${source}" is not supported: NineDeploy does not load third-party plugin code without sandbox. ` +
        'Only the official marketplace catalog and verified sandbox extensions can be installed.',
    );
    this.name = 'UnsupportedPluginSourceError';
  }
}

/**
 * Thrown when a catalog entry is listed but not yet backed by real behaviour.
 * The message names the shipped feature to use instead, when there is one.
 */
export class UnimplementedPluginError extends Error {
  readonly statusCode = 400;
  constructor(entry: { name: string; builtIn?: { label: string; path: string } }) {
    const pointer = entry.builtIn
      ? ` This capability already ships in NineDeploy — use ${entry.builtIn.label} (${entry.builtIn.path}).`
      : ' It is listed as a roadmap item and installing it would do nothing.';
    super(`"${entry.name}" is not available yet.${pointer}`);
    this.name = 'UnimplementedPluginError';
  }
}

/**
 * r531: ids of the plugins compiled into the server and registered by
 * `plugins/kernel.ts` at boot. Reserved: an installed plugin with one of
 * these ids shares the built-in's `plugin:<id>:` config namespace (its
 * secrets, domain-presets' DNS record ledger, …), and the install path used
 * to UNREGISTER the built-in to make room for it. `test/kernel/pluginIdGuard`
 * pins this list to the classes' own ids.
 */
export const BUILT_IN_PLUGIN_IDS: readonly string[] = Object.freeze([
  'notifications-dispatcher',
  'cloudflare-tunnels',
  'telemetry-streamer',
  'template-bundles',
  'manifest-generator',
  'webhook-out',
  'domain-presets',
  'config-presets',
  'sticky-session',
  'metric-history',
  'build-cache',
  'sticky-ip',
]);

export function isBuiltInPluginId(id: string): boolean {
  return BUILT_IN_PLUGIN_IDS.includes(id);
}

/**
 * r531: the id shape a NEW sandbox install must have. `:` would let an id
 * reach into another plugin's config namespace (`plugin:domain-presets:record`
 * IS `plugin:domain-presets:` + `record:…`) and `.` into its event namespace
 * (`plugin.<id>.<name>`, r530), so neither separator is allowed.
 */
export const SANDBOX_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Thrown when an install would collide with a built-in or another installed plugin. */
export class PluginIdConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'PluginIdConflictError';
  }
}

/**
 * r531: why a stored row cannot be restored at boot (null when it can). Kept
 * deliberately narrower than the install check: an id that was accepted
 * before 0.10.36 keeps loading unless it is actually dangerous — it shadows a
 * built-in, or carries the `:` that escapes into another config namespace.
 */
export function bootRestoreConflict(id: string): string | null {
  if (isBuiltInPluginId(id)) {
    return (
      `Plugin "${id}" was not loaded: its id is reserved by the built-in "${id}" plugin, and loading it ` +
      `would share that plugin's configuration and secrets. Uninstall it from Settings → Plugins and ` +
      `reinstall it under a different id.`
    );
  }
  if (id.includes(':')) {
    return (
      `Plugin "${id}" was not loaded: ":" in a plugin id reaches into another plugin's configuration ` +
      `namespace. Uninstall it from Settings → Plugins and reinstall it under an id matching ` +
      `${SANDBOX_PLUGIN_ID_PATTERN}.`
    );
  }
  return null;
}

/**
 * r600: the operator's explicit acceptance that sandbox plugins run with
 * UNRESTRICTED network on a Node whose permission model has no net scope
 * (Node < 25 — see `SandboxPlugin.networkDenied()`, r534). Read per call so
 * changing .env + restart is the whole switch.
 */
export function sandboxNetworkOptIn(): boolean {
  return process.env['NINEDEPLOY_ALLOW_SANDBOX_NETWORK'] === '1';
}

/**
 * r600: thrown when a NEW sandbox install would get network access the
 * sandbox cannot take away on this Node. Already-installed plugins keep
 * loading (boot restore / enable / reload do not pass through here) — the
 * Doctor reports them instead (`sandbox_plugin_network`).
 */
export class SandboxNetworkUnrestrictedError extends Error {
  readonly statusCode = 409;
  constructor() {
    super(
      `Sandbox plugins cannot be installed on Node ${process.version}: its permission model has no network ` +
        `scope, so the plugin's code could open sockets and make HTTP requests from the panel host. ` +
        `Either upgrade Node.js to 25 or newer (the Docker image already runs Node 26), or — if you accept ` +
        `that sandbox plugins have unrestricted network — set NINEDEPLOY_ALLOW_SANDBOX_NETWORK=1 in .env ` +
        `and restart NineDeploy.`,
    );
    this.name = 'SandboxNetworkUnrestrictedError';
  }
}

/** A catalog the loader can resolve entries against. Injectable for tests. */
export type Catalog = ReadonlyArray<Omit<MarketplacePluginItem, 'isInstalled'>>;

export function createDynamicPlugin(input: InstallPluginInput, catalog: Catalog = MARKETPLACE_CATALOG): KernelPlugin {
  if (input.source === 'sandbox') {
    // `code` arrives through the schema now; a sandbox install without one
    // would register as "active" while running nothing — refuse it instead.
    if (!input.code) {
      throw new Error(
        `Sandbox plugin "${input.name || input.target}" carries no code — pass \`code\` with the install`,
      );
    }
    return new SandboxPlugin({
      id: input.target,
      name: input.name || input.target,
      version: input.version || '1.0.0',
      description: input.description,
      author: input.author,
      icon: input.icon,
      code: input.code,
      manifest: input.manifest,
    });
  }

  let id = input.target;
  let name = input.name || input.target;
  let version = input.version || '1.0.0';
  let description = input.description;
  let author = input.author || 'External';
  let icon: string | undefined = input.icon ?? 'Box';
  let isOfficial = false;
  let configSchema: any[] | undefined = input.configSchema;
  let menuItems: any[] | undefined = input.menuItems;
  let dependencies: string[] | undefined = input.dependencies;

  if (input.source === 'marketplace') {
    const found = catalog.find((m) => m.id === input.target);
    if (!found) {
      throw new Error(`Marketplace plugin "${input.target}" not found in catalog`);
    }
    id = found.id;
    name = found.name;
    version = found.version;
    description = found.description;
    author = found.author;
    icon = found.icon;
    isOfficial = found.isOfficial;
    configSchema = found.configSchema;
    menuItems = found.menuItems;
    dependencies = found.dependencies;
  } else if (input.source === 'npm') {
    // Sanitize npm package name to safe plugin ID.
    id = input.target.replace(/^@/, '').replace(/[/@.]/g, '-').toLowerCase();
  } else if (input.source === 'git') {
    const match = input.target.match(/\/([^/]+?)(?:\.git)?$/);
    id = (match ? match[1]! : input.target).replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
  }

  return {
    id,
    name,
    version,
    description,
    author,
    icon,
    isOfficial,
    dependencies,
    configSchema,
    menuItems,
    init: async (ctx: KernelContext) => {
      ctx.events.emit('plugin.status_changed', { pluginId: id, status: 'active' });
    },
    destroy: async () => {},
  };
}

export async function installPlugin(
  db: DB,
  kernel: KernelContext,
  input: InstallPluginInput,
  catalog: Catalog = MARKETPLACE_CATALOG,
): Promise<{ ok: boolean; id: string; status: string }> {
  // Refuse here rather than inside `createDynamicPlugin`: that function is also
  // used to RESTORE rows at boot, and throwing there would make every existing
  // install log a failure on every start.
  if (!isLoadableSource(input.source)) throw new UnsupportedPluginSourceError(input.source);
  // A catalog entry with no behaviour behind it must not be installable. It
  // would report itself as "active" and accept configuration (bucket names,
  // secret keys, webhook URLs) while doing nothing — and several entries shadow
  // features that DO exist under another name, so the false confidence is the
  // dangerous kind. Point at the real feature instead.
  const catalogEntry = catalog.find((m) => m.id === input.target);
  if (input.source === 'marketplace' && catalogEntry && catalogEntry.implemented !== true) {
    throw new UnimplementedPluginError(catalogEntry);
  }
  // r600: a sandbox is only a sandbox if it also cuts the network. Refuse a
  // new install where it cannot, unless the operator opted in knowingly.
  if (input.source === 'sandbox' && !SandboxPlugin.networkDenied() && !sandboxNetworkOptIn()) {
    throw new SandboxNetworkUnrestrictedError();
  }
  const dynamicPlugin = createDynamicPlugin(input, catalog);

  // Check if already registered
  const existing = await db.query.installedPlugins.findFirst({
    where: eq(installedPlugins.id, dynamicPlugin.id),
  });

  assertInstallableId(dynamicPlugin.id, input, existing, kernel, catalog);

  if (existing && existing.enabled && kernel.getPlugin(dynamicPlugin.id)) {
    throw new Error(`Plugin "${dynamicPlugin.id}" is already installed and active`);
  }

  // Insert or update DB row
  await db.insert(installedPlugins).values({
    id: dynamicPlugin.id,
    name: dynamicPlugin.name,
    version: dynamicPlugin.version,
    isOfficial: !!dynamicPlugin.isOfficial,
    enabled: true,
    status: 'active',
    manifest: {
      description: dynamicPlugin.description,
      author: dynamicPlugin.author,
      source: input.source,
      target: input.target,
      // Sandbox payloads ride in the SAME JSON record so the boot restore can
      // rebuild the plugin exactly as installed. Without them, a restart
      // silently re-registered an "active" sandbox plugin with no code.
      ...(input.source === 'sandbox'
        ? { code: input.code, sandboxManifest: input.manifest }
        : {}),
    },
  }).onConflictDoUpdate({
    target: installedPlugins.id,
    // r420: the conflict arm UPDATES the stored definition too. It used to
    // flip only enabled/status — reinstalling a sandbox plugin over an
    // errored/disabled row registered the NEW instance at runtime while the
    // row kept the OLD code, so the next boot resurrected the broken one.
    set: {
      name: dynamicPlugin.name,
      version: dynamicPlugin.version,
      isOfficial: !!dynamicPlugin.isOfficial,
      enabled: true,
      status: 'active',
      error: null,
      updatedAt: new Date(),
      manifest: {
        description: dynamicPlugin.description,
        author: dynamicPlugin.author,
        source: input.source,
        target: input.target,
        ...(input.source === 'sandbox'
          ? { code: input.code, sandboxManifest: input.manifest }
          : {}),
      },
    },
  });

  // Register the FRESH instance — an already-registered runtime (a row that
  // was disabled while still loaded, pre-r420) is replaced, not kept.
  if (kernel.getPlugin(dynamicPlugin.id)) {
    await kernel.unregisterPlugin(dynamicPlugin.id);
  }
  try {
    await kernel.registerPlugin(dynamicPlugin);
  } catch (err) {
    // r235: the row was written `active` above; a plugin whose init failed
    // must not be reported (or restored at boot) as running.
    await db
      .update(installedPlugins)
      .set({ status: 'errored', error: (err as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(eq(installedPlugins.id, dynamicPlugin.id));
    throw err;
  }

  kernel.events.emit('plugin.status_changed', { pluginId: dynamicPlugin.id, status: 'active' });

  return { ok: true, id: dynamicPlugin.id, status: 'active' };
}

/**
 * r531: refuse an install whose id would shadow a built-in or take over a
 * different installed plugin's identity (and with it the `plugin:<id>:`
 * config namespace — including the secrets stored there).
 */
function assertInstallableId(
  id: string,
  input: InstallPluginInput,
  existing: typeof installedPlugins.$inferSelect | undefined | null,
  kernel: KernelContext,
  catalog: Catalog,
): void {
  if (isBuiltInPluginId(id) || (kernel.getPlugin(id) && !existing)) {
    throw new PluginIdConflictError(
      `Plugin id "${id}" is reserved by a built-in plugin. Installing it would replace that plugin and inherit ` +
        `its configuration and secrets — choose a different id.`,
    );
  }
  if (input.source === 'sandbox') {
    if (!SANDBOX_PLUGIN_ID_PATTERN.test(id)) {
      throw new PluginIdConflictError(
        `Plugin id "${id}" is not allowed: use 1–64 letters, digits, "-" or "_" (no ":" or ".", which ` +
          `separate plugin configuration and event namespaces).`,
      );
    }
    if (catalog.some((m) => m.id === id)) {
      throw new PluginIdConflictError(
        `Plugin id "${id}" is reserved by the marketplace catalog entry of the same name — choose a different id.`,
      );
    }
  }
  // Reinstalling the SAME source over its own row is the supported upgrade
  // path (r420); a different source taking an existing row's id is a takeover.
  const existingSource = (existing?.manifest as Record<string, unknown> | null | undefined)?.['source'];
  if (existing && typeof existingSource === 'string' && existingSource !== input.source) {
    throw new PluginIdConflictError(
      `Plugin id "${id}" is already used by an installed ${existingSource} plugin ("${existing.name}"). ` +
        `Uninstall it first, or install under a different id.`,
    );
  }
}

export async function uninstallPlugin(
  db: DB,
  kernel: KernelContext,
  id: string,
): Promise<{ ok: boolean; id: string }> {
  const existing = await db.query.installedPlugins.findFirst({
    where: eq(installedPlugins.id, id),
  });

  if (!existing) {
    throw new Error(`Plugin "${id}" is not installed`);
  }

  // 1. Unregister and destroy runtime plugin if loaded. r531: a row that
  // collides with a built-in id was never loaded (the boot restore refuses
  // it) — the runtime plugin under that id IS the built-in, and removing the
  // stray row must not tear it down.
  if (!isBuiltInPluginId(id)) await kernel.unregisterPlugin(id);

  // r527: uninstall is the ONE path that erases the plugin's saved config —
  // explicitly, so a plugin that was disabled (not loaded) is purged too.
  // F120: but not for a row the boot restore refuses — `plugin:<id>:` then IS
  // the built-in's namespace (or, for a ":" id, a slice of another plugin's),
  // so the purge would erase that plugin's settings, secrets and records.
  if (!bootRestoreConflict(id)) await kernel.configCenter.purgePluginConfigs(id);

  // 2. Remove DB record
  await db.delete(installedPlugins).where(eq(installedPlugins.id, id));

  return { ok: true, id };
}

/**
 * Re-register a plugin from its stored row (boot restore, enable, reload).
 * Throws when the row is unrestorable (unsupported source, sandbox row with
 * no code) — callers decide whether that is a boot warning or a 400.
 */
export async function restorePluginFromRow(
  row: typeof installedPlugins.$inferSelect,
  kernel: KernelContext,
): Promise<void> {
  // r531: enable/reload restore through here too — never over a built-in.
  const conflict = bootRestoreConflict(row.id);
  if (conflict) throw new PluginIdConflictError(conflict);
  const manifest = (row.manifest || {}) as Record<string, any>;
  const source = (manifest.source as string) || (row.isOfficial ? 'marketplace' : 'local');
  if (!isLoadableSource(source)) {
    throw new Error(
      `Plugin "${row.id}" was installed from an unsupported source ("${source}") and cannot be loaded. Uninstall it from Settings → Plugins.`,
    );
  }
  const plugin = createDynamicPlugin({
    source: source as any,
    target: (manifest.target as string) || row.id,
    name: row.name,
    version: row.version,
    // F121: installPlugin writes these into `manifest`, not the columns.
    description: row.description ?? (manifest.description as string | undefined),
    author: row.author ?? (manifest.author as string | undefined),
    icon: row.icon ?? undefined,
    configSchema: manifest.configSchema,
    menuItems: manifest.menuItems,
    dependencies: manifest.dependencies,
    // Restored sandbox payloads — written by installPlugin at install
    // time. A row from before this column carried them registers as a
    // sandbox plugin with no code, which createDynamicPlugin now
    // refuses with a pointed error instead of a silent no-op.
    code: manifest.code as string | undefined,
    manifest: manifest.sandboxManifest as Record<string, unknown> | undefined,
  });
  await kernel.registerPlugin(plugin);
}

export async function loadInstalledPlugins(db: DB, kernel: KernelContext): Promise<number> {
  const rows = await db.query.installedPlugins.findMany({
    where: eq(installedPlugins.enabled, true),
  });

  let loaded = 0;
  for (const row of rows) {
    // r531: a previously-installed plugin whose id collides with a built-in
    // (or escapes its namespace) is skipped — loudly, and with the reason on
    // its row so Settings → Plugins shows it — instead of either shadowing
    // the built-in or (as before) being skipped silently while the row kept
    // reporting `active`. Never fatal: boot continues with the rest.
    const conflict = bootRestoreConflict(row.id);
    if (conflict) {
      console.error(`[PluginLoader] ${conflict}`);
      try {
        await db
          .update(installedPlugins)
          .set({ status: 'errored', error: conflict.slice(0, 500), updatedAt: new Date() })
          .where(eq(installedPlugins.id, row.id));
      } catch (err) {
        console.error(`[PluginLoader] Could not record the conflict on plugin "${row.id}":`, err);
      }
      continue;
    }
    if (!kernel.getPlugin(row.id)) {
      try {
        await restorePluginFromRow(row, kernel);
        loaded++;
      } catch (err) {
        console.error(`[PluginLoader] Failed to restore plugin "${row.id}":`, err);
      }
    }
  }
  return loaded;
}
