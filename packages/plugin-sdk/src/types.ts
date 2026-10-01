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
  permission?: 'admin' | 'member';
  title?: string;
  description?: string;
  badge?: string;
  component?: string;
  props?: Record<string, unknown>;
}

export interface ConfigSchemaDefinition<T = unknown> {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'json';
  isSecret: boolean;
  label: string;
  category?: string;
  description?: string;
  tags?: string[];
  options?: string[];
  defaultValue?: T;
  required?: boolean;
}

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ScopedConfigAccessor {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T>;
  getSecret(key: string): Promise<string | null>;
  set(
    key: string,
    value: unknown,
    options?: { isSecret?: boolean; description?: string; tags?: string[] },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Options for `ctx.tapHook`. r473: only `priority` is honoured by the host —
 * the pipeline applies its own per-tap budget (5 s) and rejection-based
 * rollback, so per-tap timeout/rollback/id options that previous type
 * declarations promised were silently dropped and have been removed.
 */
export interface TapHookOptions {
  priority?: number;
}

export interface PluginContext {
  pluginId: string;
  config: ScopedConfigAccessor;
  logger: PluginLogger;
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: (payload: unknown) => void | Promise<void>): () => void;
  tapHook(
    hookName: string,
    fn: (context: unknown) => unknown | Promise<unknown>,
    optsOrPriority?: number | TapHookOptions,
  ): () => void;
}

export interface PluginDefinition {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  isOfficial?: boolean;
  /** Declared on the object your code RETURNS (r473: honoured at READY, with the install manifest as fallback). */
  dependencies?: string[];
  /** Declared on the object your code RETURNS — registers the plugin's Settings fields (r473: honoured at READY). */
  configSchema?: ConfigSchemaDefinition[];
  /** Declared on the object your code RETURNS — registers menu entries (r473: honoured at READY). */
  menuItems?: Omit<MenuItemDefinition, 'pluginId'>[];

  /** Called once after the plugin code is evaluated. */
  init?(ctx: PluginContext): Promise<void> | void;
  /**
   * Called on plugin disable/uninstall/reload. r473: `start`/`stop` hooks
   * were removed from this interface — the runtime only ever called init and
   * destroy, and a lifecycle hook that silently never runs is worse than an
   * honest type.
   */
  destroy?(ctx?: PluginContext): Promise<void> | void;
}
