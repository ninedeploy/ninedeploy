import type { DB } from '@ninedeploy/db';
import type { AppConfig } from './types.js';
import { ConfigCenter } from './configCenter.js';
import { EventBus } from './eventBus.js';
import { HookPipeline } from './hookPipeline.js';
import { MenuRegistry } from './menuRegistry.js';
import { ServiceRegistry } from './serviceRegistry.js';
import type {
  IConfigCenter,
  IEventBus,
  IHookPipeline,
  IMenuRegistry,
  IServiceRegistry,
  KernelContext,
  KernelPlugin,
  KernelState,
} from './types.js';

export class NineDeployKernel implements KernelContext {
  private _state: KernelState = 'INIT';
  readonly db: DB;
  readonly config: AppConfig;
  readonly events: IEventBus;
  readonly hooks: IHookPipeline;
  readonly registry: IServiceRegistry;
  readonly configCenter: IConfigCenter;
  readonly menuRegistry: IMenuRegistry;

  private readonly plugins = new Map<string, KernelPlugin>();
  private readonly bootOrder: string[] = [];

  constructor(db: DB, config: AppConfig) {
    this.db = db;
    this.config = config;
    this.events = new EventBus();
    this.hooks = new HookPipeline(() => this);
    this.registry = new ServiceRegistry();
    this.configCenter = new ConfigCenter(db);
    this.menuRegistry = new MenuRegistry();
  }

  get state(): KernelState {
    return this._state;
  }

