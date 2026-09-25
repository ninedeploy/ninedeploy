import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * r314 regression: two waiters that both judged the same lock stale.
 *
 * The race needs another PROCESS to act between this waiter's staleness
 * `stat` and its delete, which a single test process cannot interleave on its
 * own (the steal path is synchronous). So `statSync` gets a one-shot hook
 * that plays the other waiter at exactly that point: it deletes the stale
 * file and creates its own fresh lock. Deterministic, no timing.
 */
const hooks = vi.hoisted(() => ({ afterStat: null as null | ((p: string) => void) }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    const result = actual.statSync(...args);
    const hook = hooks.afterStat;
    if (hook) {
      hooks.afterStat = null;
      hook(String(args[0]));
    }
    return result;
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

const { acquireCrossProcessLock, LockUnavailableError } = await import('../../src/lib/crossProcessLock.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-lock-r314-'));
const lockPath = path.join(dir, 'op.lock');

afterEach(() => {
  hooks.afterStat = null;
  for (const entry of readdirSync(dir)) rmSync(path.join(dir, entry), { force: true });
});

describe('r314: cross-process lock ownership', () => {
  it('a waiter that judged a lock stale does not delete the fresh lock another waiter just took', async () => {
    writeFileSync(lockPath, '4242 0\n'); // crashed holder
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    // The other waiter wins the steal right after our stat saw "stale".
    hooks.afterStat = (p) => {
      if (p !== lockPath) return;
      unlinkSync(lockPath);
      writeFileSync(lockPath, 'other-waiter-token\n');
    };

    await expect(
      acquireCrossProcessLock(lockPath, { staleMs: 60_000, acquireTimeoutMs: 300, retryMs: 50 }),
    ).rejects.toBeInstanceOf(LockUnavailableError);
    // The other waiter still holds its lock, untouched, and nothing leaked.
    expect(readFileSync(lockPath, 'utf8')).toBe('other-waiter-token\n');
    expect(readdirSync(dir)).toEqual(['op.lock']);
  });

  it('still steals a genuinely stale lock', async () => {
    writeFileSync(lockPath, '4242 0\n');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    const lock = await acquireCrossProcessLock(lockPath, { staleMs: 60_000, acquireTimeoutMs: 1_000, retryMs: 50 });
    expect(readFileSync(lockPath, 'utf8')).not.toBe('4242 0\n');
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('release() does not delete a lock file that now belongs to another holder', async () => {
    const lock = await acquireCrossProcessLock(lockPath);
    // Our heartbeat stalled, the lock was stolen, and a new holder owns the path.
    unlinkSync(lockPath);
    writeFileSync(lockPath, 'newer-holder-token\n');
    lock.release();
    expect(readFileSync(lockPath, 'utf8')).toBe('newer-holder-token\n');
  });
});
