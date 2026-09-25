import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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

  read(deploymentId: number): string {
    const file = path.join(config.paths.logsDir, `${deploymentId}.log`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  subscribe(deploymentId: number, onLine: (line: string) => void): () => void {
    const key = String(deploymentId);
    this.on(key, onLine);
    return () => this.off(key, onLine);
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