  async registerPlugin(plugin: KernelPlugin): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" is already registered in the kernel`);
    }

    // 1. Register config schema definitions if provided
    if (plugin.configSchema) {
      for (const def of plugin.configSchema) {
        const fullKey = def.key.startsWith(`plugin:${plugin.id}:`)
          ? def.key
          : `plugin:${plugin.id}:${def.key}`;
        this.configCenter.registerDefinition({
          ...def,
          key: fullKey,
          pluginId: plugin.id,
          category: def.category || `plugin:${plugin.id}`,
        });
      }
    }

    // 2. Register navigation menu items if provided
    if (plugin.menuItems) {
      for (const item of plugin.menuItems) {
        this.menuRegistry.registerMenuItem({
          ...item,
          pluginId: plugin.id,
        });
      }
    }

    // 3. Initialize plugin
    this.plugins.set(plugin.id, plugin);
    this.bootOrder.push(plugin.id);

    try {
      await plugin.init(this);
    } catch (err) {
      // r235: a plugin whose init failed is not installed. It used to stay in
      // the plugin map and boot order — reported active, its reinstall refused
      // as "already installed", its onReady still run at boot, and any bus
      // listener it had registered leaked. Undo what registration did.
      // F254: a destroy() that threw synchronously escaped the former
      // `Promise.resolve(plugin.destroy(this)).catch()` and skipped the cleanup.
      try {
        await plugin.destroy?.(this);
      } catch {
        // best effort — the init failure is what the caller must see
      }
      // F253: only while this instance still owns the id — a reload that
      // replaced it during init must not lose the new instance's entry/menus.
      if (this.plugins.get(plugin.id) === plugin) {
        this.menuRegistry.purgePluginMenus(plugin.id);
        // r527: the operator's saved config (secrets included) survives a failed
        // init — the usual cause is a transient one (an unreachable endpoint at
        // boot), and purging here made the next restart start the plugin from
        // empty settings. Only an uninstall erases config (pluginLoader).
        this.plugins.delete(plugin.id);
        const idx = this.bootOrder.indexOf(plugin.id);
        if (idx >= 0) this.bootOrder.splice(idx, 1);
        this.events.emit('plugin.status_changed', { pluginId: plugin.id, status: 'errored' });
      }
      throw new Error(`Failed to initialize plugin "${plugin.id}": ${(err as Error).message}`);
    }
    // F253: unregistered (disable), replaced (reload) or the kernel shut down
    // while init was in flight. The earlier destroy() ran on a half-initialised
    // instance, so whatever init registered after it would leak: tear it down
    // again and report the registration as not having taken effect.
    if (this.plugins.get(plugin.id) !== plugin || this._state === 'DRAINING' || this._state === 'TERMINATED') {
      try {
        await plugin.destroy?.(this);
      } catch {
        // best effort — the stale registration is refused either way
      }
      throw new Error(`Plugin "${plugin.id}" was unregistered while it was initializing`);
    }
    this.events.emit('plugin.registered', { pluginId: plugin.id, version: plugin.version });
  }

  async unregisterPlugin(id: string): Promise<boolean> {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      return false;
    }

    if (plugin.destroy) {
      try {
        await plugin.destroy(this);
      } catch (err) {
        console.error(`[NineDeployKernel] Error in destroy for plugin "${id}":`, err);
      }
    }

    this.menuRegistry.purgePluginMenus(id);
    // r527: unregistering is a RUNTIME teardown — disable, reload and a
    // reinstall over a loaded instance all go through here — so it no longer
    // purges the plugin's stored config. Disabling a plugin used to erase its
    // saved settings and secrets; `uninstallPlugin` purges explicitly.

    this.plugins.delete(id);
    const idx = this.bootOrder.indexOf(id);
    this.bootOrder.splice(idx, 1);

    this.events.emit('plugin.status_changed', { pluginId: id, status: 'disabled' });
    return true;
  }

  getPlugin(id: string): KernelPlugin | undefined {
    return this.plugins.get(id);
  }

  listPlugins(): KernelPlugin[] {
    return Array.from(this.plugins.values());
  }

  async boot(): Promise<void> {
    if (this._state !== 'INIT') {
      throw new Error(`Cannot boot kernel from state "${this._state}"`);
    }

    this._state = 'BOOTSTRAP';

    // Topological dependency sort
    const resolvedOrder = this.resolveDependencyOrder();

    for (const pluginId of resolvedOrder) {
      const plugin = this.plugins.get(pluginId)!;
      if (plugin.onReady) {
        try {
          await plugin.onReady(this);
          this.events.emit('plugin.status_changed', { pluginId, status: 'active' });
        } catch (err) {
          console.error(`[NineDeployKernel] Error in onReady for plugin "${pluginId}":`, err);
          this.events.emit('plugin.status_changed', { pluginId, status: 'errored' });
        }
      }
    }

    this._state = 'READY';
  }

  async shutdown(): Promise<void> {
    if (this._state === 'TERMINATED' || this._state === 'DRAINING') {
      return;
    }

    this._state = 'DRAINING';

    // Shutdown plugins in reverse boot order
    const reverseOrder = [...this.bootOrder].reverse();
    for (const pluginId of reverseOrder) {
      const plugin = this.plugins.get(pluginId);
      if (plugin && plugin.onShutdown) {
        try {
          await plugin.onShutdown(this);
        } catch (err) {
          console.error(`[NineDeployKernel] Error in onShutdown for plugin "${pluginId}":`, err);
        }
      }
      // F252: destroy() is the teardown plugins actually implement (a sandbox
      // plugin's SHUTDOWN + worker/child termination). Only unregisterPlugin
      // called it, so a panel shutdown left every sandbox runtime running.
      if (plugin?.destroy) {
        try {
          await plugin.destroy(this);
        } catch (err) {
          console.error(`[NineDeployKernel] Error in destroy for plugin "${pluginId}":`, err);
        }
      }
    }

    this.events.removeAllListeners();
    this.hooks.clear();
    this.registry.clear();

    this._state = 'TERMINATED';
  }

  private resolveDependencyOrder(): string[] {
    const visited = new Set<string>();
    const order: string[] = [];
    const visiting = new Set<string>();

    // r236: one plugin with a missing or circular dependency used to throw out
    // of boot() — no plugin's onReady ran and the kernel stayed in BOOTSTRAP.
    // Such a plugin (and anything depending on it) is now skipped, loudly.
    const broken = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected involving plugin "${id}"`);
      }
      if (!visited.has(id)) {
        visiting.add(id);
        const plugin = this.plugins.get(id);
        if (plugin?.dependencies) {
          for (const dep of plugin.dependencies) {
            if (!this.plugins.has(dep)) {
              throw new Error(`Plugin "${id}" requires missing dependency "${dep}"`);
            }
            visit(dep);
          }
        }
        visiting.delete(id);
        visited.add(id);
        order.push(id);
      }
    };

    for (const id of this.bootOrder) {
      try {
        visit(id);
      } catch (err) {
        for (const v of visiting) broken.add(v);
        visiting.clear();
        broken.add(id);
        console.error(`[NineDeployKernel] Skipping plugin "${id}" at boot:`, (err as Error).message);
      }
    }
    for (const id of broken) this.events.emit('plugin.status_changed', { pluginId: id, status: 'errored' });
    return order.filter((id) => !broken.has(id));
  }
}
