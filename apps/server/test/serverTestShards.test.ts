import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SHARD_GIB, chunkFiles, directoryRows, durationsDocument, fileDuration, keysFromRoot, lineSplitter, mergeReports, parseDurations, parseFileList, passedFiles, percentages, readThresholds, shardCount, summaryDocument, unmetThresholds } from '../../../scripts/lib/server-test-shards.mjs';

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

  it('packs the chunks by what each file took in the run before, the heaviest first', () => {
    // Which chunk the queue ended with was chance, and on November 26, 2026 the last one cost
    // the suite from a minute on a fast runner to four on a slow one.
    const listed = Array.from({ length: 48 }, (_, i) => `test/file-${String(i).padStart(2, '0')}.test.ts`);
    const files = Object.fromEntries(listed.map((file, i) => [file, i === 7 ? 240_000 : 1000 * (i % 5)]));
    const durations = parseDurations(JSON.stringify({ version: 1, load: 1600, median: 2000, files }))!;
    const cost = (file: string) => (durations.files[file] ?? durations.median) + durations.load;
    const weight = (chunk: string[]) => chunk.reduce((sum, file) => sum + cost(file), 0);
    const chunks = chunkFiles(listed, 6, durations);
    expect(chunks).toHaveLength(24);
    // Every file once, and the heaviest chunks first in the queue.
    expect([...chunks.flat()].sort()).toEqual([...listed].sort());
    expect(new Set(chunks.flat()).size).toBe(listed.length);
    const weights = chunks.map(weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    // The one heavy file has a chunk to itself, and the rest are level to within one file.
    expect(chunks[0]).toEqual(['test/file-07.test.ts']);
    expect(Math.max(...weights.slice(1)) - Math.min(...weights.slice(1))).toBeLessThanOrEqual(Math.max(...listed.slice(8).map(cost)));
    // Fewer files than chunks: one file a chunk, and no empty chunk.
    expect(chunkFiles(['test/only.test.ts'], 6, durations)).toEqual([['test/only.test.ts']]);
    expect(chunkFiles([], 6, durations)).toEqual([]);
    // Without durations the files are dealt round-robin.
    expect(chunkFiles(listed, 6)).toEqual(chunkFiles(listed, 6, null));
  });

  it("reads each file's own time from the lines a chunk printed, and leaves them for the next run", () => {
    expect(fileDuration(' ✓ test/a.test.ts (14 tests) 354ms')).toEqual(['test/a.test.ts', 354]);
    expect(fileDuration(' ✓ test/b.test.ts (3 tests | 1 skipped) 77ms')).toEqual(['test/b.test.ts', 77]);
    const green = String.fromCharCode(27);
    expect(fileDuration(` ${green}[32m✓${green}[39m test/c.test.ts (1 test) 5ms`)).toEqual(['test/c.test.ts', 5]);
    // A failed file, or the summary: nothing to take.
    expect(fileDuration(' ❯ test/d.test.ts (2 tests | 1 failed) 9ms')).toBeNull();
    expect(fileDuration(' Test Files  3 passed (3)')).toBeNull();
    const lines = [' ✓ test/a.test.ts (14 tests) 354ms', 'noise', ' ✓ test/b.test.ts (3 tests | 1 skipped) 77ms', ' ✓ test/c.test.ts (1 test) 5ms'];
    const document = durationsDocument(lines, 60_000, 3);
    expect(document).toEqual({ version: 1, load: (60_000 - 436) / 3, median: 77, files: { 'test/a.test.ts': 354, 'test/b.test.ts': 77, 'test/c.test.ts': 5 } });
    // What was written is what the next run reads.
    expect(parseDurations(JSON.stringify(document))).toEqual(document);
    // The same file printed twice keeps the longer time.
    expect(durationsDocument([' ✓ test/a.test.ts (14 tests) 354ms', ' ✓ test/a.test.ts (14 tests) 400ms'], 0, 1).files).toEqual({ 'test/a.test.ts': 400 });
    expect(durationsDocument([], 0, 0)).toEqual({ version: 1, load: 0, median: 0, files: {} });
    // Nothing, or not one: no durations.
    expect(parseDurations('')).toBeNull();
    expect(parseDurations('{"version":2,"load":1,"median":1,"files":{}}')).toBeNull();
    expect(parseDurations('{"version":1,"load":1,"median":1,"files":null}')).toBeNull();
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
  it('is what CI and the release gate run', () => {
    const pkg = JSON.parse(at('package.json')) as { scripts: Record<string, string> };
    type Job = { name?: string; needs?: string | string[]; steps: { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }[] };
    const ci = load(at('.github/workflows/ci.yml')) as { jobs: Record<string, Job> };
    const testOf = (id: string) => ci.jobs[id]!.steps.find((step) => step.name === 'Test')?.run;
    // CI: the server suite in the verify job, the other packages' suites in a job on a runner of their own,
    // and the image only after both.
    expect(ci.jobs.verify!.name).toBe('Typecheck · Lint · Build · Test');
    expect(testOf('verify')).toBe('pnpm test:server');
    expect(testOf('package-tests')).toBe('pnpm test:packages');
    expect([ci.jobs['publish-image']!.needs ?? []].flat()).toEqual(['verify', 'contract-preflight', 'package-tests', 'integration', 'docker-image']);
    // The release gate runs the same two, one after the other.
    expect(pkg.scripts['test:packages']).toBe('pnpm turbo run test --concurrency=1 --force --filter=!@ninedeploy/server');
    expect(pkg.scripts['test:workspace']).toBe('pnpm test:packages && pnpm test:server');
    expect(pkg.scripts['test:server']).toBe('node scripts/test-server-sharded.mjs');
    // CI hands the runner what the run before wrote for each file, and keeps what this one writes.
    const steps = ci.jobs.verify!.steps;
    const test = steps.findIndex((step) => step.name === 'Test');
    const taken = steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/cache@'));
    expect(taken).toBeGreaterThan(-1);
    expect(taken).toBeLessThan(test);
    expect(steps[taken]!.with).toMatchObject({ path: 'apps/server/.test-durations.json', 'restore-keys': 'server-test-durations-' });
    expect(steps[test]!.env).toEqual({ SERVER_TEST_DURATIONS: 'apps/server/.test-durations.json' });
    // The release gate sets nothing: there the chunks are dealt round-robin.
    expect(at('scripts/test-server-sharded.mjs')).toContain('chunkFiles(files, workers, durations)');
    expect(at('.gitignore')).toContain('apps/server/.test-durations.json');
    expect(pkg.scripts['release:check'].startsWith('node scripts/check-node-version.mjs && ')).toBe(true);
    expect(pkg.scripts['release:check'].endsWith('pnpm test:workspace')).toBe(true);
  });
});
