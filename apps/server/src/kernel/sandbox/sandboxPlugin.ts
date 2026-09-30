import { Worker } from 'node:worker_threads';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/**
 * r468: how long to wait after SIGTERM before SIGKILLing the sandbox child.
 * The worker transport's terminate() is synchronous; a process needs a grace
 * window for the SHUTDOWN handler's async plugin destroy() to finish.
 */
const CHILD_KILL_GRACE_MS = 3000;

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
  /** r468: the permission-model child; used unless an explicit workerPath pins the legacy worker transport. */
  private child?: ChildProcess;
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
    // r468: production sandbox plugins — which carry third-party code — run
    // in a permission-model CHILD PROCESS: --permission denies fs read/write,
    // child processes, worker threads and native addons unless explicitly
    // allowed, turning the old "containment hygiene" disclaimer into a real
    // boundary. The legacy worker-thread transport remains for two pinned
    // cases: an explicit workerPath (tests drive it with their own scripts)
    // and the DEV fallback below.
    if (this.workerPath) {
      return this.initWorkerTransport(ctx, this.workerPath);
    }
    const bootstrapPath = join(dirname(fileURLToPath(import.meta.url)), 'processBootstrap.js');
    if (existsSync(bootstrapPath)) {
      return this.initProcessTransport(ctx, bootstrapPath);
    }
    // Dev/test fallback: no compiled sibling next to this module (a source
    // checkout under vitest/tsx — their loaders transform the .ts bootstrap
    // for a Worker but a forked child has no loader). Containment only, the
    // pre-r468 behavior; the compiled runtime always takes the branch above.
    return this.initWorkerTransport(
      ctx,
      join(dirname(fileURLToPath(import.meta.url)), 'workerBootstrap.js'),
    );
  }

  /**
   * The execArgv the sandbox child runs under. Static + exported so tests can
   * fork with the SAME flags and prove they actually deny (a child that can
   * still read the filesystem would make this whole module decoration).
   */
  static sandboxExecArgv(allowReads: string[]): string[] {
    return [
      '--permission',
      ...allowReads.map((p) => `--allow-fs-read=${p}`),
      // The worker transport's resourceLimits equivalents: a chatty plugin
      // cannot balloon the panel's memory from inside its own process.
      '--max-old-space-size=64',
      '--max-semi-space-size=16',
    ];
  }

  private async initProcessTransport(ctx: KernelContext, bootstrapPath: string): Promise<void> {
    // fs-read allowlist: exactly what the ESM loader needs to boot the
    // bootstrap — its own directory (dist/kernel/sandbox) and the package
    // manifest (module resolution reads the nearest package.json for
    // "type":"module"). Neither contains secrets; everything else — /data
    // with master.key and the db, INSTALL_DIR/.env, HOME — stays denied.
    const allowReads = [dirname(bootstrapPath), join(dirname(bootstrapPath), '..', '..', 'package.json')];

    this.child = fork(bootstrapPath, [], {
      execArgv: SandboxPlugin.sandboxExecArgv(allowReads),
      // r414 carries over: the child gets a scrubbed env — process.env is
      // NOT part of the permission model, so the master key would otherwise
      // still be one read away.
      env: {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: process.env['LANG'] ?? 'C.UTF-8',
        TZ: process.env['TZ'] ?? 'UTC',
      },
      // silent: stdout/stderr are piped (and dropped) — plugin console output
      // travels through the LOG protocol messages instead, same as the worker
      // transport where console output goes to the worker's own stderr.
      silent: true,
      serialization: 'json',
    });

    const send = (msg: MainToWorkerMessage) => {
      this.child?.send(msg);
    };
    return this.awaitInit(
      (onMsg, onErr, onExit) => {
        this.child!.on('message', onMsg);
        this.child!.on('error', onErr);
        this.child!.on('exit', onExit);
      },
      send,
      ctx,
    );
  }

  private async initWorkerTransport(ctx: KernelContext, targetScript: string): Promise<void> {
    // Launch worker thread with resource limits if supported.
    // r414: the worker gets a SCRUBBED environment — by default a worker
    // thread receives a COPY of the panel's process env, which includes
    // NINEDEPLOY_MASTER_KEY(S)/JWT secret, i.e. the key that decrypts every
    // stored secret. Third-party plugin code must not read them for free.
    // (r468 note: this legacy transport remains containment hygiene, NOT a
    // security boundary — production sandbox plugins default to the
    // permission-model child process in initProcessTransport above.)
    this.worker = new Worker(targetScript, {
      resourceLimits: {
        maxYoungGenerationSizeMb: 16,
        maxOldGenerationSizeMb: 64,
      },
      env: {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: process.env['LANG'] ?? 'C.UTF-8',
        TZ: process.env['TZ'] ?? 'UTC',
      },
    });

    const send = (msg: MainToWorkerMessage) => {
      this.worker?.postMessage(msg);
    };
    return this.awaitInit(
      (onMsg, onErr, onExit) => {
        this.worker!.on('message', onMsg);
        this.worker!.on('error', onErr);
        this.worker!.on('exit', onExit);
      },
      send,
      ctx,
    );
  }

  /** r468: shared — the wildcard event relay both transports forward through. */
  private wireEventForwarder(ctx: KernelContext, send: (msg: MainToWorkerMessage) => void): void {
    this.unsubs.push(
      // r234: the bus hands a wildcard listener the concrete event name. It
      // used to be dropped and every event relayed as `custom.system_event`,
      // so a sandbox `ctx.on('deployment.status_changed', …)` never fired.
      ctx.events.onCustom('*', (payload, event) => {
        send({ type: 'EVENT', payload: { event: event ?? 'custom.system_event', data: payload } });
      }),
    );
  }

  /** r468: shared — init handshake + transport listeners, identical for worker and process. */
  private awaitInit(
    attach: (
      onMsg: (msg: WorkerToMainMessage) => void,
      onErr: (err: Error) => void,
      onExit: (code: number) => void,
    ) => void,
    send: (msg: MainToWorkerMessage) => void,
    ctx: KernelContext,
  ): Promise<void> {
    // Forward system events to the sandbox (registered once, before the
    // handshake, so no early event is missed).
    this.wireEventForwarder(ctx, send);

    return new Promise((resolve, reject) => {
      let isResolved = false;

      const initTimeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          this.terminate();
          reject(new Error(`Sandbox plugin "${this.id}" timed out during initialization`));
        }
      }, 10000);

      attach(
        async (msg) => {
          try {
            await this.handleMessage(ctx, msg, send, () => {
              if (!isResolved) {
                isResolved = true;
                clearTimeout(initTimeout);
                resolve();
              }
            });
          } catch (dispatchErr) {
            console.error(`[Sandbox:${this.id}] Error handling sandbox message:`, dispatchErr);
          }
        },
        (err) => {
          console.error(`[Sandbox:${this.id}] Sandbox fatal error:`, err);
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
        },
        (code) => {
          if (code !== 0) {
            console.warn(`[Sandbox:${this.id}] Sandbox exited with code ${code}`);
            ctx.events.emit('plugin.status_changed', { pluginId: this.id, status: 'disabled' });
          }

          for (const [hookId, pending] of Array.from(this.pendingHookCalls.entries())) {
            pending.reject(new Error(`Sandbox exited with code ${code} while executing hook "${hookId}"`));
          }
          this.pendingHookCalls.clear();
        },
      );

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

  /** r468: shared — the protocol dispatch both transports speak. */
  private async handleMessage(
    ctx: KernelContext,
    msg: WorkerToMainMessage,
    send: (msg: MainToWorkerMessage) => void,
    onReady: () => void,
  ): Promise<void> {
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
        onReady();
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
              // makes sure a wedged sandbox cannot leave the entry in
              // pendingHookCalls forever (entries are keyed by hookId,
              // so a stale one would also poison the NEXT call). The
              // protocol carries one id per registration, so
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
        console.error(`[Sandbox:${this.id}] Sandbox reported error:`, msg.payload.error);
        ctx.events.emit('plugin.status_changed', { pluginId: this.id, status: 'errored' });
        break;
      }
    }
  }

  async destroy(_ctx?: KernelContext): Promise<void> {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {}
    }
    this.unsubs.length = 0;
    this.pendingHookCalls.clear();

    if (this.child) {
      try {
        this.child.send({ type: 'SHUTDOWN' });
      } catch {}
      await new Promise((res) => setTimeout(res, 50));
      this.terminate();
      return;
    }
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'SHUTDOWN' });
      } catch {}
      await new Promise((res) => setTimeout(res, 50));
      this.terminate();
    }
  }

  private terminate(): void {
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
        // A wedged child that ignored SIGTERM must not outlive its plugin:
        // escalate after the grace window.
        const c = this.child;
        setTimeout(() => {
          if (c.exitCode === null && !c.killed) c.kill('SIGKILL');
        }, CHILD_KILL_GRACE_MS).unref();
      } catch {}
      this.child = undefined;
      return;
    }
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {}
      this.worker = undefined;
    }
  }
}
