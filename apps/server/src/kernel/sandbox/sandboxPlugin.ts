import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { KernelContext, KernelPlugin } from '../types.js';
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol.js';

/**
 * Matches the hook pipeline's default per-tap budget (5000ms): whichever
 * fires first recovers the caller, and this one additionally drains the
 * stale pendingHookCalls entry.
 */
const HOOK_REPLY_TIMEOUT_MS = 5000;

export interface SandboxPluginOptions {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  icon?: string;
  code?: string;
  manifest?: Record<string, unknown>;
  workerPath?: string;
}

export class SandboxPlugin implements KernelPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly icon?: string;
  readonly isOfficial = false;

  configSchema?: any[];
  menuItems?: any[];
  dependencies?: string[];

  private worker?: Worker;
  private readonly code?: string;
  private readonly manifest?: Record<string, unknown>;
  private readonly workerPath?: string;
  private readonly unsubs: Array<() => void> = [];
  private readonly pendingHookCalls = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();

  constructor(opts: SandboxPluginOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.version = opts.version || '1.0.0';
    this.description = opts.description;
    this.author = opts.author || 'Community Contributor';
    this.icon = opts.icon ?? 'Package';
    this.code = opts.code;
    this.manifest = opts.manifest;
    this.workerPath = opts.workerPath;
  }

  async init(ctx: KernelContext): Promise<void> {
    const defaultBootstrapPath = join(
      dirname(fileURLToPath(import.meta.url)),
      'workerBootstrap.js',
    );
    const targetScript = this.workerPath || defaultBootstrapPath;

    // Launch worker thread with resource limits if supported
    this.worker = new Worker(targetScript, {
      resourceLimits: {
        maxYoungGenerationSizeMb: 16,
        maxOldGenerationSizeMb: 64,
      },
    });

    const send = (msg: MainToWorkerMessage) => {
      this.worker?.postMessage(msg);
    };

    // Forward system events to worker
    const eventForwarder = (event: string, data: unknown) => {
      send({ type: 'EVENT', payload: { event, data } });
    };

    // Listen to kernel events and relay to worker
    this.unsubs.push(
      // r234: the bus hands a wildcard listener the concrete event name. It
      // used to be dropped and every event relayed as `custom.system_event`,
      // so a sandbox `ctx.on('deployment.status_changed', …)` never fired.
      ctx.events.onCustom('*', (payload, event) => {
        eventForwarder(event ?? 'custom.system_event', payload);
      }),
    );

    return new Promise((resolve, reject) => {
      let isResolved = false;

      const initTimeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          this.terminate();
          reject(new Error(`Sandbox plugin "${this.id}" timed out during initialization`));
        }
      }, 10000);

      this.worker!.on('message', async (msg: WorkerToMainMessage) => {
        try {
          switch (msg.type) {
            case 'READY': {
              if (msg.payload.configSchema) {
                this.configSchema = msg.payload.configSchema;
                for (const def of msg.payload.configSchema) {
                  const fullKey = def.key.startsWith(`plugin:${this.id}:`) ? def.key : `plugin:${this.id}:${def.key}`;
                  ctx.configCenter.registerDefinition({
                    ...def,
                    key: fullKey,
                    pluginId: this.id,
                    category: def.category || `plugin:${this.id}`,
                  });
                }
              }
              if (msg.payload.menuItems) {
                this.menuItems = msg.payload.menuItems;
                for (const item of msg.payload.menuItems) {
                  ctx.menuRegistry.registerMenuItem({
                    ...item,
                    pluginId: this.id,
                  });
                }
              }
              if (msg.payload.dependencies) this.dependencies = msg.payload.dependencies;

              if (!isResolved) {
                isResolved = true;
                clearTimeout(initTimeout);
                resolve();
              }
              break;
            }

            case 'LOG': {
              const { level, message } = msg.payload;
              if (level === 'error') console.error(`[Sandbox:${this.id}]`, message);
              else if (level === 'warn') console.warn(`[Sandbox:${this.id}]`, message);
              else console.log(`[Sandbox:${this.id}]`, message);
              break;
            }

            case 'EMIT_EVENT': {
              const { event, data } = msg.payload;
              ctx.events.emitCustom(event, data);
              break;
            }

            case 'REGISTER_HOOK': {
              const { hookId, hookName, priority } = msg.payload;
              const unhook = ctx.hooks.tap(
                hookName as any,
                async (payload) => {
                  return new Promise((res, rej) => {
                    // Mirrors the pipeline's own 5s per-tap budget: when it
                    // fires first the pipeline recovers, and this cleanup
                    // makes sure a wedged worker cannot leave the entry in
                    // pendingHookCalls forever (entries are keyed by hookId,
                    // so a stale one would also poison the NEXT call). The
                    // worker protocol carries one id per registration, so
                    // truly CONCURRENT invocations of the same hook still
                    // serialize through this map — a protocol-level limit.
                    const timer = setTimeout(() => {
                      this.pendingHookCalls.delete(hookId);
                      rej(new Error(`Sandbox plugin "${this.id}" did not answer hook "${hookName}" in time`));
                    }, HOOK_REPLY_TIMEOUT_MS);
                    this.pendingHookCalls.set(hookId, {
                      resolve: (value) => {
                        clearTimeout(timer);
                        res(value);
                      },
                      reject: (err) => {
                        clearTimeout(timer);
                        rej(err);
                      },
                    });
                    send({ type: 'HOOK_CALL', payload: { hookId, hookName, initialPayload: payload } });
                  });
                },
                { id: `sandbox:${this.id}:${hookId}`, priority },
              );
              this.unsubs.push(unhook);
              break;
            }

            case 'HOOK_RESPONSE': {
              const { hookId, result, error } = msg.payload;
              const pending = this.pendingHookCalls.get(hookId);
              if (pending) {
                this.pendingHookCalls.delete(hookId);
                if (error) pending.reject(new Error(error));
                else pending.resolve(result);
              }
              break;
            }

            case 'CONFIG_GET': {
              const { reqId, key, defaultValue, isSecret } = msg.payload;
              try {
                const namespacedKey = key.startsWith(`plugin:${this.id}:`) ? key : `plugin:${this.id}:${key}`;
                const val = isSecret
                  ? await ctx.configCenter.getSecret(namespacedKey)
                  : await ctx.configCenter.get(namespacedKey, defaultValue);
                send({ type: 'CONFIG_RESPONSE', payload: { reqId, value: val } });
              } catch (cfgErr) {
                send({ type: 'CONFIG_RESPONSE', payload: { reqId, error: (cfgErr as Error).message } });
              }
              break;
            }

            case 'CONFIG_SET': {
              const { key, value, options } = msg.payload;
              const namespacedKey = key.startsWith(`plugin:${this.id}:`) ? key : `plugin:${this.id}:${key}`;
              if (value === null) {
                await ctx.configCenter.delete(namespacedKey);
              } else {
                await ctx.configCenter.set(namespacedKey, value, options);
              }
              break;
            }

            case 'STATUS_CHANGED': {
              ctx.events.emit('plugin.status_changed', {
                pluginId: this.id,
                status: msg.payload.status,
              });
              break;
            }

            case 'ERROR': {
              console.error(`[Sandbox:${this.id}] Worker reported error:`, msg.payload.error);
              ctx.events.emit('plugin.status_changed', { pluginId: this.id, status: 'errored' });
              break;
            }
          }
        } catch (dispatchErr) {
          console.error(`[Sandbox:${this.id}] Error handling worker message:`, dispatchErr);
        }
      });

      this.worker!.on('error', (err) => {
        console.error(`[Sandbox:${this.id}] Worker fatal error:`, err);
        ctx.events.emit('plugin.status_changed', { pluginId: this.id, status: 'errored' });
        
        // Immediately reject any in-flight hook promises to trigger hook pipeline rollback without waiting for timeout
        const failure = err instanceof Error ? err : new Error(String(err));
        for (const pending of Array.from(this.pendingHookCalls.values())) {
          pending.reject(failure);
        }
        this.pendingHookCalls.clear();

        if (!isResolved) {
          isResolved = true;
          clearTimeout(initTimeout);
          reject(failure);
        }
      });

      this.worker!.on('exit', (code) => {
        if (code !== 0) {
          console.warn(`[Sandbox:${this.id}] Worker exited with code ${code}`);
          ctx.events.emit('plugin.status_changed', { pluginId: this.id, status: 'disabled' });
        }

        for (const [hookId, pending] of Array.from(this.pendingHookCalls.entries())) {
          pending.reject(new Error(`Worker exited with code ${code} while executing hook "${hookId}"`));
        }
        this.pendingHookCalls.clear();
      });

      // Send INIT payload
      send({
        type: 'INIT',
        payload: {
          pluginId: this.id,
          manifest: this.manifest,
          code: this.code,
        },
      });
    });
  }

  async destroy(_ctx?: KernelContext): Promise<void> {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {}
    }
    this.unsubs.length = 0;
    this.pendingHookCalls.clear();

    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'SHUTDOWN' });
      } catch {}
      await new Promise((res) => setTimeout(res, 50));
      this.terminate();
    }
  }

  private terminate(): void {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {}
      this.worker = undefined;
    }
  }
}
