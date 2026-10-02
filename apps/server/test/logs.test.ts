import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteLog, logBus, pruneOldLogs } from '../src/engine/logs.js';

const h = vi.hoisted(() => {
  const config: { paths: { logsDir: string } } = { paths: { logsDir: '' } };
  return { config };
});

vi.mock('../src/config.js', () => ({ config: h.config }));

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-logs-'));
const logsDir = path.join(base, 'logs');
mkdirSync(logsDir, { recursive: true });
h.config.paths = { logsDir };

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('logBus', () => {
  beforeEach(() => {
    logBus.removeAllListeners();
  });

  it('publishes a line to subscribers and persists it to disk', () => {
    const listener = vi.fn();
    const unsubscribe = logBus.subscribe(42, listener);

    logBus.publish(42, 'hello');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('hello');
    expect(logBus.read(42)).toBe('hello\n');
    unsubscribe();
  });

  it('unsubscribing stops delivery', () => {
    const listener = vi.fn();
    const unsubscribe = logBus.subscribe(43, listener);
    unsubscribe();

    logBus.publish(43, 'gone');

    expect(listener).not.toHaveBeenCalled();
  });

  it('read returns an empty string when no log file exists', () => {
    expect(logBus.read(999)).toBe('');
  });

  it('still emits to subscribers when appending to disk fails', () => {
    const blocker = path.join(base, 'blocker');
    writeFileSync(blocker, '');
    h.config.paths.logsDir = blocker;

    const listener = vi.fn();
    logBus.subscribe(7, listener);
    logBus.publish(7, 'line');

    expect(listener).toHaveBeenCalledWith('line');
  });
});

describe('pruneOldLogs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nd-prune-'));
    h.config.paths.logsDir = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes only .log files older than the max age', () => {
    const oldFile = path.join(dir, '1.log');
    const newFile = path.join(dir, '2.log');
    const ignored = path.join(dir, 'readme.txt');
    writeFileSync(oldFile, 'old');
    writeFileSync(newFile, 'new');
    writeFileSync(ignored, 'keep me');

    // Age the old file back by 10 days; leave the new one current.
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, old, old);

    const removed = pruneOldLogs(7 * 24 * 60 * 60 * 1000); // 7-day cutoff

    expect(removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
    expect(existsSync(ignored)).toBe(true); // non-.log files are never touched
  });

  it('keeps the log of a non-terminal deployment whatever its age (r302)', () => {
    // A `running` deployment stops writing its log once it is up; the mtime
    // sweep used to delete the build log of the deploy currently serving.
    const live = path.join(dir, '7.log');
    const finished = path.join(dir, '8.log');
    writeFileSync(live, 'live');
    writeFileSync(finished, 'done');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(live, old, old);
    utimesSync(finished, old, old);

    expect(pruneOldLogs(30 * 24 * 60 * 60 * 1000, new Set([7]))).toBe(1);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(finished)).toBe(false);
  });

  it('returns 0 when the logs directory is missing', () => {
    h.config.paths.logsDir = path.join(dir, 'does-not-exist');
    expect(pruneOldLogs(60_000)).toBe(0);
  });
});

/**
 * Removing a deployment row has to take its log file with it: the row is the
 * only thing that explains the file, and build logs routinely echo
 * configuration. `pruneOldLogs` judges files by mtime alone, so it cannot be
 * the mechanism for a targeted delete.
 */
describe('deleteLog', () => {
  const dir = path.join(base, 'delete-log');

  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    h.config.paths.logsDir = dir;
  });

  it('removes the file for one deployment and reports it', () => {
    const file = path.join(dir, '77.log');
    writeFileSync(file, 'build output');
    // A neighbour must survive — the delete is keyed on the id, not a sweep.
    writeFileSync(path.join(dir, '78.log'), 'other');

    expect(deleteLog(77)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(dir, '78.log'))).toBe(true);
  });

  it('reports false for a deployment that never wrote a log', () => {
    // The normal case for a deploy that failed before producing output — not
    // an error, and it must not abort the row deletion it accompanies.
    expect(deleteLog(999)).toBe(false);
  });

  it('swallows a filesystem failure rather than aborting the caller', () => {
    // A directory where the log file should be: `existsSync` says yes and the
    // non-recursive `rmSync` throws EISDIR. Stands in for any unlink failure —
    // the row deletion this accompanies must still go through.
    mkdirSync(path.join(dir, '5.log'), { recursive: true });

    expect(deleteLog(5)).toBe(false);
  });
});

/**
 * r667: every WebSocket subscriber, the failure-hint scan and AI diagnosis
 * read the WHOLE deploy log into memory, however large a runaway build made
 * it. A read now loads at most the tail, starting at a full line.
 */
describe('r667: bounded deploy-log reads', () => {
  beforeEach(() => {
    h.config.paths.logsDir = logsDir;
  });

  it('returns only the tail of an over-long log, from a line boundary, saying what was left out', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(2, '0')}`);
    writeFileSync(path.join(logsDir, '777.log'), `${lines.join('\n')}\n`);
    const out = logBus.read(777, 64);
    const [marker, ...rest] = out.split('\n');
    expect(marker).toMatch(/^… \d+ earlier bytes of this log omitted/);
    expect(rest.at(-1)).toBe('');
    expect(rest.slice(0, -1).every((l) => /^line-\d\d$/.test(l))).toBe(true);
    expect(rest).toContain('line-49');
    expect(out).not.toContain('line-00');
  });

  it('returns a log under the cap unchanged', () => {
    writeFileSync(path.join(logsDir, '778.log'), 'a\nb\n');
    expect(logBus.read(778)).toBe('a\nb\n');
  });
});
