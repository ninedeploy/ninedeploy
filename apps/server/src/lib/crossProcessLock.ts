import { randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
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
  // r314: a per-acquisition token, so release() can tell OUR lock file from
  // one a later holder created at the same path.
  const token = `${process.pid} ${Date.now()} ${randomUUID()}\n`;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, token);
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
          // r314: delete only a file that still carries our token. If our
          // heartbeat stalled long enough for another process to steal the
          // lock, the file at this path is THEIRS — unlinking it would hand
          // the lock to a third process while they still hold it.
          try {
            if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
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
        if (Date.now() - mtimeMs > staleMs) takeOverStaleLock(lockPath, staleMs);
      } catch {
        /* vanished between EEXIST and stat — retry */
      }
      if (Date.now() > deadline) throw new LockUnavailableError(lockPath);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

/**
 * r314: remove a lock file judged stale — but only the file that IS stale.
 *
 * The old steal was `stat` → `unlink(path)`. Two waiters that both saw the
 * same stale file raced: the first unlinked it and created its own fresh
 * lock, then the second's unlink removed that FRESH lock and it created
 * another — both believed they held the lock (a backup interleaved with a
 * restore on the same target). The path was re-resolved at unlink time, so
 * nothing tied the delete to the file that had been judged.
 *
 * Instead, atomically rename whatever is at the path to a private name, then
 * judge THAT inode: rename moves one file and only one waiter can move it.
 * Still stale → it was the dead holder's, delete it. Fresh → another waiter
 * already replaced the stale file; put its live lock back (link fails if the
 * path was re-created meanwhile, in which case that newer file stands). That
 * instant — a third contender creating the path while a live lock is briefly
 * moved aside — is the one residual window, far narrower than the old one.
 */
function takeOverStaleLock(lockPath: string, staleMs: number): void {
  const aside = `${lockPath}.${randomUUID()}.stale`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // another waiter moved it first — just retry the create
  }
  try {
    if (Date.now() - statSync(aside).mtimeMs <= staleMs) {
      try {
        linkSync(aside, lockPath);
      } catch {
        /* path re-created meanwhile — leave the newer file in place */
      }
    }
  } finally {
    try {
      unlinkSync(aside);
    } catch {
      /* nothing to clean up */
    }
  }
}
