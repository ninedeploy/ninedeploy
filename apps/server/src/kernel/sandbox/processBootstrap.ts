import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol.js';

/**
 * r468: the process-side twin of workerBootstrap.ts — the SAME typed protocol
 * and plugin `ctx` surface, but spoken over the child-process IPC channel
 * (`process.send` / `process.on('message')`) instead of a worker port, so the
 * host can fork this file under Node's permission model
 * (`--permission` + explicit fs-read allowlist, see sandboxPlugin.ts) and
 * third-party plugin code physically cannot read the filesystem, spawn child
 * processes, open worker threads or load native addons — the boundary the
 * docs used to disclaim ("resource containment, not a security boundary")
 * is a real one for the classic exfiltration paths now.
 *
 * Kept byte-for-byte in behavioural sync with workerBootstrap: any protocol
 * or ctx change must land in both.
 */

function post(msg: WorkerToMainMessage): void {
  if (process.send) process.send(msg);
}

const hookHandlers = new Map<string, (payload: any) => Promise<any> | any>();
const eventHandlers = new Map<string, Set<(payload: any) => Promise<void> | void>>();
const pendingConfigRequests = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();

let activePlugin: any = null;

process.on('message', async (msg: MainToWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'INIT': {
        const { pluginId, manifest, code } = msg.payload;

        // r473: the SDK's PluginLogger promises varargs — stringify extras so
        // they actually reach the panel log instead of vanishing at the seam.
        const fmt = (message: string, args: unknown[]): string =>
          args.length
            ? `${message} ${args
                .map((a) => {
                  if (typeof a === 'string') return a;
                  try {
                    return JSON.stringify(a);
                  } catch {
                    return String(a);
                  }
                })
                .join(' ')}`
            : message;
        const logger = {
          debug: (message: string, ...args: unknown[]) => post({ type: 'LOG', payload: { level: 'debug', message: `[${pluginId}] ${fmt(message, args)}` } }),
          info: (message: string, ...args: unknown[]) => post({ type: 'LOG', payload: { level: 'info', message: `[${pluginId}] ${fmt(message, args)}` } }),
          warn: (message: string, ...args: unknown[]) => post({ type: 'LOG', payload: { level: 'warn', message: `[${pluginId}] ${fmt(message, args)}` } }),
          error: (message: string, ...args: unknown[]) => post({ type: 'LOG', payload: { level: 'error', message: `[${pluginId}] ${fmt(message, args)}` } }),
        };

        const config = {
          get: async (key: string, defaultValue?: unknown) => {
            const reqId = Math.random().toString(36).slice(2);
            return new Promise((resolve, reject) => {
              pendingConfigRequests.set(reqId, { resolve, reject });
              post({ type: 'CONFIG_GET', payload: { reqId, key, defaultValue, isSecret: false } });
            });
          },
          getSecret: async (key: string) => {
            const reqId = Math.random().toString(36).slice(2);
            return new Promise<string | null>((resolve, reject) => {
              pendingConfigRequests.set(reqId, { resolve, reject });
              post({ type: 'CONFIG_GET', payload: { reqId, key, isSecret: true } });
            });
          },
          set: async (key: string, value: unknown, options?: { isSecret?: boolean; description?: string; tags?: string[] }) => {
            post({ type: 'CONFIG_SET', payload: { key, value, options } });
          },
          delete: async (key: string) => {
            post({ type: 'CONFIG_SET', payload: { key, value: null } });
          },
        };

        const ctx = {
          pluginId,
          config,
          logger,
          emit: (event: string, data?: unknown) => {
            post({ type: 'EMIT_EVENT', payload: { event, data } });
          },
          on: (event: string, handler: (payload: unknown) => void | Promise<void>) => {
            let set = eventHandlers.get(event);
            if (!set) {
              set = new Set();
              eventHandlers.set(event, set);
            }
            set.add(handler);
            return () => set?.delete(handler);
          },
          tapHook: (hookName: string, fn: (payload: unknown) => unknown | Promise<unknown>, optsOrPriority?: any) => {
            const hookId = Math.random().toString(36).slice(2);
            const priority = typeof optsOrPriority === 'number' ? optsOrPriority : optsOrPriority?.priority;
            hookHandlers.set(hookId, fn);
            post({ type: 'REGISTER_HOOK', payload: { hookId, hookName, priority } });
            return () => hookHandlers.delete(hookId);
          },
          registerMenuItem: (_item: any) => {},
        };

        if (code) {
          // An async arrow's prototype IS the AsyncFunction constructor —
          // same object the named class exposes, arrow-shaped for lint.
          const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
          const factory = new AsyncFunction('require', 'ctx', code);
          activePlugin = await factory(undefined, ctx);
        }

        if (activePlugin && typeof activePlugin.init === 'function') {
          await activePlugin.init(ctx);
        }

        // r473: honour the SDK's PluginDefinition contract — an author may
        // declare configSchema/menuItems/dependencies on the object their
        // code RETURNS (that is what definePlugin validates); the install
        // manifest is only the fallback. Before this, a returned definition's
        // declarations were silently dropped and the Settings UI never showed
        // the plugin's config fields.
        const def = (activePlugin ?? {}) as Record<string, unknown>;
        post({
          type: 'READY',
          payload: {
            menuItems: (def['menuItems'] as unknown) ?? (manifest as any)?.menuItems,
            configSchema: (def['configSchema'] as unknown) ?? (manifest as any)?.configSchema,
            dependencies: (def['dependencies'] as unknown) ?? (manifest as any)?.dependencies,
          },
        });
        post({ type: 'STATUS_CHANGED', payload: { status: 'active' } });
        break;
      }

      case 'EVENT': {
        const { event, data } = msg.payload;
        const handlers = eventHandlers.get(event);
        if (handlers) {
          for (const handler of Array.from(handlers)) {
            try {
              await handler(data);
            } catch (err) {
              post({ type: 'LOG', payload: { level: 'error', message: `Error in event listener "${event}": ${err}` } });
            }
          }
        }
        break;
      }

      case 'HOOK_CALL': {
        // r532: echo the per-invocation callId — the host keys its pending
        // calls by it, so concurrent calls of one tap resolve independently.
        const { hookId, callId, initialPayload } = msg.payload;
        const handler = hookHandlers.get(hookId);
        if (!handler) {
          post({ type: 'HOOK_RESPONSE', payload: { hookId, callId, result: initialPayload } });
          return;
        }

        try {
          const result = await handler(initialPayload);
          post({ type: 'HOOK_RESPONSE', payload: { hookId, callId, result: result ?? initialPayload } });
        } catch (err) {
          post({ type: 'HOOK_RESPONSE', payload: { hookId, callId, error: (err as Error).message } });
        }
        break;
      }

      case 'CONFIG_RESPONSE': {
        const { reqId, value, error } = msg.payload;
        const pending = pendingConfigRequests.get(reqId);
        if (pending) {
          pendingConfigRequests.delete(reqId);
          if (error) pending.reject(new Error(error));
          else pending.resolve(value);
        }
        break;
      }

      case 'SHUTDOWN': {
        if (activePlugin && typeof activePlugin.destroy === 'function') {
          try {
            await activePlugin.destroy();
          } catch {}
        }
        process.exit(0);
      }
    }
  } catch (outerErr) {
    post({
      type: 'ERROR',
      payload: {
        error: (outerErr as Error).message,
        stack: (outerErr as Error).stack,
      },
    });
    post({ type: 'STATUS_CHANGED', payload: { status: 'errored', error: (outerErr as Error).message } });
  }
});
