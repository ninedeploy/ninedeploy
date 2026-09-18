import type { DomainEvents, IEventBus } from './types.js';

type Listener = (payload: any) => Promise<void> | void;

export class EventBus implements IEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  emit<K extends keyof DomainEvents>(event: K, payload: DomainEvents[K]): void {
    this.emitCustom(event as string, payload);
  }

  emitCustom(event: string, payload: unknown): void {
    const exact = this.listeners.get(event);
    if (exact) {
      for (const listener of Array.from(exact)) {
        try {
          const result = listener(payload);
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
            const result = (listener as any)(payload, event);
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

  onCustom(event: string, listener: (payload: unknown, event?: string) => Promise<void> | void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);

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
