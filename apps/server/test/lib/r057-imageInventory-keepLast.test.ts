/**
 * Proof: r057 — pruneImages ignores keepLast when danglingOnly=true.
 *
 * Bug: when danglingOnly=true, the function early-returns to `docker image prune -f`
 * without consulting keepLast.
 *
 * Root cause: keepLast is parsed (line ~144) but unreachable in the danglingOnly
 * early-return branch (lines ~150-165). The danglingOnly path runs `docker image prune -f`
 * directly, bypassing the keep-window logic entirely.
 *
 * Proof strategy: replicate the keep-window logic from pruneImages and verify that
 * with danglingOnly=true, keepLast is never consulted. This is a code-trace proof,
 * not a mock test — we inspect the module's source directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('r057 — pruneImages ignores keepLast when danglingOnly=true', () => {
  it('keepLast is honoured in the danglingOnly branch (regression r057)', () => {
    // Read the module source so this test is immune to mock/import issues.
    // pnpm --filter server runs from apps/server/, so process.cwd() there.
    const src = readFileSync(
      `${process.cwd().replace(/\\/g, '/')}/src/lib/imageInventory.ts`,
      'utf8',
    );

    // Find the danglingOnly branch: the guard that short-circuits.
    const danglingOnlyIdx = src.indexOf('danglingOnly');
    expect(danglingOnlyIdx, 'danglingOnly keyword must exist in source').toBeGreaterThan(0);

    // Extract the danglingOnly branch — find its containing if-block.
    // Pattern: "if (danglingOnly) {" followed by the block body.
    const danglingBranchStart = src.indexOf('if (danglingOnly)', danglingOnlyIdx - 50);
    expect(danglingBranchStart, 'if (danglingOnly) guard must exist').toBeGreaterThan(0);

    // Walk forward to find the opening brace.
    const blockOpen = src.indexOf('{', danglingBranchStart);
    expect(blockOpen, 'block opening brace must exist').toBeGreaterThan(0);

    // Count braces to find the block end.
    let depth = 0;
    let blockEnd = blockOpen;
    for (let i = blockOpen; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}') { depth--; if (depth === 0) { blockEnd = i; break; } }
    }

    const danglingBlock = src.slice(blockOpen + 1, blockEnd);

    // ── THE FAILING ASSERTION ────────────────────────────────────────────
    // Pre-fix: danglingOnly block calls `docker image prune -f` directly.
    // keepLast is never referenced in this block.
    // Post-fix: either keepLast is checked here, or the option is rejected
    // with a clear error.
    //
    // We assert that keepLast must appear in the danglingOnly block.
    // Pre-fix: keepLast is absent → test FAILS.
    // Post-fix: keepLast is checked → test PASSES.
    expect(
      danglingBlock.includes('keepLast'),
      `keepLast must be honoured in the danglingOnly branch. ` +
      `Pre-fix bug: the danglingOnly early-return (lines ${danglingBranchStart + 1}–${blockEnd + 1}) ` +
      `issues 'docker image prune -f' directly, bypassing the keep-window logic. ` +
      `A user who calls pruneImages({ keepLast: 5, danglingOnly: true }) expects ` +
      `the 5 newest dangling images to be protected, but they are pruned regardless. ` +
      `The keepLast variable is defined before this branch but is unreachable within it.`
    ).toBe(true);
  });
});
