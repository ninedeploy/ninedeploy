import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ paths: { dataDir: '' } }));
vi.mock('../../src/config.js', () => ({ config: h }));
import { withNodeDatabaseLifecycle } from '../../src/lib/nodeDatabaseLifecycle.js';
import { acquireCrossProcessLock } from '../../src/lib/crossProcessLock.js';

beforeEach(() => { h.paths.dataDir = mkdtempSync(path.join(os.tmpdir(), 'nd-node-lifecycle-')); });
afterEach(() => { vi.useRealTimers(); rmSync(h.paths.dataDir, { recursive: true, force: true }); });
describe('node database lifecycle exclusion', () => {
  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('refuses invalid resource %s before any operation', async id => {
    const operation = vi.fn();
    await expect(withNodeDatabaseLifecycle(id, operation)).rejects.toMatchObject({ statusCode: 400 });
    expect(operation).not.toHaveBeenCalled(); expect(existsSync(path.join(h.paths.dataDir, 'op-locks'))).toBe(false);
  });
  it('refuses a same-resource overlap without queueing and allows another database', async () => {
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = withNodeDatabaseLifecycle(7, async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return 'first'; });
    await started;
    const overlap = vi.fn();
    await expect(withNodeDatabaseLifecycle(7, overlap)).rejects.toMatchObject({ statusCode: 409, code: 'node_database_busy' });
    expect(overlap).not.toHaveBeenCalled(); expect(await withNodeDatabaseLifecycle(8, async () => 'other')).toBe('other');
    finish(); expect(await first).toBe('first');
    expect(await withNodeDatabaseLifecycle(7, async () => 'retry')).toBe('retry');
  });
  it('releases both locks after the operation fails', async () => {
    await expect(withNodeDatabaseLifecycle(7, async () => { throw Error('owned failure'); })).rejects.toThrow('owned failure');
    expect(existsSync(path.join(h.paths.dataDir, 'op-locks/node-database-lifecycle-7.lock'))).toBe(false);
    expect(await withNodeDatabaseLifecycle(7, async () => 'recovered')).toBe('recovered');
  });
  it('honors an independently acquired on-disk lock, bounds waiting, and permits retry after release', async () => {
    vi.useFakeTimers();
    const external = await acquireCrossProcessLock(path.join(h.paths.dataDir, 'op-locks/node-database-lifecycle-7.lock'));
    try {
      const operation = vi.fn();
      const attempt = withNodeDatabaseLifecycle(7, operation); void attempt.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2251);
      await expect(attempt).rejects.toMatchObject({ statusCode: 409, code: 'node_database_busy' });
      expect(operation).not.toHaveBeenCalled();
    } finally { external.release(); }
    expect(await withNodeDatabaseLifecycle(7, async () => 'retry')).toBe('retry');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves filesystem failures and releases in-process exclusion after failed acquisition', async () => {
    writeFileSync(path.join(h.paths.dataDir, 'op-locks'), 'owned non-directory');
    await expect(withNodeDatabaseLifecycle(7, async () => 'never')).rejects.toMatchObject({ code: 'EEXIST' });
    rmSync(path.join(h.paths.dataDir, 'op-locks'));
    expect(await withNodeDatabaseLifecycle(7, async () => 'retry')).toBe('retry');
  });
});
