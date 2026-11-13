import { describe, expect, it } from 'vitest';
import { databaseUpgradeOptions, databaseUpgradeStart } from '../src/databaseUpgrade.js';

/** O2: the start body takes exactly one target; the options carry the series. */
describe('databaseUpgradeStart', () => {
  it('takes a PostgreSQL major or a release series, exactly one of them', () => {
    expect(databaseUpgradeStart.safeParse({ toMajor: 18 }).success).toBe(true);
    expect(databaseUpgradeStart.safeParse({ toVersion: '8.4' }).success).toBe(true);
    expect(databaseUpgradeStart.safeParse({ toVersion: '18' }).success).toBe(true);
    const both = databaseUpgradeStart.safeParse({ toMajor: 18, toVersion: '18' });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toBe('Give exactly one of toMajor and toVersion');
    expect(databaseUpgradeStart.safeParse({}).success).toBe(false);
  });

  it('refuses a target that is not a series, and unknown keys', () => {
    expect(databaseUpgradeStart.safeParse({ toVersion: 'latest' }).success).toBe(false);
    expect(databaseUpgradeStart.safeParse({ toVersion: '8.4.1' }).success).toBe(false);
    expect(databaseUpgradeStart.safeParse({ toMajor: 0 }).success).toBe(false);
    expect(databaseUpgradeStart.safeParse({ toMajor: 18, force: true }).success).toBe(false);
  });
});

describe('databaseUpgradeOptions', () => {
  it('carries the engine, the running series and the series it can reach', () => {
    const parsed = databaseUpgradeOptions.parse({ databaseId: 3, engine: 'mysql', currentMajor: 8, targets: [], currentSeries: '8.0', versions: ['8.4', '9.7'], refusal: null });
    expect(parsed.versions).toEqual(['8.4', '9.7']);
  });
});
