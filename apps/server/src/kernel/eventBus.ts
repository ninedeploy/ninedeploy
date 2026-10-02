import type { DomainEvents, EventOrigin, IEventBus } from './types.js';

type Listener = (payload: any, event?: string, origin?: EventOrigin) => Promise<void> | void;

/** The origin every in-process emission carries unless it says otherwise. */
export const KERNEL_ORIGIN: EventOrigin = Object.freeze({ kind: 'kernel' as const });

/**
 * r530: true when an emission came from in-process (kernel / built-in) code.
 * A listener invoked directly — a test, or a wrapper that dropped the
 * argument — passes no origin and is treated as kernel: the bus itself always
 * supplies one, and the only untrusted producer (a sandbox plugin) is tagged
 * host-side, never by the plugin.
 */
export function isKernelOrigin(origin?: EventOrigin): boolean {
  return origin === undefined || origin.kind === 'kernel';
}

export class EventBus implements IEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  /**
   * r530: exact-name listeners that opted in to plugin-originated emissions.
   * Everything else — every built-in consumer of `audit.recorded`,
   * `deployment.status_changed`, `service.deployed`, … — is never handed one,
   * so a forged event cannot reach code that acts on it (delete a DNS record,
   * page the operator, POST a signed webhook) even if a name slipped past the
   * sandbox's namespace check.
   */
  private readonly acceptsPluginOrigin = new WeakSet<Listener>();

  emit<K extends keyof DomainEvents>(event: K, payload: DomainEvents[K]): void {
    this.emitCustom(event as string, payload);
  }

  emitCustom(event: string, payload: unknown, origin: EventOrigin = KERNEL_ORIGIN): void {
    const trusted = isKernelOrigin(origin);
    const exact = this.listeners.get(event);
    if (exact) {
      for (const listener of Array.from(exact)) {
        if (!trusted && !this.acceptsPluginOrigin.has(listener)) continue;
        try {
          // Kernel emissions keep the historical one-argument call; an
          // opted-in listener receiving a plugin emission learns where it
          // came from.
          const result = trusted ? listener(payload) : listener(payload, event, origin);
          if (result && typeof result.catch === 'function') {
            result.catch((err: unknown) => {
              // Error boundary: listener errors never crash the event emitter
              console.error(`[EventBus] Uncaught async error in listener for event "${event}":`, err);
            });
          }
        } catch (err) {
          console.error(`[EventBus] Uncaught synchronous error in listener for event "${event}":`, err);
        }
      }
    }

    if (event !== '*') {
      const wildcard = this.listeners.get('*');
      if (wildcard) {
        for (const listener of Array.from(wildcard)) {
          try {
            // r530: wildcards see everything, with the origin as the third
            // argument so a firehose consumer can tell the two apart.
            const result = listener(payload, event, origin);
            if (result && typeof result.catch === 'function') {
              result.catch((err: unknown) => {
                console.error(`[EventBus] Uncaught async error in listener for event "${event}":`, err);
              });
            }
          } catch (err) {
            console.error(`[EventBus] Uncaught synchronous error in listener for event "${event}":`, err);
          }
        }
      }
    }
  }

  on<K extends keyof DomainEvents>(event: K, listener: (payload: DomainEvents[K]) => Promise<void> | void): () => void {
    return this.onCustom(event as string, listener as (payload: unknown) => Promise<void> | void);
  }

  onCustom(
    event: string,
    listener: (payload: unknown, event?: string, origin?: EventOrigin) => Promise<void> | void,
    opts?: { acceptPluginOrigin?: boolean },
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    if (opts?.acceptPluginOrigin) this.acceptsPluginOrigin.add(listener);

    return () => {
      const current = this.listeners.get(event);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  once<K extends keyof DomainEvents>(event: K, listener: (payload: DomainEvents[K]) => Promise<void> | void): () => void {
    const unsubscribe = this.onCustom(event as string, async (payload) => {
      unsubscribe();
      await listener(payload as DomainEvents[K]);
    });
    return unsubscribe;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}
