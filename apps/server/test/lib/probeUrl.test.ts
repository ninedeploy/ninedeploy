import { describe, expect, it } from 'vitest';
import { buildProbeUrl, safeProbePath } from '../../src/lib/probeUrl.js';

describe('buildProbeUrl', () => {
  it('keeps a query string from the health path (splitQuery branch)', () => {
    expect(buildProbeUrl('app.local', 3000, '/health?verbose=1')).toBe('http://app.local:3000/health?verbose=1');
  });

  it('passes a plain path through without a query', () => {
    expect(buildProbeUrl('app.local', '3000', '/health')).toBe('http://app.local:3000/health');
  });

  it('prefixes a missing leading slash and defaults an empty path', () => {
    expect(buildProbeUrl('app.local', 3000, 'health')).toBe('http://app.local:3000/health');
    expect(buildProbeUrl('app.local', 3000, '')).toBe('http://app.local:3000/');
  });
});

describe('safeProbePath', () => {
  it('defaults null/blank to root', () => {
    expect(safeProbePath(null)).toBe('/');
    expect(safeProbePath(undefined)).toBe('/');
    expect(safeProbePath('   ')).toBe('/');
  });

  it('refuses paths without a leading slash', () => {
    expect(safeProbePath('health')).toBe('/');
  });

  it('refuses whitespace, @ and backslash escapes', () => {
    expect(safeProbePath('/a b')).toBe('/');
    expect(safeProbePath('/a@b')).toBe('/');
    expect(safeProbePath('/a\\b')).toBe('/');
  });

  it('keeps a clean path untouched', () => {
    expect(safeProbePath('/health?x=1')).toBe('/health?x=1');
  });
});
