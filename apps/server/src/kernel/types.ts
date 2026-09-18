import type { DB, Database, Domain, Service } from '@ninedeploy/db';
import type { config } from '../config.js';

export type AppConfig = typeof config;

export type KernelState = 'INIT' | 'BOOTSTRAP' | 'READY' | 'DRAINING' | 'TERMINATED';

// ─── Domain Events (Asynchronous Pub/Sub) ──────────────────────────────────
export interface DomainEvents {
  // Service lifecycle
  'service.created': { serviceId: number; projectId: number; name: string };
  // r239: emitted by the deploy pipeline. `projectId` is the service's first
  // linked project (services are N-N with projects); `projectIds` lists all.
  'service.deploying': { serviceId: number; deployId: number; projectId?: number; projectIds?: number[] };
  'service.deployed': {
    serviceId: number;
    deployId: number;
    status: 'success' | 'failed';
    projectId?: number;
    projectIds?: number[];
  };
  'service.stopped': { serviceId: number };
  'service.deleted': { serviceId: number; name: string };

  // Database lifecycle
  'database.created': { databaseId: number; projectId: number; name: string; engine: string };
  'database.started': { databaseId: number };
  'database.stopped': { databaseId: number };
  'database.deleted': { databaseId: number; name: string; volumeRetained: boolean };
  'database.backup_completed': { databaseId: number; sizeBytes: number; remoteUploaded: boolean };
  'database.backup_failed': { databaseId: number; error: string };

  // Server & Edge Agents
  'server.announced': { serverId: number; name: string; host: string; port: number };
  'server.connected': { serverId: number; host: string };
  'server.disconnected': { serverId: number; reason: string };
  'server.approved': { serverId: number; approvedByUserId: number };
  'server.rejected': { serverId: number };

  // Alerts & Notifications
  'alert.triggered': { title: string; message: string; level: 'info' | 'warn' | 'error'; serviceId?: number };
  'notification.sent': { channelId: number; type: string; success: boolean };
  'notification.queued': { title: string; body: string; level: 'info' | 'warn' | 'error' };

  // Configuration & Plugins
  'config.changed': { key: string; isSecret: boolean; pluginId: string | null };
  'plugin.registered': { pluginId: string; version: string };
  'plugin.status_changed': { pluginId: string; status: 'active' | 'disabled' | 'errored' };
  'plugin.reloaded': { pluginId: string; status: 'active' | 'disabled' | 'errored' };

  // The raw audit firehose, bridged from `lib/events.ts` (see
  // `kernel/auditBridge.ts`). Every `audit()` call reaches plugins here, so a
  // plugin can observe anything without the bridge needing a mapping for it.
  'audit.recorded': { action: string; entity: string | null; actorUserId: number | null; ts: string };

  // Plugin Ecosystem Events
  'deployment.status_changed': { deploymentId?: number; status?: string; serviceName?: string };
  'service.health_changed': { serviceId?: number; status?: string };
  'backup.completed': { databaseId?: number; sizeBytes?: number };
  'tunnel.route_evaluated': { serviceId?: number; domain?: string };
  'telemetry.recorded': { sourceEvent: string; timestamp: string; data: unknown };
  'custom.system_event': Record<string, unknown>;
}

// ─── Sequential Hook Definitions (Synchronous Interceptors) ────────────────
export interface HookDefinitions {
  // Deploy pipeline hooks
  'deploy:before': { service: Service; targetCommit?: string };
  'deploy:build_complete': { service: Service; imageTag: string; durationMs: number };
  'deploy:healthcheck': { service: Service; containerId: string; healthy: boolean };
  'deploy:after': { service: Service; deployId: number; success: boolean };
  'deploy.after': { serviceId?: number; domain?: string };

  // Database safety hooks
  'database:before_delete': { database: Database; allowOrAbort: boolean; reason?: string };
  'database:after_create': { database: Database; volumeName: string };

  // Proxy & Route hooks
  'proxy:sync_routes': { domains: Domain[]; services: Service[] };

  // Server announce hook
  'server:before_announce': { name: string; host?: string; port: number; token: string };
}

