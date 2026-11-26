// The server suite's runner (scripts/test-server-sharded.mjs), run as the program it is against
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the stand-in's code is text here.
// a stand-in for Vitest: what was listed is what ran, every file once; without a history the
// chunks are dealt round-robin, with one they are packed by it, the heaviest first; and a run
// leaves each file's time behind for the next one when it is asked to.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseDurations } from '../../../scripts/lib/server-test-shards.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const listed = Array.from({ length: 12 }, (_, i) => `test/file-${String(i).padStart(2, '0')}.test.ts`);
// What the stand-in says each file took: one file far heavier than the rest.
const own = (file: string) => (file === 'test/file-07.test.ts' ? 240_000 : 1000 * (Number(file.slice(10, 12)) % 5));
let home = '';

// The runner is copied under a home of its own with a stand-in for Vitest, so the repository's
// files and reports are not touched. The home sits inside the repository, where the coverage
// library the runner's functions use is resolved from.
beforeAll(() => {
  mkdirSync(path.join(root, 'apps', 'server', 'coverage'), { recursive: true });
  home = mkdtempSync(path.join(root, 'apps', 'server', 'coverage', 'runner-'));
  mkdirSync(path.join(home, 'scripts', 'lib'), { recursive: true });
  mkdirSync(path.join(home, 'node_modules', 'vitest'), { recursive: true });
  mkdirSync(path.join(home, 'apps', 'server'), { recursive: true });
  copyFileSync(path.join(root, 'scripts', 'test-server-sharded.mjs'), path.join(home, 'scripts', 'test-server-sharded.mjs'));
  copyFileSync(path.join(root, 'scripts', 'lib', 'server-test-shards.mjs'), path.join(home, 'scripts', 'lib', 'server-test-shards.mjs'));
  writeFileSync(path.join(home, 'apps', 'server', 'files.json'), JSON.stringify(listed));
  writeFileSync(path.join(home, 'apps', 'server', 'own.json'), JSON.stringify(Object.fromEntries(listed.map((file) => [file, own(file)]))));
  writeFileSync(path.join(home, 'apps', 'server', 'vitest.config.ts'), 'export default { test: { coverage: { thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 } } } };\n');
  writeFileSync(path.join(home, 'node_modules', 'vitest', 'vitest.mjs'), [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'list') {",
    "  for (const file of JSON.parse(readFileSync('files.json', 'utf8'))) console.log(file);",
    '} else {',
    "  const files = args.filter((arg) => arg.startsWith('test/'));",
    "  const own = JSON.parse(readFileSync('own.json', 'utf8'));",
    '  for (const file of files) console.log(` ✓ ${file} (3 tests) ${own[file]}ms`);',
    '  console.log(` Test Files  ${files.length} passed (${files.length})`);',
    "  const out = args.find((arg) => arg.startsWith('--coverage.reportsDirectory=')).slice('--coverage.reportsDirectory='.length);",
    '  mkdirSync(out, { recursive: true });',
    "  const source = path.resolve('src/a.ts');",
    '  const report = { path: source, statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } }, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} };',
    "  writeFileSync(path.join(out, 'coverage-final.json'), JSON.stringify({ [source]: report }));",
    '}',
    '',
  ].join('\n'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const run = (durations: string) => execFileSync(process.execPath, [path.join(home, 'scripts', 'test-server-sharded.mjs')], {
  cwd: home,
  env: { ...process.env, SERVER_TEST_SHARDS: '2', SERVER_TEST_DURATIONS: durations },
  encoding: 'utf8',
  timeout: 120_000,
});

it('deals the chunks round-robin, runs every listed file once, and leaves each file\'s time when asked', () => {
  const out = run('durations.json');
  expect(out).toContain('12 files in 6 chunks (dealt round-robin), 2 processes at once');
  expect(out).toContain('12 files passed in');
  const written = parseDurations(readFileSync(path.join(home, 'durations.json'), 'utf8'))!;
  expect(Object.keys(written.files)).toHaveLength(listed.length);
  expect(written.files['test/file-07.test.ts']).toBe(240_000);
  expect(written.median).toBe(1500);
  expect(written.load).toBeGreaterThanOrEqual(0);
  // The merged report and its summary are where the single invocation writes them.
  const summary = JSON.parse(readFileSync(path.join(home, 'apps', 'server', 'coverage', 'coverage-summary.json'), 'utf8'));
  expect(summary.total.lines.pct).toBe(100);
});

it('packs the chunks by what the run before wrote, the heaviest first', () => {
  writeFileSync(path.join(home, 'durations.json'), JSON.stringify({ version: 1, load: 1600, median: 2000, files: Object.fromEntries(listed.map((file) => [file, own(file)])) }));
  const out = run('durations.json');
  expect(out).toContain('12 files in 6 chunks (packed by what each file took in the run before)');
  expect(out).toContain('12 files passed in');
  // The heavy file's chunk is first in the queue, and it is that file alone.
  expect(out).toMatch(/server chunk 1\/6 \(1 files, process 1\): passed/);
  const first = out.slice(out.indexOf('===== server chunk 1/6'));
  expect(first.slice(0, first.indexOf('===== server chunk 2/6'))).toContain('✓ test/file-07.test.ts (3 tests) 240000ms');
});
