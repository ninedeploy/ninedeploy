import { describe, expect, it } from 'vitest';
import { databaseUpgradeOptions, databaseUpgradeStart, databaseVersionSet, legacyVersionStatus } from '../src/databaseUpgrade.js';

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

describe('databaseVersionSet', () => {
  it('takes a release tag, and nothing else', () => {
    for (const version of ['18', '8.4', '11.8', '12.3']) expect(databaseVersionSet.safeParse({ version }).success).toBe(true);
    expect(databaseVersionSet.safeParse({ version: 'latest' }).success).toBe(false);
    expect(databaseVersionSet.safeParse({ version: '8.0', force: true }).success).toBe(false);
    expect(databaseVersionSet.safeParse({}).success).toBe(false);
  });
});

describe('legacyVersionStatus', () => {
  it('carries what is known about the release and the list to choose from', () => {
    const parsed = legacyVersionStatus.parse({
      databaseId: 3, version: null, namedAt: null, canSet: true, why: null, creationImage: 'mysql:8.0', defaultImage: 'mysql:9.7', defaultTag: '9.7',
      containerImage: null, ambiguous: true, choices: ['8.0', '8.4', '9.7'],
    });
    expect(parsed.choices).toEqual(['8.0', '8.4', '9.7']);
    expect(legacyVersionStatus.safeParse({ databaseId: 3, version: null, canSet: true }).success).toBe(false);
  });
});