// ─── Event Bus Interface ───────────────────────────────────────────────────
export interface IEventBus {
  emit<K extends keyof DomainEvents>(event: K, payload: DomainEvents[K]): void;
  emitCustom(event: string, payload: unknown): void;
  on<K extends keyof DomainEvents>(event: K, listener: (payload: DomainEvents[K]) => Promise<void> | void): () => void;
  /** A `'*'` listener also receives the concrete event name as its second argument. */
  onCustom(event: string, listener: (payload: unknown, event?: string) => Promise<void> | void): () => void;
  once<K extends keyof DomainEvents>(event: K, listener: (payload: DomainEvents[K]) => Promise<void> | void): () => void;
  listenerCount(event: string): number;
  removeAllListeners(event?: string): void;
}

// ─── Hook Pipeline Interface ───────────────────────────────────────────────
export interface IHookPipeline {
  tap<K extends keyof HookDefinitions>(
    hook: K,
    handler: (payload: HookDefinitions[K], ctx: KernelContext) => Promise<undefined | HookDefinitions[K]>,
    opts?: {
      priority?: number;
      id?: string;
      timeoutMs?: number;
      rollback?: (payload: HookDefinitions[K], ctx: KernelContext, error?: Error) => Promise<void> | void;
    },
  ): () => void;
  call<K extends keyof HookDefinitions>(hook: K, payload: HookDefinitions[K]): Promise<HookDefinitions[K]>;
  hasListeners(hook: string): boolean;
  clear(): void;
}

// ─── Service & Driver Registry ─────────────────────────────────────────────
export interface IServiceRegistry {
  register<T>(name: string, service: T): void;
  get<T>(name: string): T;
  getOptional<T>(name: string): T | undefined;
  has(name: string): boolean;
  unregister(name: string): boolean;
  clear(): void;

  registerCompute(driver: IComputeDriver): void;
  getCompute(name: string): IComputeDriver | undefined;
  registerProxy(driver: IProxyDriver): void;
  getProxy(name: string): IProxyDriver | undefined;
  registerStorage(driver: IStorageDriver): void;
  getStorage(name: string): IStorageDriver | undefined;
  registerDomainProvider(driver: IDomainProvider): void;
  getDomainProvider(name: string): IDomainProvider | undefined;
  listDomainProviders(): IDomainProvider[];

  registerBuildCache(driver: IBuildCache): void;
  getBuildCache(name: string): IBuildCache | undefined;
  listBuildCaches(): IBuildCache[];

  registerOrchestrator(driver: IOrchestrator): void;
  getOrchestrator(name: string): IOrchestrator | undefined;
  listOrchestrators(): IOrchestrator[];

  registerEgressIpDriver(driver: IEgressIpDriver): void;
  getEgressIpDriver(name: string): IEgressIpDriver | undefined;
  listEgressIpDrivers(): IEgressIpDriver[];
}

// ─── Configuration Center (Dual-Vault: Public & Secrets) ───────────────────
export interface ConfigDefinition<T = unknown> {
  key: string;
  pluginId?: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'json';
  isSecret: boolean;
  label: string;
  description?: string;
  category?: string;
  tags?: string[];
  defaultValue?: T;
  options?: string[];
  required?: boolean;
}

export interface IScopedConfig {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T>;
  getSecret(key: string): Promise<string | null>;
  set<T = unknown>(key: string, value: T, opts?: { isSecret?: boolean; description?: string; tags?: string[] }): Promise<void>;
  watch(key: string, callback: (newVal: unknown) => void): () => void;
}

export interface IConfigCenter {
  registerDefinition(def: ConfigDefinition): void;
  getDefinition(key: string): ConfigDefinition | undefined;
  listDefinitions(category?: string, pluginId?: string): ConfigDefinition[];
  get<T = unknown>(key: string, defaultValue?: T): Promise<T>;
  getSecret(key: string): Promise<string | null>;
  set<T = unknown>(
    key: string,
    value: T,
    opts?: { isSecret?: boolean; category?: string; pluginId?: string; description?: string; tags?: string[]; userId?: number },
  ): Promise<void>;
  delete(key: string): Promise<boolean>;
  watch(key: string, callback: (newVal: unknown) => void): () => void;
  purgePluginConfigs(pluginId: string): Promise<number>;
  createScopedConfig(pluginId: string): IScopedConfig;
}

// ─── Menu & Navigation Registry ────────────────────────────────────────────
export type MenuSlot =
  | 'sidebar:main'
  | 'sidebar:secondary'
  | 'service:tabs'
  | 'database:tabs'
  | 'settings:nav'
  | 'command:palette'
  | 'user:menu'
  | 'dashboard:overview'
  | 'service:overview:widget'
  | 'monitoring:widgets';

