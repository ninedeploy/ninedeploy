/**
 * Build slots per build host (multi-node, design §6.3 "Concurrency").
 *
 * The worker keeps its per-target-server partitions; on top of them a build
 * that runs AWAY from where the service runs (build placement `panel` or
 * `server`) takes a slot from an in-process semaphore keyed by its build
 * host: `build:panel` (sized by the panel's deploy concurrency) or
 * `build:<serverId>` (sized by `servers.build_concurrency`, 1–8). A deploy
 * waiting for a slot logs "waiting for the build server (n ahead)" and stays
 * in the worker's in-flight set, so the stale sweep treats it as alive.
 *
 * Deliberately free of heavy imports: the worker registers it, and the worker
 * tests mock the pipeline only.
 */

/** `build:panel` or `build:<serverId>`. */
export type BuildSlotKey = `build:${'panel' | number}`;

export const buildSlotKey = (serverId: number | null): BuildSlotKey => (serverId == null ? 'build:panel' : `build:${serverId}`);

export interface BuildSlots {
  /**
   * Wait for a slot on `key`. `onWait(ahead)` is called once when the caller
   * has to wait (how many builds hold or wait for the host before it). The
   * returned function releases the slot; calling it twice is a no-op.
   */
  acquire(key: BuildSlotKey, onWait?: (ahead: number) => void): Promise<() => void>;
  /** Slots held and builds waiting on `key` (for tests and the deploy log). */
  usage(key: BuildSlotKey): { active: number; waiting: number };
}

/** Clamp to the 1–8 range `servers.build_concurrency` allows. */
const clampCapacity = (n: number): number => (Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 1);

/**
 * A keyed semaphore. `capacity(key)` is asked on every acquire and release,
 * so an operator who changes a build server's concurrency is honoured from
 * the next slot on (running builds are never interrupted).
 */
export function createBuildSlots(capacity: (key: BuildSlotKey) => number | Promise<number>): BuildSlots {
  const active = new Map<BuildSlotKey, number>();
  const queues = new Map<BuildSlotKey, Array<() => void>>();

  const pump = async (key: BuildSlotKey): Promise<void> => {
    const queue = queues.get(key);
    if (!queue || queue.length === 0) return;
    let cap = 1;
    try {
      cap = clampCapacity(await capacity(key));
    } catch {
      cap = 1;
    }
    while (queue.length > 0 && (active.get(key) ?? 0) < cap) {
      active.set(key, (active.get(key) ?? 0) + 1);
      queue.shift()!();
    }
  };

  return {
    async acquire(key, onWait) {
      let cap = 1;
      try {
        cap = clampCapacity(await capacity(key));
      } catch {
        cap = 1;
      }
      const queue = queues.get(key) ?? [];
      queues.set(key, queue);
      const used = active.get(key) ?? 0;
      if (queue.length === 0 && used < cap) {
        active.set(key, used + 1);
      } else {
        onWait?.(used + queue.length);
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active.set(key, Math.max(0, (active.get(key) ?? 1) - 1));
        void pump(key);
      };
    },
    usage(key) {
      return { active: active.get(key) ?? 0, waiting: queues.get(key)?.length ?? 0 };
    },
  };
}
