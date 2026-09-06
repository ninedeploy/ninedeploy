import { describe, expect, it, vi } from 'vitest';
import { executeAutoPrune, getAutoPruneStatus, getDiskUsage, parseReclaimedBytes, saveAutoPruneConfig } from '../../src/engine/autoPrune.js';
import { createFakeDb } from '../helpers.js';

const execMock = vi.hoisted(() => ({
  capture: vi.fn(async (_cmd: string, _args: string[]) => ({
    stdout: 'Total reclaimed space: 50MB\nwarning: test\n',
    stderr: '',
  })),
}));

vi.mock('../../src/lib/exec.js', () => ({
  capture: execMock.capture,
}));

describe('autoPrune engine', () => {
  it('parses reclaimed space from Docker output', () => {
    expect(parseReclaimedBytes('Total reclaimed space: 1.25GB')).toBe(1342177280);
    expect(parseReclaimedBytes('Total reclaimed space: 512MB')).toBe(536870912);
    expect(parseReclaimedBytes('Total reclaimed space: 10KB')).toBe(10240);
    expect(parseReclaimedBytes('Total reclaimed space: 100B')).toBe(100);
    expect(parseReclaimedBytes('Total reclaimed space: 2TB')).toBe(2 * 1024 * 1024 * 1024 * 1024);
    expect(parseReclaimedBytes('No space reclaimed')).toBe(0);
  });

  it('retrieves disk usage stats with safe fallbacks', () => {
    const usage = getDiskUsage();
    expect(usage.diskTotalBytes).toBeGreaterThan(0);
    expect(usage.diskUsedPercent).toBeGreaterThanOrEqual(0);
    expect(usage.diskFreeBytes).toBeGreaterThanOrEqual(0);

    // Invalid target path fallback
    const fallback = getDiskUsage('Z:\\non-existent-path-invalid-disk');
    expect(fallback.diskUsedPercent).toBe(45);
  });

  it('loads status and saves config in settings db with full and empty partials', async () => {
    const db = createFakeDb();
    const status = await getAutoPruneStatus(db);
    expect(status.enabled).toBe(true);
    expect(status.thresholdPercent).toBe(85);

    // DB with stored config and last prune history
    let settingCallCount = 0;
    const populatedDb = createFakeDb({
      findFirst: {
        settings: () => {
          settingCallCount++;
          if (settingCallCount === 1) return { key: 'autoprune_config', value: { thresholdPercent: 70, pruneImages: false } };
          if (settingCallCount === 2) return { key: 'autoprune_last_at', value: '2026-08-18T10:00:00.000Z' };
          return { key: 'autoprune_last_freed', value: '1048576' };
        },
      },
    });
    const populatedStatus = await getAutoPruneStatus(populatedDb);
    expect(populatedStatus.thresholdPercent).toBe(70);
    expect(populatedStatus.pruneImages).toBe(false);
    expect(populatedStatus.lastPrunedAt).toBe('2026-08-18T10:00:00.000Z');
    expect(populatedStatus.lastFreedBytes).toBe(1048576);

    // Save with all fields
    const updatedFull = await saveAutoPruneConfig(db, {
      enabled: false,
      thresholdPercent: 90,
      pruneImages: true,
      pruneVolumes: true,
      pruneContainers: true,
      pruneBuildCache: true,
      maxAgeHours: 72,
    });
    expect(updatedFull.thresholdPercent).toBe(90);
    expect(updatedFull.pruneVolumes).toBe(true);
    expect(updatedFull.maxAgeHours).toBe(72);

    // Save with empty partial
    const updatedEmpty = await saveAutoPruneConfig(db, {});
    expect(updatedEmpty.thresholdPercent).toBe(85);
    expect(updatedEmpty.enabled).toBe(true);
  });

  it('executes auto-prune across images, builder, containers, and volumes', async () => {
    const db = createFakeDb();
    await saveAutoPruneConfig(db, {
      pruneImages: true,
      pruneBuildCache: true,
      pruneContainers: true,
      pruneVolumes: true,
    });

    const runnerMock = vi.fn().mockImplementation(async (_cmd, args: string[]) => {
      if (args[0] === 'image') return { stdout: 'Total reclaimed space: 500MB', stderr: '' };
      if (args[0] === 'builder') return { stdout: 'Total reclaimed space: 200MB', stderr: '' };
      if (args[0] === 'container') return { stdout: 'Total reclaimed space: 50MB', stderr: '' };
      if (args[0] === 'volume') return { stdout: 'Total reclaimed space: 10MB', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await executeAutoPrune(
      db,
      { pruneImages: true, pruneBuildCache: true, pruneContainers: true, pruneVolumes: true },
      runnerMock,
    );
    expect(result.ok).toBe(true);
    expect(result.freedBytes).toBe(500 * 1024 * 1024 + 200 * 1024 * 1024 + 50 * 1024 * 1024 + 10 * 1024 * 1024);
    expect(result.details.imagesFreed).toContain('500MB');
    expect(result.details.buildCacheFreed).toContain('200MB');
    expect(result.details.containersFreed).toContain('50MB');
    expect(result.details.volumesFreed).toContain('10MB');

    // Empty output fallback branches
    const emptyRunner = vi.fn().mockResolvedValue({ stdout: '   ', stderr: '' });
    const emptyResult = await executeAutoPrune(
      db,
      { pruneImages: true, pruneBuildCache: true, pruneContainers: true, pruneVolumes: true },
      emptyRunner,
    );
    expect(emptyResult.ok).toBe(true);
    expect(emptyResult.details.imagesFreed).toBe('No images pruned');
    expect(emptyResult.details.buildCacheFreed).toBe('No build cache pruned');
    expect(emptyResult.details.containersFreed).toBe('No containers pruned');
    expect(emptyResult.details.volumesFreed).toBe('No volumes pruned');

    // Default runner execution using mocked exec.run without overrideConfig
    const defaultRunnerResult = await executeAutoPrune(db);
    expect(defaultRunnerResult.ok).toBe(true);
    expect(execMock.capture).toHaveBeenCalled();

    // Prune with all options disabled
    const allDisabledResult = await executeAutoPrune(
      db,
      { pruneImages: false, pruneBuildCache: false, pruneContainers: false, pruneVolumes: false },
      runnerMock,
    );
    expect(allDisabledResult.ok).toBe(true);
    expect(allDisabledResult.freedBytes).toBe(0);

    // Runner rejection handling
    const failRunner = vi.fn().mockRejectedValue(new Error('docker unavailable'));
    const failResult = await executeAutoPrune(
      db,
      { pruneImages: true, pruneBuildCache: true, pruneContainers: true, pruneVolumes: true },
      failRunner,
    );
    expect(failResult.ok).toBe(true);
    expect(failResult.details.imagesFreed).toContain('failed');
    expect(failResult.details.buildCacheFreed).toContain('failed');
    expect(failResult.details.containersFreed).toContain('failed');
    expect(failResult.details.volumesFreed).toContain('failed');
  });
});