export interface MenuItemDefinition {
  id: string;
  pluginId?: string;
  slot: MenuSlot;
  label: string;
  route: string;
  icon?: string;
  order?: number;
  title?: string;
  description?: string;
  component?: string;
  props?: Record<string, unknown>;
  badge?: {
    text: string;
    variant?: 'default' | 'success' | 'warning' | 'info';
  };
  permission?: 'admin' | 'member';
}

export interface IMenuRegistry {
  registerMenuItem(item: MenuItemDefinition): () => void;
  unregisterMenuItem(id: string): boolean;
  /**
   * @param isOperator true when the caller is owner/admin in at least one
   * workspace. Replaces the legacy `userRole: 'admin' | 'member'` parameter
   * — the global role enum is gone, plugin menu gating now keys off the
   * boolean operator flag.
   */
  getItemsForSlot(slot: MenuSlot, isOperator?: boolean): MenuItemDefinition[];
  getAllItems(): MenuItemDefinition[];
  getPluginMenus(pluginId: string): MenuItemDefinition[];
  purgePluginMenus(pluginId: string): number;
}

// ─── Compute, Proxy & Storage Driver Interfaces ────────────────────────────
export interface IComputeDriver {
  readonly name: string;
  pullImage(image: string, onLog: (l: string) => void): Promise<void>;
  runContainer(opts: { name: string; image: string; network?: string; envFile?: string; volume?: string; mount?: string; cpuShares?: string; cpuLimitMilli?: string; memLimitMb?: string }): Promise<void>;
  stopContainer(name: string, timeoutSec?: number): Promise<void>;
  removeContainer(name: string): Promise<void>;
  inspectContainer(name: string): Promise<{ status: string; ipAddress?: string; image?: string }>;
  getLogs(name: string, tail?: number): Promise<string[]>;
}

export interface IProxyDriver {
  readonly name: string;
  syncConfiguration(domains: Domain[], services: Service[]): Promise<void>;
  reload(): Promise<void>;
  getCertificateStatus(): Promise<Array<{ domain: string; valid: boolean; expiresAt?: string }>>;
}

export interface IStorageDriver {
  readonly name: string;
  upload(localPath: string, remoteKey: string): Promise<void>;
  download(remoteKey: string, localDestPath: string): Promise<void>;
  delete(remoteKey: string): Promise<void>;
}

// ─── Build Cache (Docker BuildKit-style layer cache) ──────────────────────
// A `IBuildCache` wraps a single layer-blob store (in-memory LRU today,
// registry pull/push tomorrow, S3 the day after). Mirrors the
// `IComputeDriver` / `IStorageDriver` pattern — registered on the
// kernel's `IServiceRegistry` and looked up by stable name. PR #15
// (G-01 PR-A) ships the contract + the in-memory reference driver;
// Sprint 4 (PR #16–#18) wires BuildKit, registry and S3 backends.
export interface BlobRef {
  /** Stable digest (sha256:hex) of the cached blob. Acts as the cache key
   *  suffix when the cache splits blobs across multiple storage backends. */
  digest: string;
  /** Total size of the blob in bytes. Backends use this to enforce the
   *  configured budget; plugins surface it in stats. */
  sizeBytes: number;
  /** When the blob was first stored. Used by the LRU eviction policy. */
  storedAt: string;
}

export interface IBuildCache {
  readonly name: string;
  /**
   * Look up a blob by its cache key. Returns the existing `BlobRef` if
   * the backend already holds the bytes, or `null` on a miss. MUST NOT
   * throw on a missing key — a miss is the common case, not an error.
   */
  lookup(key: string): Promise<BlobRef | null>;
  /**
   * Store a blob. Returns the `BlobRef` the backend will hand out for
   * subsequent lookups. Backends are free to deduplicate (same digest
   * twice = single copy) and to evict when the budget is exceeded; the
   * contract guarantees only that the returned ref is valid for
   * `lookup()` on the same key.
   */
  store(key: string, blob: Buffer | Uint8Array): Promise<BlobRef>;
  /**
   * Aggregate stats for the `/v1/build-cache/stats` HTTP surface and
   * the `ninedeploy build-cache stats` CLI command. Backends report
   * their own counters; the plugin merges them across all registered
   * caches when it emits `build.cache.stats`.
   */
  stats(): Promise<{
    entries: number;
    totalBytes: number;
    hits: number;
    misses: number;
    stores: number;
    evictions: number;
  }>;
}

