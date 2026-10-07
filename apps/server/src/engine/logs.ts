import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** r667: how much of a deploy log one read loads (see LogBus.read). */
export const MAX_LOG_READ_BYTES = 8 * 1024 * 1024;

/**
 * Per-deployment log bus: appends every line to disk and emits it to live
 * subscribers (the WebSocket log stream).
 */
class LogBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(deploymentId: number, line: string): void {
    const file = path.join(config.paths.logsDir, `${deploymentId}.log`);
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      /* best effort */
    }
    this.emit(String(deploymentId), line);
  }

  /**
   * The log's text — at most its last `maxBytes` (r667). Every WebSocket
   * subscriber, the failure-hint scan and AI diagnosis used to read the WHOLE
   * file into memory, however large a runaway build had made it. A capped
   * read starts at the first full line inside the window and says how much
   * was left out; the download route still streams the complete file.
   */
  read(deploymentId: number, maxBytes = MAX_LOG_READ_BYTES): string {
    const file = path.join(config.paths.logsDir, `${deploymentId}.log`);
    if (!existsSync(file)) return '';
    const size = statSync(file).size;
    if (size <= maxBytes) return readFileSync(file, 'utf8');
    const buf = Buffer.alloc(maxBytes);
    const fd = openSync(file, 'r');
    let read: number;
    let startsAtLineBoundary: boolean;
    try {
      const previous = Buffer.alloc(1);
      startsAtLineBoundary = readSync(fd, previous, 0, 1, size - maxBytes - 1) === 1 && previous[0] === 10;
      read = readSync(fd, buf, 0, maxBytes, size - maxBytes);
    } finally {
      closeSync(fd);
    }
    const tail = buf.subarray(0, read);
    const firstLine = startsAtLineBoundary ? -1 : tail.indexOf(10);
    const text = (firstLine === -1 ? tail : tail.subarray(firstLine + 1)).toString('utf8');
    return `… ${size - (read - (firstLine + 1))} earlier bytes of this log omitted — download the full log to see them\n${text}`;
  }

  /**
   * F881: writers still appending to a deployment's log (the worker from its
   * claim, the pipeline run itself). A row's status is not an end-of-log
   * marker — the pipeline marks it `running` before the proxy swap, which can
   * still log a retry and flip it to `failed` — so the log stream ends only
   * once the row is final AND no writer remains.
   */
  private readonly writers = new Map<number, number>();

  /** F881: a writer starts appending to this deployment's log. Pair with end(). */
  beginRun(deploymentId: number): void {
    this.writers.set(deploymentId, (this.writers.get(deploymentId) ?? 0) + 1);
  }

  /**
   * F881: a writer has written its last line. Once no writer remains, emits
   * the end-of-log signal subscribers re-check the deployment on. Also called
   * without a beginRun by paths that settle a row no run in this process owns
   * (the worker's boot recovery).
   */
  end(deploymentId: number): void {
    const left = (this.writers.get(deploymentId) ?? 0) - 1;
    if (left > 0) {
      this.writers.set(deploymentId, left);
      return;
    }
    this.writers.delete(deploymentId);
    this.emit(`end:${deploymentId}`);
  }

  /** F881: true while a run in this process may still append to the log. */
  isWriting(deploymentId: number): boolean {
    return this.writers.has(deploymentId);
  }

  subscribe(deploymentId: number, onLine: (line: string) => void, onEnd?: () => void): () => void {
    const key = String(deploymentId);
    this.on(key, onLine);
    if (onEnd) this.on(`end:${deploymentId}`, onEnd);
    return () => {
      this.off(key, onLine);
      if (onEnd) this.off(`end:${deploymentId}`, onEnd);
    };
  }
}

export const logBus = new LogBus();

/**
 * Delete one deployment's log file. Used when a deployment row is removed from
 * history — leaving the file behind would keep the largest artefact of the
 * deploy on disk while the record that explains it is gone.
 *
 * Returns true when a file was actually removed. Never throws: a missing file
 * is the normal case for a deployment that never produced output, and a delete
 * that fails must not abort the row deletion it accompanies.
 */
export function deleteLog(deploymentId: number): boolean {
  const file = path.join(config.paths.logsDir, `${deploymentId}.log`);
  try {
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove deploy-log files older than `maxAgeMs` (judged by mtime). Deploy logs
 * accumulate one file per deployment and are never otherwise cleaned up, so
 * without this the logs directory grows without bound. Returns the count removed.
 *
 * r302: `keep` names deployments whose log must survive whatever its mtime —
 * the non-terminal ones. A deploy that is `running` (serving traffic) stops
 * writing its log once it is up, so after 30 days the mtime sweep deleted the
 * build log of the very deployment the Deploys tab shows as live, while the
 * row itself is deliberately never swept.
 */
export function pruneOldLogs(maxAgeMs: number, keep: ReadonlySet<number> = new Set()): number {
  const dir = config.paths.logsDir;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // directory missing — nothing to prune
  }
  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    const id = /^(\d+)\.log$/.exec(name)?.[1];
    if (id !== undefined && keep.has(Number(id))) continue;
    const file = path.join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      /* best effort — file may have vanished between readdir and stat */
    }
  }
  return removed;
}

