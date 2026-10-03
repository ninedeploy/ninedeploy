import { describe, expect, it } from 'vitest';
import { diffLines, renderDiff } from '../../src/lib/diff.js';

describe('lib/diff', () => {
  it('returns an empty diff for identical inputs', () => {
    const ops = diffLines(['a', 'b'], ['a', 'b']);
    expect(ops).toEqual([
      { kind: 'same', line: 'a' },
      { kind: 'same', line: 'b' },
    ]);
    expect(renderDiff(ops)).toBe('  a\n  b');
  });

  it('marks added and removed lines', () => {
    const ops = diffLines(['a', 'old', 'c'], ['a', 'new', 'c']);
    expect(ops).toEqual([
      { kind: 'same', line: 'a' },
      { kind: 'del', line: 'old' },
      { kind: 'add', line: 'new' },
      { kind: 'same', line: 'c' },
    ]);
  });

  it('handles fully disjoint inputs', () => {
    const ops = diffLines(['x'], ['y']);
    expect(ops).toEqual([
      { kind: 'del', line: 'x' },
      { kind: 'add', line: 'y' },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffLines([], ['y'])).toEqual([{ kind: 'add', line: 'y' }]);
    expect(diffLines(['x'], [])).toEqual([{ kind: 'del', line: 'x' }]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('falls back to all-del/add beyond the size cap', () => {
    const big = Array.from({ length: 2001 }, (_, i) => `line-${i}`);
    const ops = diffLines(big, ['other']);
    expect(ops.filter((o) => o.kind === 'del')).toHaveLength(2001);
    expect(ops.filter((o) => o.kind === 'add')).toHaveLength(1);
  });

  it('renders a unified-style block', () => {
    const text = renderDiff(diffLines(['keep'], ['keep', 'plus']));
    expect(text).toBe('  keep\n+ plus');
  });
});