// ─── Orchestrator (multi-node service graph) ─────────────────────────────
// An `IOrchestrator` wraps a single multi-node deploy target (local
// Docker today, Docker Swarm in PR #21, Kubernetes in a future
// sprint). Mirrors the `IComputeDriver` / `IStorageDriver` /
// `IDomainProvider` pattern — registered on the kernel's
// `IServiceRegistry` and looked up by stable name. The contract is
// a single object — `StackSpec` — so a local driver, a Swarm
// driver, and a future k8s driver can all consume the same
// pipeline output.
export interface StackSpec {
  /** Stable stack name. Used as the prefix for all service / network /
   *  secret / config identifiers so two stacks on the same orchestrator
   *  never collide. */
  name: string;
  /** Each service the stack should run. */
  services: StackServiceSpec[];
  /** Networks the stack creates + the services that attach to each. */
  networks: StackNetworkSpec[];
  /** Secrets mounted as files into one or more services. */
  secrets: StackSecretSpec[];
  /** Configs (non-sensitive) mounted as files into one or more services. */
  configs: StackConfigSpec[];
  /** Optional volumes shared across services in the stack. */
  volumes: StackVolumeSpec[];
}

export interface StackServiceSpec {
  /** Stable service name within the stack (e.g. "web", "api"). */
  name: string;
  /** Image reference (tag, repo@sha256, or digest). */
  image: string;
  /** Number of replicas (>= 1). The local driver collapses to 1. */
  replicas: number;
  /** Container port the service exposes. */
  port: number | null;
  /** Environment variables — secret values are referenced by `secretRef`. */
  env: Record<string, string>;
  /** Names of networks (from `StackSpec.networks`) this service attaches to. */
  networks: string[];
  /** Names of secrets (from `StackSpec.secrets`) this service mounts. */
  secrets: string[];
  /** Names of configs (from `StackSpec.configs`) this service mounts. */
  configs: string[];
  /** Optional per-service healthcheck path (HTTP GET). */
  healthPath?: string;
  /** Optional Docker labels — used by the local driver for Traefik routing. */
  labels: Record<string, string>;
}

export interface StackNetworkSpec {
  name: string;
  driver: 'bridge' | 'overlay';
  attachable: boolean;
}

export interface StackSecretSpec {
  name: string;
  data: string; // plain text; encrypted at rest by the orchestrator driver
}

export interface StackConfigSpec {
  name: string;
  data: string;
}

export interface StackVolumeSpec {
  name: string;
}

export interface StackStatus {
  name: string;
  /** Per-service snapshot. The local driver reports a single "running" /
   *  "stopped" line; Swarm reports the per-replica count. */
  services: Array<{ name: string; state: 'running' | 'stopped' | 'partial' | 'unknown'; replicas: number }>;
  /** When the stack was last applied. ISO 8601. */
  appliedAt: string;
}

// ─── Egress IP Driver (G-15) ────────────────────────────────────────────
// A `IEgressIpDriver` attaches a stable outbound IP to one or more
// containers in a project so the project's outbound traffic is
// distinguishable in upstream logs and reputation systems. Mirrors
// the other typed-driver contracts — registered on the kernel's
// `IServiceRegistry` and looked up by stable name. PR #22 ships the
// interface + the iptables reference driver; Sprint 6 will add
// cloud-specific drivers (AWS NAT gateway allocation, GCP static IP
// reservation, …).
export interface EgressIpSelector {
  /** Stable project id the rule applies to. */
  projectId: number;
  /**
   * Source CIDR the rule rewrites. When omitted the iptables driver
   * resolves the subnets of the project's service bridges
   * (`nd-svc-<slug>`, one per service) — r240.
   */
  sourceCidr?: string;
}

export interface EgressIpRule {
  selector: EgressIpSelector;
  /** Outbound IP the rule SNATs to. */
  ip: string;
  /** When the rule was created. ISO 8601. */
  createdAt: string;
  /**
   * r240: the source CIDRs the rule was actually applied to. Stored so a
   * detach (or a reboot re-apply) removes exactly what attach added, even
   * after the project's networks changed.
   */
  sourceCidrs?: string[];
}

