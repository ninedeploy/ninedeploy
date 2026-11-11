import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** Shorter values are not masked: they would blank out ordinary words and numbers. */
export const MIN_MASKED_LENGTH = 6;

/**
 * The strings a secret value can appear as in build output: itself, and for a
 * connection string its password alone, raw and URL-decoded (a tool that
 * parses the URL prints the password, not the URL).
 */
export function secretForms(value: string): string[] {
  const forms = new Set<string>([value]);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const pw = new URL(value).password;
      if (pw) {
        forms.add(pw);
        try {
          forms.add(decodeURIComponent(pw));
        } catch {
          /* not percent-encoded */
        }
      }
    } catch {
      /* not a URL after all */
    }
  }
  return [...forms].filter((f) => f.length >= MIN_MASKED_LENGTH);
}

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

  /**
   * Secret values of a running deployment (its secret env vars, attached
   * database connection strings, resolved vault references), longest first.
   * Build tools can echo them: Nixpacks writes a `$VAR` of a build command
   * into its RUN step with the value filled in, and BuildKit prints that step.
   * Every published line is masked before it reaches the file or a
   * subscriber; the set goes when the deployment's last writer ends.
   */
  private readonly secrets = new Map<number, string[]>();

  /** Mask these values in everything this deployment logs from now on. */
  maskValues(deploymentId: number, values: Iterable<string>): void {
    const all = new Set(this.secrets.get(deploymentId) ?? []);
    for (const v of values) for (const f of secretForms(v)) all.add(f);
    if (all.size > 0) this.secrets.set(deploymentId, [...all].sort((a, b) => b.length - a.length));
  }

  private mask(deploymentId: number, line: string): string {
    const values = this.secrets.get(deploymentId);
    if (!values) return line;
    let out = line;
    for (const v of values) if (out.includes(v)) out = out.split(v).join('***');
    return out;
  }

  publish(deploymentId: number, raw: string): void {
    const line = this.mask(deploymentId, raw);
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
    this.secrets.delete(deploymentId);
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

