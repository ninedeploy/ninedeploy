import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireCrossProcessLock, LockUnavailableError } from '../../src/lib/crossProcessLock.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-lock-test-'));
const lockPath = (name: string) => path.join(dir, `${name}.lock`);

afterEach(() => {
  for (const entry of ['a', 'busy', 'stale', 'cross'].map((n) => lockPath(n))) {
    if (existsSync(entry)) rmSync(entry, { force: true });
  }
});

describe('acquireCrossProcessLock', () => {
  it('acquires, releases, and allows immediate re-acquisition', async () => {
    const first = await acquireCrossProcessLock(lockPath('a'));
    expect(existsSync(lockPath('a'))).toBe(true);
    first.release();
    expect(existsSync(lockPath('a'))).toBe(false);
    const second = await acquireCrossProcessLock(lockPath('a'));
    second.release();
    // Release is idempotent — a double call must not unlink a newer lock.
    const third = await acquireCrossProcessLock(lockPath('a'));
    second.release();
    expect(existsSync(lockPath('a'))).toBe(true);
    third.release();
  });

  it('writes the holder identity into the lock file', async () => {
    const lock = await acquireCrossProcessLock(lockPath('a'));
    try {
      expect(statSync(lockPath('a')).size).toBeGreaterThan(0);
    } finally {
      lock.release();
    }
  });

  it('refuses a second acquisition while held and throws LockUnavailableError', async () => {
    const holder = await acquireCrossProcessLock(lockPath('busy'));
    try {
      await expect(
        acquireCrossProcessLock(lockPath('busy'), { acquireTimeoutMs: 300, retryMs: 50 }),
      ).rejects.toBeInstanceOf(LockUnavailableError);
    } finally {
      holder.release();
    }
  });

  it('steals a stale lock whose holder stopped heartbeating', async () => {
    // Simulate a crashed holder: a lock file whose mtime is far in the past.
    writeFileSync(lockPath('stale'), '1 0\n');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath('stale'), old, old);
    const lock = await acquireCrossProcessLock(lockPath('stale'), { staleMs: 60_000, acquireTimeoutMs: 1_000 });
    lock.release();
  });

  it('does not steal a live lock just because the waiter is impatient', async () => {
    const holder = await acquireCrossProcessLock(lockPath('busy'), { heartbeatMs: 5_000 });
    try {
      await expect(
        acquireCrossProcessLock(lockPath('busy'), { acquireTimeoutMs: 300, retryMs: 50, staleMs: 60_000 }),
      ).rejects.toBeInstanceOf(LockUnavailableError);
      // The holder's lock survived the refused attempt.
      expect(existsSync(lockPath('busy'))).toBe(true);
    } finally {
      holder.release();
    }
  });

  it('mutually excludes a REAL second process and steals the lock after a crash', async () => {
    // The child creates the lock file, reports "held", and stays alive until
    // killed — first proving the parent cannot acquire while the holder
    // lives, then (after SIGKILL, which cannot run any cleanup) proving the
    // stale-lock steal recovers the operation.
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `
        import { openSync, writeSync, closeSync } from 'node:fs';
        const fd = openSync(${JSON.stringify(lockPath('cross'))}, 'wx', 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        process.stdout.write('held\\n');
        setInterval(() => {}, 60_000);
      `],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const held = await new Promise<string>((resolve, reject) => {
        child.stdout!.setEncoding('utf8');
        child.stdout!.once('data', resolve);
        child.once('exit', () => reject(new Error('child exited before holding the lock')));
      });
      expect(held).toContain('held');

      // Live holder: acquisition must fail, and the failure must not disturb
      // the holder's lock file.
      await expect(
        acquireCrossProcessLock(lockPath('cross'), { acquireTimeoutMs: 400, retryMs: 50, staleMs: 60_000 }),
      ).rejects.toBeInstanceOf(LockUnavailableError);
      expect(existsSync(lockPath('cross'))).toBe(true);

      // Crash the holder — SIGKILL cannot unlink, so only the staleness
      // steal can recover the lock.
      child.kill('SIGKILL');
      const lock = await acquireCrossProcessLock(lockPath('cross'), {
        acquireTimeoutMs: 2_000,
        retryMs: 50,
        staleMs: 200,
      });
      lock.release();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
