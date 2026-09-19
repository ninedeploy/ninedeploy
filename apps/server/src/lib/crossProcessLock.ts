import { closeSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import path from 'node:path';

/** Thrown when the lock cannot be acquired within the wait budget — the
 * caller maps it to a 409 so the operator sees "already running" instead
 * of a generic 500. */
export class LockUnavailableError extends Error {
  constructor(lockPath: string) {
    super(`another process holds the operation lock ${path.basename(lockPath)}`);
    this.name = 'LockUnavailableError';
  }
}

export interface CrossProcessLock {
  /** Idempotent: clears the heartbeat and removes the lock file. */
  release: () => void;
}

export interface LockOptions {
  /** How long to wait for a busy lock before failing (default 10s). */
  acquireTimeoutMs?: number;
  /** A lock whose heartbeat stopped this long ago is a dead holder — steal
   * it (default 60s; must comfortably exceed heartbeatMs). */
  staleMs?: number;
  /** Busy-poll interval while waiting (default 250ms). */
  retryMs?: number;
  /** Liveness heartbeat interval — refreshes the file mtime (default 5s). */
  heartbeatMs?: number;
}

/**
 * Cross-process mutual exclusion for long backup/restore operations, built
 * on an O_EXCL lock file. The in-process keyed guard serializes operations
 * within one panel; this lock additionally stops an overlapping process
 * (systemd restart overlap, a second instance against the same data
 * directory) from interleaving a backup with a restore on the same target.
 *
 * The holder refreshes the file's mtime as a heartbeat, so a lock abandoned
 * by a crashed process is stolen once it goes stale instead of wedging the
 * operation forever. Every process contending for the lock must use the
 * same file path (same data directory).
 */
export async function acquireCrossProcessLock(lockPath: string, opts: LockOptions = {}): Promise<CrossProcessLock> {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const retryMs = opts.retryMs ?? 250;
  const heartbeatMs = opts.heartbeatMs ?? 5_000;
  const deadline = Date.now() + acquireTimeoutMs;

  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } finally {
        closeSync(fd);
      }
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(lockPath, now, now);
        } catch {
          /* stolen or removed — release() clears the timer */
        }
      }, heartbeatMs);
      heartbeat.unref();
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone — nothing to release */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Held by someone. A heartbeat that stopped long ago means the holder
      // died without releasing: steal the stale file and retry — only one
      // of the concurrent stealers can win the next O_EXCL create.
      try {
        const { mtimeMs } = statSync(lockPath);
        if (Date.now() - mtimeMs > staleMs) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* another waiter stole it first — just retry */
          }
        }
      } catch {
        /* vanished between EEXIST and stat — retry */
      }
      if (Date.now() > deadline) throw new LockUnavailableError(lockPath);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
