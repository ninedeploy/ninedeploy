import { describe, expect, it } from 'vitest';
import { globToRegExp, isSafeWatchPath, matchesAny, parseWatchPaths } from '../../src/lib/glob.js';

describe('globToRegExp', () => {
  it('matches exact paths and rejects others', () => {
    const re = globToRegExp('apps/api/index.ts');
    expect(re.test('apps/api/index.ts')).toBe(true);
    expect(re.test('apps/api/other.ts')).toBe(false);
  });

  it('supports * within a segment (not across /)', () => {
    const re = globToRegExp('apps/*/index.ts');
    expect(re.test('apps/api/index.ts')).toBe(true);
    expect(re.test('apps/web/src/index.ts')).toBe(false);
  });

  it('supports ** across segments', () => {
    const re = globToRegExp('services/api/**');
    expect(re.test('services/api/src/main.ts')).toBe(true);
    expect(re.test('services/api/nested/deep/x.ts')).toBe(true);
    expect(re.test('services/web/src/x.ts')).toBe(false);
  });

  it('a/**/b collapses slashes so a/b matches', () => {
    const re = globToRegExp('a/**/b');
    expect(re.test('a/b')).toBe(true);
    expect(re.test('a/x/y/b')).toBe(true);
  });

  it('supports ? as a single non-slash char', () => {
    const re = globToRegExp('file?.ts');
    expect(re.test('file1.ts')).toBe(true);
    expect(re.test('file12.ts')).toBe(false);
    expect(re.test('file/.ts')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern', () => {
    const re = globToRegExp('a.b+c(d)');
    expect(re.test('a.b+c(d)')).toBe(true);
    expect(re.test('aXbYcZd')).toBe(false);
  });

  it('ignores a leading slash', () => {
    expect(globToRegExp('/src/x.ts').test('src/x.ts')).toBe(true);
  });
});

describe('matchesAny', () => {
  it('returns true when any pattern matches', () => {
    expect(matchesAny('packages/lib/a.ts', ['apps/**', 'packages/**'])).toBe(true);
    expect(matchesAny('docs/readme.md', ['apps/**', 'packages/**'])).toBe(false);
  });

  it('agrees with the documented glob language on multi-star patterns', () => {
    // ** crosses slashes and folds one following slash.
    expect(matchesAny('a/b', ['a/**/b'])).toBe(true);
    expect(matchesAny('a/x/y/b', ['a/**/b'])).toBe(true);
    expect(matchesAny('a/b/c', ['a/**/b'])).toBe(false);
    // * and ? never cross a slash.
    expect(matchesAny('apps/api/index.ts', ['apps/*/index.ts'])).toBe(true);
    expect(matchesAny('apps/x/y/index.ts', ['apps/*/index.ts'])).toBe(false);
    expect(matchesAny('file1.ts', ['file?.ts'])).toBe(true);
    expect(matchesAny('file/.ts', ['file?.ts'])).toBe(false);
    // Leading slashes on the path are stripped, like globToRegExp does for patterns.
    expect(matchesAny('/src/x.ts', ['src/x.ts'])).toBe(true);
  });

  it('answers a 4-deep-star pattern on a long non-matching path quickly (ReDoS r006)', () => {
    // The pattern budget ACCEPTS this pattern (4 deep stars <= 4), and the
    // regex it compiled — `^(?:(?:.*)a(?:.*)b(?:.*)c(?:.*)d)$` — backtracked
    // ~C(4000,3) steps on this input before the bounded matcher replaced it,
    // never returning. The DP answers in ~1ms with the exact verdict.
    expect(isSafeWatchPath('**a**b**c**d')).toBe(true);
    const start = performance.now();
    expect(matchesAny(`${'a'.repeat(3999)}z`, ['**a**b**c**d'])).toBe(false);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('fails open for over-long paths instead of matching unbounded input', () => {
    // > MAX_MATCH_INPUT: treated as a hit without running the matcher — a
    // literal that cannot match still returns true (documented fail-open).
    expect(matchesAny('x'.repeat(5000), ['y'])).toBe(true);
  });

  it('completes the historically-hanging 200k-char webhook path (fail-open)', () => {
    // Before the bounded matcher this input against `apps/**/a**b` never
    // returned — one verified push payload could hang the event loop.
    const start = performance.now();
    expect(matchesAny(`apps/${'a'.repeat(199994)}z`, ['apps/**/a**b'])).toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('parseWatchPaths', () => {
  it('drops patterns that could create pathological regex backtracking', () => {
    expect(isSafeWatchPath('**'.repeat(5))).toBe(false);
    expect(isSafeWatchPath('*'.repeat(17))).toBe(false);
    expect(parseWatchPaths('**'.repeat(5))).toEqual([]);
  });

  it('splits on newlines and commas, trimming blanks', () => {
    expect(parseWatchPaths('a/**, b/*\n\n  c  ')).toEqual(['a/**', 'b/*', 'c']);
    expect(parseWatchPaths(null)).toEqual([]);
    expect(parseWatchPaths('   ')).toEqual([]);
  });
});
