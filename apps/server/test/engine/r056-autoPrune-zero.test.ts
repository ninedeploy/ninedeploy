/**
 * r056: saveAutoPruneConfig drops explicit 0 for numeric fields.
 *
 * Root cause: `??` (nullish coalescing) treats `0` as nullish.
 *   thresholdPercent: 0  → falls back to current (85) instead of saving 0
 *   maxAgeHours: 0      → falls back to current (168) instead of saving 0
 *
 * Fix: use `!== undefined` checks instead of `??` for numeric fields.
 * Boolean fields are unaffected (false ?? true = false — correct).
 *
 * Proof: assert directly on the return value of saveAutoPruneConfig,
 * which is the correctly-merged updated config object — no mock reads needed.
 */
import { describe, expect, it, vi } from 'vitest';
import { saveAutoPruneConfig } from '../../src/engine/autoPrune.js';
import { createFakeDb } from '../helpers.js';

const execMock = vi.hoisted(() =>
  vi.fn(
    async (
      _cmd: string,
      _args: string[],
      _opts: object,
      _sink: (line: string) => void,
      _errSink?: (line: string) => void,
    ) => {},
  ),
);

vi.mock('../../src/lib/exec.js', () => ({ run: execMock.run }));

describe('r056: saveAutoPruneConfig numeric 0 fields', () => {
  it('saves thresholdPercent=0 instead of falling back to current', async () => {
    // Seed DB with thresholdPercent = 85 (the "current" stored value)
    const db = createFakeDb({
      findFirst: {
        settings: () => ({ key: 'autoprune_config', value: { thresholdPercent: 85 } }),
      },
    });

    // User explicitly sets thresholdPercent to 0 (valid: "prune at 0% full")
    const result = await saveAutoPruneConfig(db, { thresholdPercent: 0 });

    // BUG (before fix): 0 ?? 85 = 85  → result.thresholdPercent = 85 (FAIL)
    // FIX (after change): 0 !== undefined → result.thresholdPercent = 0  (PASS)
    expect(result.thresholdPercent).toBe(0);
  });

  it('saves maxAgeHours=0 instead of falling back to current', async () => {
    const db = createFakeDb({
      findFirst: {
        settings: () => ({ key: 'autoprune_config', value: { maxAgeHours: 168 } }),
      },
    });

    // User explicitly sets maxAgeHours to 0 (valid: "no minimum age")
    const result = await saveAutoPruneConfig(db, { maxAgeHours: 0 });

    // BUG (before fix): 0 ?? 168 = 168 → result.maxAgeHours = 168 (FAIL)
    // FIX (after change): 0 !== undefined → result.maxAgeHours = 0  (PASS)
    expect(result.maxAgeHours).toBe(0);
  });

  it('saves both thresholdPercent=0 and maxAgeHours=0 together', async () => {
    const db = createFakeDb({
      findFirst: {
        settings: () => ({ key: 'autoprune_config', value: { thresholdPercent: 85, maxAgeHours: 168 } }),
      },
    });

    const result = await saveAutoPruneConfig(db, { thresholdPercent: 0, maxAgeHours: 0 });

    expect(result.thresholdPercent).toBe(0);
    expect(result.maxAgeHours).toBe(0);
  });

  it('is NOT affected for boolean false (false is not nullish)', async () => {
    const db = createFakeDb({
      findFirst: {
        settings: () => ({ key: 'autoprune_config', value: { pruneImages: true } }),
      },
    });

    const result = await saveAutoPruneConfig(db, { pruneImages: false });

    expect(result.pruneImages).toBe(false); // `??` works correctly for booleans
  });

  it('correctly applies non-zero values (sanity check)', async () => {
    const db = createFakeDb({
      findFirst: {
        settings: () => ({ key: 'autoprune_config', value: { thresholdPercent: 50, maxAgeHours: 24 } }),
      },
    });

    const result = await saveAutoPruneConfig(db, { thresholdPercent: 95, maxAgeHours: 48 });

    expect(result.thresholdPercent).toBe(95);
    expect(result.maxAgeHours).toBe(48);
  });

  it('falls back correctly when field is undefined (not provided)', async () => {
    const db = createFakeDb({
      findFirst: {
        settings: () => ({ key: 'autoprune_config', value: { thresholdPercent: 85, maxAgeHours: 168 } }),
      },
    });

    const result = await saveAutoPruneConfig(db, { pruneImages: false });
    // Only pruneImages is set; thresholdPercent and maxAgeHours should fall back
    expect(result.thresholdPercent).toBe(85);
    expect(result.maxAgeHours).toBe(168);
    expect(result.pruneImages).toBe(false);
  });
});
