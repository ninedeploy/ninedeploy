/**
 * Tests for the curated runtime version catalog.
 *
 * Two kinds of assertion live here. The invariant tests guard the shape of
 * the table itself — a recommended version that isn't in its own options
 * list, or a version string the manifest schema would reject, are the two
 * ways a well-meaning bump can silently break every preset. The helper
 * tests cover the lookup and advisory behaviour the UI depends on.
 */
import { describe, expect, it } from 'vitest';
import { runtime } from '../src/ninedeployManifest.js';
import {
  RUNTIME_CATALOG_REVIEWED,
  RUNTIME_VERSION_CATALOG,
  findRuntimeVersion,
  recommendedRuntimeVersion,
  runtimeVersionAdvisory,
  runtimeVersionOptions,
} from '../src/runtimeVersions.js';

const ENTRIES = Object.entries(RUNTIME_VERSION_CATALOG);

describe('RUNTIME_VERSION_CATALOG invariants', () => {
  it('was reviewed on a plausible ISO date', () => {
    expect(RUNTIME_CATALOG_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(RUNTIME_CATALOG_REVIEWED))).toBe(false);
  });

  it('offers every version in a form the manifest schema accepts', () => {
    for (const [type, entry] of ENTRIES) {
      for (const option of entry.options) {
        const parsed = runtime.safeParse({ type, version: option.version });
        expect(parsed.success, `${type} ${option.version}`).toBe(true);
      }
    }
  });

  it('recommends a version that is present in its own options list', () => {
    for (const [type, entry] of ENTRIES) {
      const versions = entry.options.map((o) => o.version);
      expect(versions, type).toContain(entry.recommended);
    }
  });

  it('never recommends a version that is security-only or end-of-life', () => {
    for (const [type, entry] of ENTRIES) {
      const match = entry.options.find((o) => o.version === entry.recommended);
      expect(match?.support, type).not.toBe('eol');
      expect(match?.support, type).not.toBe('security');
    }
  });

  it('lists versions without duplicates and gives every entry a display name', () => {
    for (const [type, entry] of ENTRIES) {
      const versions = entry.options.map((o) => o.version);
      expect(new Set(versions).size, type).toBe(versions.length);
      expect(entry.name.length, type).toBeGreaterThan(0);
    }
  });

  it('uses ISO dates for every eol it records', () => {
    for (const [, entry] of ENTRIES) {
      for (const option of entry.options) {
        if (option.eol !== undefined) expect(option.eol).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});

describe('runtimeVersionOptions', () => {
  it('returns the catalog options for a pinnable runtime', () => {
    expect(runtimeVersionOptions('node').length).toBeGreaterThan(0);
  });

  it('returns an empty list for runtimes with no version axis', () => {
    expect(runtimeVersionOptions('auto')).toEqual([]);
    expect(runtimeVersionOptions('static')).toEqual([]);
  });
});

describe('recommendedRuntimeVersion', () => {
  it('returns the catalog recommendation', () => {
    expect(recommendedRuntimeVersion('node')).toBe(RUNTIME_VERSION_CATALOG.node?.recommended);
  });

  it('returns undefined for runtimes with no version axis', () => {
    expect(recommendedRuntimeVersion('auto')).toBeUndefined();
  });
});

describe('findRuntimeVersion', () => {
  it('matches an exact version', () => {
    expect(findRuntimeVersion('node', '24')?.version).toBe('24');
  });

  it('resolves a patch release to its series', () => {
    expect(findRuntimeVersion('node', '24.4.1')?.version).toBe('24');
    expect(findRuntimeVersion('python', '3.14.2')?.version).toBe('3.14');
  });

  it('prefers the longest matching prefix', () => {
    expect(findRuntimeVersion('python', '3.14.0')?.version).toBe('3.14');
  });

  it('does not match across a partial digit — "2" is not "24"', () => {
    expect(findRuntimeVersion('node', '2')).toBeUndefined();
  });

  it('returns undefined for an unknown version', () => {
    expect(findRuntimeVersion('node', '999')).toBeUndefined();
  });

  it('returns undefined for a runtime with no catalog entry', () => {
    expect(findRuntimeVersion('static', '1')).toBeUndefined();
  });
});

describe('runtimeVersionAdvisory', () => {
  it('says nothing about a supported version', () => {
    expect(runtimeVersionAdvisory('node', '24')).toBeNull();
  });

  it('says nothing when no version is pinned', () => {
    expect(runtimeVersionAdvisory('node', undefined)).toBeNull();
  });

  it('says nothing for a runtime with no version axis', () => {
    expect(runtimeVersionAdvisory('auto', '24')).toBeNull();
  });

  it('flags an end-of-life version as an error but still allows it', () => {
    const advisory = runtimeVersionAdvisory('node', '20');
    expect(advisory?.level).toBe('error');
    expect(advisory?.message).toContain('end-of-life');
    expect(advisory?.message).toContain('Upstream support: 2026-04-30.');
    expect(advisory?.message).toContain('You can still deploy it');
  });

  it('omits the support clause when the catalog records no eol date', () => {
    // Go publishes no dated EOL — support simply lapses two releases later.
    const advisory = runtimeVersionAdvisory('go', '1.25');
    expect(advisory?.level).toBe('error');
    expect(advisory?.message).not.toContain('Upstream support:');
  });

  it('warns about a security-only version and names the recommended pin', () => {
    const advisory = runtimeVersionAdvisory('python', '3.12');
    expect(advisory?.level).toBe('warn');
    expect(advisory?.message).toContain('security fixes only');
    expect(advisory?.message).toContain(RUNTIME_VERSION_CATALOG.python?.recommended ?? '');
  });

  it('marks a version the catalog has never heard of as unverified', () => {
    const advisory = runtimeVersionAdvisory('node', '99');
    expect(advisory?.level).toBe('info');
    expect(advisory?.message).toContain(RUNTIME_CATALOG_REVIEWED);
  });
});
