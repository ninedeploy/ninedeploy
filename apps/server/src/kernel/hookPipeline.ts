import type { HookDefinitions, IHookPipeline, KernelContext } from './types.js';

interface HookHandlerEntry {
  id?: string;
  priority: number;
  timeoutMs: number;
  handler: (payload: any, ctx: KernelContext) => Promise<any | undefined>;
  rollback?: (payload: any, ctx: KernelContext, error?: Error) => Promise<void> | void;
}

export class HookPipeline implements IHookPipeline {
  private readonly hooks = new Map<string, HookHandlerEntry[]>();
  private contextGetter: () => KernelContext;

  constructor(contextGetter: () => KernelContext) {
    this.contextGetter = contextGetter;
  }

  tap<K extends keyof HookDefinitions>(
    hook: K,
    handler: (payload: HookDefinitions[K], ctx: KernelContext) => Promise<undefined | HookDefinitions[K]>,
    opts?: {
      priority?: number;
      id?: string;
      timeoutMs?: number;
      rollback?: (payload: HookDefinitions[K], ctx: KernelContext, error?: Error) => Promise<void> | void;
    },
  ): () => void {
    const hookName = hook as string;
    const entry: HookHandlerEntry = {
      id: opts?.id,
      priority: opts?.priority ?? 100,
      timeoutMs: opts?.timeoutMs ?? 5000,
      handler,
      rollback: opts?.rollback,
    };

    let list = this.hooks.get(hookName);
    if (!list) {
      list = [];
      this.hooks.set(hookName, list);
    }

    list.push(entry);
    list.sort((a, b) => b.priority - a.priority); // Higher priority runs first

    return () => {
      const current = this.hooks.get(hookName);
      if (current) {
        const index = current.indexOf(entry);
        if (index !== -1) {
          current.splice(index, 1);
          if (current.length === 0) {
            this.hooks.delete(hookName);
          }
        }
      }
    };
  }

  async call<K extends keyof HookDefinitions>(hook: K, initialPayload: HookDefinitions[K]): Promise<HookDefinitions[K]> {
    const hookName = hook as string;
    const list = this.hooks.get(hookName);
    if (!list || list.length === 0) {
      return initialPayload;
    }

    let currentPayload = initialPayload;
    const ctx = this.contextGetter();
    const executedEntries: HookHandlerEntry[] = [];

    const executeRollback = async (triggerError?: Error) => {
      const reverseExecuted = [...executedEntries].reverse();
      for (const entry of reverseExecuted) {
        if (entry.rollback) {
          try {
            await entry.rollback(currentPayload, ctx, triggerError);
          } catch (rbErr) {
            console.error(`[HookPipeline] Error executing rollback for hook "${hookName}" ${entry.id ? `(${entry.id})` : ''}:`, rbErr);
          }
        }
      }
    };

    for (const entry of Array.from(list)) {
      try {
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Hook "${hookName}" handler ${entry.id ? `(${entry.id}) ` : ''}timed out after ${entry.timeoutMs}ms`));
          }, entry.timeoutMs);
        });

        try {
          const result = await Promise.race([
            entry.handler(currentPayload, ctx),
            timeoutPromise,
          ]);

          executedEntries.push(entry);

          if (result && typeof result === 'object') {
            currentPayload = result;
            // Check if handler vetoed / aborted the operation
            if ('allowOrAbort' in result && result.allowOrAbort === false) {
              await executeRollback(new Error(`Operation vetoed by hook "${hookName}" handler ${entry.id ?? ''}`));
              break;
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        console.error(`[HookPipeline] Error executing hook "${hookName}":`, err);
        await executeRollback(err instanceof Error ? err : new Error(String(err)));
        // r237: what was rolled back is no longer "executed". Keeping it in
        // the list meant a second failing handler rolled the same entries
        // back again. The chain itself continues: one slow or broken plugin
        // must not silence the handlers after it.
        executedEntries.length = 0;
      }
    }

    return currentPayload;
  }

  hasListeners(hook: string): boolean {
    const list = this.hooks.get(hook);
    return !!list && list.length > 0;
  }

  clear(): void {
    this.hooks.clear();
  }
}
