import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The lstat walk in resolveInRepo must distinguish: a missing component is
 *  skippable (the later fs operation fails on it with its own error), while
 *  ANY other stat failure propagates instead of being silently skipped. */
const lstatMocks = vi.hoisted(() => ({ lstatSync: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, lstatSync: lstatMocks.lstatSync };
});

const { repoRelative, resolveInRepo } = await import('../../src/lib/repoPath.js');

describe('resolveInRepo — stat failure handling', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'nd-repopath-stat-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    lstatMocks.lstatSync.mockReset();
  });

  it('treats a missing component as skippable and returns the resolved path', () => {
    lstatMocks.lstatSync.mockImplementation(() => {
      const e = new Error('no') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    expect(resolveInRepo(workDir, 'apps', 'api', 'Dockerfile')).toBe(path.join(workDir, 'apps', 'api', 'Dockerfile'));
  });

  it('rethrows non-ENOENT stat failures instead of silently skipping', async () => {
    lstatMocks.lstatSync.mockImplementation(() => {
      const e = new Error('permission denied') as NodeJS.ErrnoException;
      e.code = 'EACCES';
      throw e;
    });
    expect(() => resolveInRepo(workDir, 'locked', 'Dockerfile')).toThrow('permission denied');
    expect(() => repoRelative(workDir, 'locked')).toThrow('permission denied');
  });
});
