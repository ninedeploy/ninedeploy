import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SHARD_GIB, chunkFiles, directoryRows, keysFromRoot, lineSplitter, mergeReports, parseFileList, passedFiles, percentages, readThresholds, shardCount, streamOutcome, summaryDocument, unmetThresholds, workspaceStreams } from '../../../scripts/lib/server-test-shards.mjs';

// The server unit suite runs in several processes at once (scripts/test-server-sharded.mjs).
// These hold what that relies on: the floors are read from the one place they are written, a
// report is merged without losing a line, a floor is checked as Vitest checks it, and CI and the
// release gate run the same tests.

const root = new URL('../../../', import.meta.url);
const at = (file: string) => readFileSync(new URL(file, root), 'utf8');

/** An Istanbul report of one file with two statements, each hit as often as `hits` says. */
function report(hits: [number, number], name = '/repo/apps/server/src/lib/a.ts') {
  return {
    [name]: {
      path: name,
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
        1: { start: { line: 2, column: 0 }, end: { line: 2, column: 4 } },
      },
      fnMap: {},
      branchMap: {},
      s: { 0: hits[0], 1: hits[1] },
      f: {},
      b: {},
    },
  };
}
const covered = { statements: 100, branches: 100, functions: 100, lines: 100 };

describe('the server suite in shards', () => {
  it('runs twice the cores, kept between 1 and 12, and only as many as the memory holds, unless the count is set', () => {
    expect(shardCount(undefined, 2)).toBe(4);
    expect(shardCount(undefined, 16)).toBe(12);
    expect(shardCount(undefined, 1)).toBe(2);
    // Eight shards in a 7.8 GiB container were killed for want of memory on November 25, 2026,
    // and three shards together held 5.8 GiB at their most.
    expect(shardCount(undefined, 4, 16)).toBe(Math.min(8, Math.floor((16 - 2) / SHARD_GIB)));
    expect(shardCount(undefined, 4, 7.8)).toBe(Math.floor((7.8 - 2) / SHARD_GIB));
    expect(shardCount(undefined, 32, 4)).toBe(1);
    expect(shardCount('3', 4, 4)).toBe(3);
    for (const bad of ['0', '-1', '2.5', 'many', ' ']) expect(() => shardCount(bad, 4)).toThrow(/whole number/);
    expect(() => shardCount(undefined, 0)).toThrow(/availableParallelism/);
  });

  it('reads the four floors from the server test configuration, from its last thresholds block', () => {
    expect(readThresholds(at('apps/server/vitest.config.ts'))).toEqual({ statements: 93.25, branches: 87.3, functions: 91, lines: 95.1 });
    const twoBlocks = 'thresholds: { statements: 10, branches: 10, functions: 10, lines: 10 }\n// a note in between\nthresholds: {\n // statements: 99,\n statements: 80.5, \n branches: 70,\nfunctions: 60, lines: 50, }';
    expect(readThresholds(twoBlocks)).toEqual({ statements: 80.5, branches: 70, functions: 60, lines: 50 });
    expect(() => readThresholds('test: {}')).toThrow(/could not read/);
    expect(() => readThresholds('thresholds: { statements: 120, branches: 70, functions: 60, lines: 50 }')).toThrow(/not a percentage/);
  });

  it('merges the shards so that a file keeps what any shard covered', () => {
    const single = mergeReports([report([1, 1])]);
    const split = mergeReports([keysFromRoot(report([1, 0]), '/repo'), keysFromRoot(report([0, 1], path.join('/repo', 'apps', 'server', 'src', 'lib', 'a.ts')), '/repo')]);
    expect(percentages(single.getCoverageSummary())).toEqual(covered);
    expect(percentages(split.getCoverageSummary())).toEqual(covered);
    expect(split.files()).toEqual(['/apps/server/src/lib/a.ts']);
    expect(unmetThresholds(split.getCoverageSummary(), readThresholds(at('apps/server/vitest.config.ts')))).toEqual([]);
  });

  it('names a floor the merged report does not meet, and passes a floor it meets exactly', () => {
    const half = mergeReports([report([1, 0])]).getCoverageSummary();
    expect(percentages(half)).toEqual({ ...covered, statements: 50, lines: 50 });
    expect(unmetThresholds(half, { statements: 50, branches: 100, functions: 100, lines: 50 })).toEqual([]);
    expect(unmetThresholds(half, { statements: 50.5, branches: 100, functions: 100, lines: 50.01 })).toEqual([
      'ERROR: Coverage for statements (50.00%) does not meet global threshold (50.5%)',
      'ERROR: Coverage for lines (50.00%) does not meet global threshold (50.01%)',
    ]);
  });

  it('names files from the workspace root, with a slash whatever the separator', () => {
    const windows = path.join('C:', 'repo', 'apps', 'server', 'src', 'lib', 'a.ts');
    expect(Object.keys(keysFromRoot(report([1, 0], windows), path.join('C:', 'repo')))).toEqual(['/apps/server/src/lib/a.ts']);
  });

  it('rolls the directories up, the one with most files first', () => {
    const map = mergeReports([
      report([1, 0]),
      report([0, 1], '/repo/apps/server/src/lib/b.ts'),
      report([1, 1], '/repo/apps/server/src/modules/c.ts'),
    ]);
    const rows = directoryRows(map);
    expect(rows.map((row) => row.dir)).toEqual(['/repo/apps/server/src/lib', '/repo/apps/server/src/modules']);
    expect(rows[0]).toMatchObject({ files: 2, pct: { statements: 50, lines: 50 } });
    expect(rows[1]).toMatchObject({ files: 1, pct: covered });
  });

  it('writes the summary document Vitest writes: every file, and the total', () => {
    const document = summaryDocument(mergeReports([report([1, 0]), report([0, 1], '/repo/apps/server/src/lib/b.ts')]));
    expect(Object.keys(document).sort()).toEqual(['/repo/apps/server/src/lib/a.ts', '/repo/apps/server/src/lib/b.ts', 'total']);
    expect(document.total.statements).toMatchObject({ total: 4, covered: 2, pct: 50 });
    expect(document['/repo/apps/server/src/lib/b.ts'].statements).toMatchObject({ total: 2, covered: 1, pct: 50 });
  });

  it('reads what Vitest lists and deals it into four chunks a process, every file once', () => {
    expect(parseFileList(['test/a.test.ts', '', ' test/lib/b.test.ts ', 'No test files found in test/diag', ''].join('\n'))).toEqual(['test/a.test.ts', 'test/lib/b.test.ts']);
    expect(parseFileList(['test/a.test.ts', 'test/lib/b.test.ts'].join(String.fromCharCode(13, 10)))).toEqual(['test/a.test.ts', 'test/lib/b.test.ts']);
    expect(parseFileList('')).toEqual([]);
    const listed = Array.from({ length: 889 }, (_, i) => `test/file-`.concat(String(i).padStart(3, '0'), '.test.ts'));
    const chunks = chunkFiles(listed, 6);
    expect(chunks).toHaveLength(24);
    // Dealt round-robin: the first chunk one file longer, and neighbours in different chunks.
    expect(chunks.map((chunk) => chunk.length)).toEqual([38, ...Array(23).fill(37)]);
    expect(chunks[0].slice(0, 3)).toEqual(['test/file-000.test.ts', 'test/file-024.test.ts', 'test/file-048.test.ts']);
    expect(chunks.flat().sort()).toEqual([...listed].sort());
    expect(new Set(chunks.flat()).size).toBe(listed.length);
    // Fewer files than chunks: one file a chunk, and no empty chunk.
    expect(chunkFiles(['test/only.test.ts'], 6)).toEqual([['test/only.test.ts']]);
    expect(chunkFiles(['test/a.test.ts', 'test/b.test.ts'], 6)).toEqual([['test/a.test.ts'], ['test/b.test.ts']]);
    expect(chunkFiles([], 6)).toEqual([]);
  });

  it('reads a summary from a stream that hands its lines over in pieces', () => {
    const complete = lineSplitter();
    const esc = String.fromCharCode(27);
    // The piece left over is put in front of what comes next, so the summary is one line again.
    const first = [' ✓ test/a.test.ts (2 tests) 5ms', ''].join('\n');
    expect(complete(`${first}  Test Files `)).toEqual([' ✓ test/a.test.ts (2 tests) 5ms']);
    const rest = ['2 passed (2)', '      Tests  2 passed (2)', ''].join('\n');
    expect(complete(rest)).toEqual(['  Test Files 2 passed (2)', '      Tests  2 passed (2)']);
    expect(complete('', true)).toEqual([]);
    // Vitest's summary as a pipe handed it over on GitHub's runner on November 25, 2026: no colour.
    const plain = [' ✓ test/a.test.ts (2 tests) 5ms', ' Test Files  2 passed (2)', '', '  Tests  2 passed (2)'].join('\n');
    expect(plain.split('\n').map(passedFiles)).toEqual([null, 2, null, null]);
    const coloured = ` ${esc}[1m${esc}[32m Test Files ${esc}[39m${esc}[22m 38 passed (38)`;
    expect(passedFiles(coloured)).toBe(38);
  });
  it('runs the other packages beside the server suite, and reports each stream on its own', () => {
    // One after the other, the other packages' minutes were all on the verify job's time.
    const streams = workspaceStreams();
    expect(Object.keys(streams)).toEqual(['packages', 'server']);
    // The packages still run one at a time, uncached, and the server package is left to its own stream.
    expect(streams.packages).toEqual(['turbo', 'run', 'test', '--concurrency=1', '--force', '--filter=!@ninedeploy/server']);
    expect(streams.server).toEqual(['test:server']);
    expect(streamOutcome(0, null)).toBe('passed');
    expect(streamOutcome(1, null)).toBe('FAILED (exit 1)');
    expect(streamOutcome(null, 'SIGKILL')).toBe('killed by SIGKILL');
    expect(readFileSync(new URL('../../../scripts/test-workspace.mjs', import.meta.url), 'utf8')).toContain("stdio: ['ignore', 'inherit', 'inherit']");
  });

  it('is what CI and the release gate run', () => {
    const pkg = JSON.parse(at('package.json')) as { scripts: Record<string, string> };
    const ci = load(at('.github/workflows/ci.yml')) as { jobs: { verify: { steps: { name?: string; run?: string }[] } } };
    const test = ci.jobs.verify.steps.find((step) => step.name === 'Test');
    expect(test?.run).toContain('pnpm test:workspace');
    expect(pkg.scripts['test:workspace']).toBe('node scripts/test-workspace.mjs');
    expect(pkg.scripts['test:server']).toBe('node scripts/test-server-sharded.mjs');
    expect(pkg.scripts['release:check'].startsWith('node scripts/check-node-version.mjs && ')).toBe(true);
    expect(pkg.scripts['release:check'].endsWith('pnpm test:workspace')).toBe(true);
  });
});