export interface IEgressIpDriver {
  readonly name: string;
  /** Apply the SNAT rule. Idempotent on duplicate (project, ip) — the
   *  driver should treat a re-apply as a no-op. Never throws on a
   *  missing iptables / kernel module; surfaces a `metric.egress.unavailable`
   *  event instead. */
  attach(selector: EgressIpSelector, ip: string): Promise<EgressIpRule>;
  /** Remove the rule. Idempotent on missing. */
  detach(selector: EgressIpSelector): Promise<void>;
  /** Every rule the driver currently manages, in any order. */
  list(): Promise<EgressIpRule[]>;
}

export interface IOrchestrator {
  readonly name: string;
  /** Translate a `StackSpec` into a deployable form, apply it, and
   *  return the resulting status. The local driver renders the spec
   *  into a single docker compose file + a set of `docker run` invocations. */
  deployStack(stack: StackSpec): Promise<StackStatus>;
  /** Remove every resource the stack created. Idempotent on missing. */
  removeStack(name: string): Promise<void>;
  /** Stable snapshot of every stack this orchestrator knows about. */
  listStacks(): Promise<Array<{ name: string; serviceCount: number }>>;
  /** Status for one stack, or `null` if the orchestrator has no record of it. */
  getStackStatus(name: string): Promise<StackStatus | null>;
}

// ─── Domain Provider (DNS automation) ─────────────────────────────────────
// A `IDomainProvider` wraps a single DNS vendor (Cloudflare, Route53, DNSSimple,
// Namecheap, …) behind one shape so plugins and modules can drive any of them
// without hardcoding the vendor SDK. Mirrors the `IComputeDriver` /
// `IProxyDriver` / `IStorageDriver` pattern — registered on the kernel's
// `IServiceRegistry` and looked up by stable name.
export interface DomainZone {
  id: string;
  name: string;
}

export type DomainRecordType = 'A' | 'CNAME' | 'TXT' | 'AAAA';

export interface DomainRecordSpec {
  hostname: string;
  type: DomainRecordType;
  content: string;
  /** TTL in seconds. `1` means "automatic" on most providers. */
  ttl?: number;
  /** Cloudflare's `proxied` flag — has no meaning on providers that don't proxy. */
  proxied?: boolean;
}

export interface DomainRecordResult {
  recordId: string;
  hostname: string;
  type: DomainRecordType;
}

export interface IDomainProvider {
  readonly name: string;
  /** Every zone the configured credentials can see. Used by UIs to let the
   *  user pick which zone a record should land in. */
  listZones(): Promise<DomainZone[]>;
  /** Resolve the most specific zone that owns `hostname` (longest suffix
   *  match — `dev.example.com` must win over `example.com`). */
  findZoneForHost(hostname: string): Promise<DomainZone | null>;
  /** Create a record under `zoneId`. Returns the provider-side id so the
   *  caller can later delete or update it. */
  createRecord(zoneId: string, spec: DomainRecordSpec): Promise<DomainRecordResult>;
  /** Delete a record by id. Providers may differ in idempotency: this method
   *  is best-effort and must NOT throw on "not found". */
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
}

// ─── Kernel Plugin & Context ───────────────────────────────────────────────
export interface KernelPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly icon?: string;
  readonly isOfficial?: boolean;
  readonly dependencies?: string[];
  readonly configSchema?: ConfigDefinition[];
  readonly menuItems?: MenuItemDefinition[];

  init(ctx: KernelContext): Promise<void> | void;
  onReady?(ctx: KernelContext): Promise<void> | void;
  onShutdown?(ctx: KernelContext): Promise<void> | void;
  destroy?(ctx: KernelContext): Promise<void> | void;
}

export interface KernelContext {
  readonly state: KernelState;
  readonly db: DB;
  readonly config: AppConfig;
  readonly events: IEventBus;
  readonly hooks: IHookPipeline;
  readonly registry: IServiceRegistry;
  readonly configCenter: IConfigCenter;
  readonly menuRegistry: IMenuRegistry;

  registerPlugin(plugin: KernelPlugin): Promise<void>;
  unregisterPlugin(id: string): Promise<boolean>;
  getPlugin(id: string): KernelPlugin | undefined;
  listPlugins(): KernelPlugin[];
  boot(): Promise<void>;
  shutdown(): Promise<void>;
}
