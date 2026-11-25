#!/usr/bin/env node
// Runs the server package's unit suite in several processes at once, and checks its coverage
// floors once, on the merged report. `pnpm test:server`; SERVER_TEST_SHARDS sets how many run at once.
//
// Why: apps/server/vitest.config.ts runs the files one after another on purpose. An invocation
// has one data root, and tests that share it must not overlap. One after another, the 888 files
// took 39 minutes of a CI runner on November 25, 2026. A process here is an invocation of its
// own, with a data root of its own and its files still one after another, so the processes
// cannot meet each other.
//
// The files are cut into small chunks, and the processes take the chunks in turn. Vitest's own
// `--shard` cuts alphabetical ranges, and the heaviest files sit together in them: with six
// ranges on GitHub's runner the slowest took 11.5 minutes against an average of 6.6. A chunk is
// a quarter of a process's work, so the suite ends little later than its slowest chunk.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkFiles, directoryRows, keysFromRoot, lineSplitter, mergeReports, parseFileList, passedFiles, percentages, readThresholds, shardCount, summaryDocument, unmetThresholds } from './lib/server-test-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'apps', 'server');
const coverage = path.join(server, 'coverage');
const chunksDir = path.join(coverage, 'chunks');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const gib = totalmem() / 2 ** 30;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a setting for this standalone runner, outside any Turbo task.
const workers = shardCount(process.env.SERVER_TEST_SHARDS, availableParallelism(), gib);
const started = Date.now();
const minutes = () => `${((Date.now() - started) / 60_000).toFixed(1)} minutes`;
// ANSI colour sequences. ESC is built at runtime: Biome rejects control characters in a literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// The files as Vitest itself picks them, so nothing runs that it would not, and nothing is missed.
const files = parseFileList(execFileSync(process.execPath, [vitest, 'list', '--filesOnly'], { cwd: server, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
if (!files.length) throw new Error('Vitest listed no test files for apps/server');
const chunks = chunkFiles(files, workers);
rmSync(chunksDir, { recursive: true, force: true });
mkdirSync(chunksDir, { recursive: true });
console.log(`server unit suite: ${files.length} files in ${chunks.length} chunks, ${workers} processes at once, on ${availableParallelism()} cores with ${gib.toFixed(1)} GiB`);

// Each chunk writes the `json` reporter's document, for the merge. Its own floors are set to zero:
// a chunk covers one part of the source, and the floors are checked once, on the merged report.
const outcomes = new Array(chunks.length);
const logs = chunks.map(() => []);
let next = 0;
const run = (chunk, i, worker) => new Promise((resolve) => {
  const dir = path.join(chunksDir, `chunk-${i + 1}`);
  mkdirSync(dir, { recursive: true });
  const args = [
    vitest, 'run', '--coverage', '--coverage.reporter=json', `--coverage.reportsDirectory=${path.join('coverage', 'chunks', `chunk-${i + 1}`)}`,
    '--coverage.thresholds.statements=0', '--coverage.thresholds.branches=0', '--coverage.thresholds.functions=0', '--coverage.thresholds.lines=0',
    ...chunk,
  ];
  const child = spawn(process.execPath, args, { cwd: server, stdio: ['ignore', 'pipe', 'pipe'] });
  const outcome = { n: i + 1, files: chunk.length, passed: 0, ok: false, killed: false, line: '' };
  // A chunk's output goes to its own file as it comes, and to the log under its heading at the end.
  // Its lines arrive in pieces, so they are joined before one is read.
  const complete = lineSplitter();
  const note = (line) => {
    if (!line.trim()) return;
    const clean = line.replace(ANSI, '');
    logs[i].push(clean);
    const passed = passedFiles(clean);
    if (passed !== null) outcome.passed = passed;
  };
  const take = (stream) => stream.setEncoding('utf8').on('data', (text) => {
    appendFileSync(path.join(dir, 'vitest.log'), text);
    for (const line of complete(text)) note(line);
  });
  take(child.stdout); take(child.stderr);
  const ended = (code, signal) => {
    for (const line of complete('', true)) note(line);
    outcome.ok = code === 0;
    outcome.killed = Boolean(signal);
    outcome.line = `server chunk ${i + 1}/${chunks.length} (${chunk.length} files, process ${worker + 1}): ${signal ? `killed by ${signal}` : outcome.ok ? 'passed' : `FAILED (exit ${code})`} after ${minutes()}`;
    outcomes[i] = outcome;
    console.log(outcome.line);
    resolve();
  };
  child.on('error', (error) => { logs[i].push(String(error)); ended(1, undefined); });
  child.on('exit', (code, signal) => ended(code, signal));
});
await Promise.all(Array.from({ length: workers }, async (_, worker) => {
  for (let i = next++; i < chunks.length; i = next++) await run(chunks[i], i, worker);
}));

// Every chunk's output goes to the log as the single invocation's did: which files ran, how long
// each took, and what failed.
for (const [i, outcome] of outcomes.entries()) console.log(`\n===== ${outcome.line} =====\n${logs[i].join('\n')}`);
const failed = outcomes.filter((outcome) => !outcome.ok);
const killed = failed.some((outcome) => outcome.killed);
const ran = outcomes.reduce((sum, outcome) => sum + outcome.passed, 0);
const table = (title, rows) => {
  console.log(`\n${title}`);
  console.log('File                | % Stmts | % Branch | % Funcs | % Lines');
  console.log('--------------------|---------|----------|---------|---------');
  for (const row of rows) console.log(`${row.name.padEnd(19)} | ${row.pct.statements.toFixed(2).padStart(7)} | ${row.pct.branches.toFixed(2).padStart(8)} | ${row.pct.functions.toFixed(2).padStart(7)} | ${row.pct.lines.toFixed(2).padStart(7)}`);
};

if (failed.length) {
  const why = killed ? ' A chunk killed by a signal most likely ran out of memory: SERVER_TEST_SHARDS sets how many processes run at once.' : '';
  console.log(`\nserver unit suite: chunk ${failed.map((outcome) => outcome.n).join(', ')} of ${chunks.length} failed in ${minutes()}; coverage was not checked.${why}`);
  process.exitCode = 1;
} else if (ran !== files.length) {
  // Vitest takes a file as a filter by a match inside the path, so one path could name two files.
  console.log(`\nserver unit suite: ${ran} files passed, where Vitest lists ${files.length}: a file was run twice or not at all; coverage was not checked`);
  process.exitCode = 1;
} else {
  const reports = [];
  for (let n = 1; n <= chunks.length; n += 1) reports.push(keysFromRoot(JSON.parse(readFileSync(path.join(chunksDir, `chunk-${n}`, 'coverage-final.json'), 'utf8')), root));
  const map = mergeReports(reports);
  const summary = map.getCoverageSummary();
  const thresholds = readThresholds(readFileSync(path.join(server, 'vitest.config.ts'), 'utf8'));
  // Where the single invocation wrote them, for whatever reads the reports afterwards.
  writeFileSync(path.join(coverage, 'coverage-final.json'), `${JSON.stringify(map.toJSON())}\n`);
  writeFileSync(path.join(coverage, 'coverage-summary.json'), `${JSON.stringify(summaryDocument(map), null, 2)}\n`);
  table(`Coverage report from ${chunks.length} chunks, merged`, [
    { name: 'All files', pct: percentages(summary) },
    ...directoryRows(map).map((row) => ({ name: (row.dir.replace(/^\/apps\/server\/src/, 'src') || 'src').slice(0, 19), pct: row.pct })),
  ]);
  const unmet = unmetThresholds(summary, thresholds);
  console.log(`\nserver unit suite: ${files.length} files passed in ${minutes()} with ${workers} processes; ${unmet.length ? unmet.join('\n') : 'every coverage floor is met'}`);
  process.exitCode = unmet.length ? 1 : 0;
}
