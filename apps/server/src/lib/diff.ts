/**
 * Minimal line diff (LCS-based) for the deploy config-diff view. Config
 * snapshots are a few dozen lines at most, so the O(n·m) table is fine.
 */

export type DiffOp = { kind: 'same' | 'add' | 'del'; line: string };

/** Longest-common-subsequence diff of two line arrays. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // LCS length table (guard: cap at 2000×2000 to avoid runaway memory on
  // adversarial input; beyond that fall back to all-add/del).
  if (n > 2000 || m > 2000) {
    return [...a.map((line) => ({ kind: 'del' as const, line })), ...b.map((line) => ({ kind: 'add' as const, line }))];
  }
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', line: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', line: b[j]! });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: 'del', line: a[i]! });
  for (; j < m; j++) ops.push({ kind: 'add', line: b[j]! });
  return ops;
}

/** Render diff ops as a unified-style text block ("−" removed, "+" added). */
export function renderDiff(ops: readonly DiffOp[]): string {
  return ops
    .map((op) => (op.kind === 'add' ? `+ ${op.line}` : op.kind === 'del' ? `- ${op.line}` : `  ${op.line}`))
    .join('\n');
}
