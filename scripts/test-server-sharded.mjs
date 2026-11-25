#!/usr/bin/env node
// Runs the server package's unit suite in several processes at once, and checks its coverage
// floors once, on the merged report. `pnpm test:server`; SERVER_TEST_SHARDS sets how many.
//
// Why: apps/server/vitest.config.ts runs the files one after another on purpose. An invocation
// has one data root, and tests that share it must not overlap. One after another, the 888 files
// took 39 minutes of a CI runner on November 25, 2026. A shard is an invocation of its own, with
// a data root of its own and its files still one after another, so shards cannot meet each other.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directoryRows, keysFromRoot, mergeReports, percentages, readThresholds, shardCount, summaryDocument, unmetThresholds } from './lib/server-test-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'apps', 'server');
const coverage = path.join(server, 'coverage');
const shardsDir = path.join(coverage, 'shards');
const gib = totalmem() / 2 ** 30;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a setting for this standalone runner, outside any Turbo task.
const count = shardCount(process.env.SERVER_TEST_SHARDS, availableParallelism(), gib);
const started = Date.now();
const minutes = () => `${((Date.now() - started) / 60_000).toFixed(1)} minutes`;
// ANSI colour sequences. ESC is built at runtime: Biome rejects control characters in a literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

rmSync(shardsDir, { recursive: true, force: true });
mkdirSync(shardsDir, { recursive: true });
console.log(`server unit suite in ${count} shards at once, on ${availableParallelism()} cores with ${gib.toFixed(1)} GiB`);

// Each shard writes the `json` reporter's document, for the merge. Its own floors are set to zero:
// one shard covers one part of the source, and the floors are checked once, on the merged report.
const logs = Array.from({ length: count }, () => []);
const outcomes = [];
await Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve) => {
  const n = i + 1;
  const dir = path.join(shardsDir, `shard-${n}`);
  mkdirSync(dir, { recursive: true });
  const args = [
    path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--coverage',
    `--shard=${n}/${count}`, '--coverage.reporter=json', `--coverage.reportsDirectory=${path.join('coverage', 'shards', `shard-${n}`)}`,
    '--coverage.thresholds.statements=0', '--coverage.thresholds.branches=0', '--coverage.thresholds.functions=0', '--coverage.thresholds.lines=0',
  ];
  const child = spawn(process.execPath, args, { cwd: server, stdio: ['ignore', 'pipe', 'pipe'] });
  // A shard's output goes to its own file as it comes, and to the log under its heading once every shard has ended.
  const take = (stream) => stream.setEncoding('utf8').on('data', (text) => {
    appendFileSync(path.join(dir, 'vitest.log'), text);
    for (const line of text.replaceAll('\r\n', '\n').split('\n')) if (line.trim()) logs[i].push(line.replace(ANSI, ''));
  });
  take(child.stdout); take(child.stderr);
  const ended = (code, signal) => {
    const line = `server shard ${n}/${count}: ${signal ? `killed by ${signal}` : code === 0 ? 'passed' : `FAILED (exit ${code})`} after ${minutes()}`;
    outcomes[i] = { n, ok: code === 0, killed: Boolean(signal), line };
    console.log(line);
    resolve(code ?? 1);
  };
  child.on('error', (error) => { logs[i].push(String(error)); ended(1, undefined); });
  child.on('exit', (code, signal) => ended(code, signal));
})));

// Every shard's output goes to the log as the single invocation's did: which files ran, how long
// each took, and what failed.
for (const [i, outcome] of outcomes.entries()) console.log(`\n===== ${outcome.line} =====\n${logs[i].join('\n')}`);
const failed = outcomes.filter((outcome) => !outcome.ok);
const killed = failed.some((outcome) => outcome.killed);
const table = (title, rows) => {
  console.log(`\n${title}`);
  console.log('File                | % Stmts | % Branch | % Funcs | % Lines');
  console.log('--------------------|---------|----------|---------|---------');
  for (const row of rows) console.log(`${row.name.padEnd(19)} | ${row.pct.statements.toFixed(2).padStart(7)} | ${row.pct.branches.toFixed(2).padStart(8)} | ${row.pct.functions.toFixed(2).padStart(7)} | ${row.pct.lines.toFixed(2).padStart(7)}`);
};

if (failed.length) {
  const why = killed ? ' A shard killed by a signal most likely ran out of memory: SERVER_TEST_SHARDS sets how many run at once.' : '';
  console.log(`\nserver unit suite: shard ${failed.map((outcome) => outcome.n).join(', ')} of ${count} failed in ${minutes()}; coverage was not checked.${why}`);
  process.exitCode = 1;
} else {
  const reports = [];
  for (let n = 1; n <= count; n += 1) reports.push(keysFromRoot(JSON.parse(readFileSync(path.join(shardsDir, `shard-${n}`, 'coverage-final.json'), 'utf8')), root));
  const map = mergeReports(reports);
  const summary = map.getCoverageSummary();
  const thresholds = readThresholds(readFileSync(path.join(server, 'vitest.config.ts'), 'utf8'));
  // Where the single invocation wrote them, for whatever reads the reports afterwards.
  writeFileSync(path.join(coverage, 'coverage-final.json'), `${JSON.stringify(map.toJSON())}\n`);
  writeFileSync(path.join(coverage, 'coverage-summary.json'), `${JSON.stringify(summaryDocument(map), null, 2)}\n`);
  table(`Coverage report from ${count} shards, merged`, [
    { name: 'All files', pct: percentages(summary) },
    ...directoryRows(map).map((row) => ({ name: (row.dir.replace(/^\/apps\/server\/src/, 'src') || 'src').slice(0, 19), pct: row.pct })),
  ]);
  const unmet = unmetThresholds(summary, thresholds);
  console.log(`\nserver unit suite: ${count} shards passed in ${minutes()}; ${unmet.length ? unmet.join('\n') : 'every coverage floor is met'}`);
  process.exitCode = unmet.length ? 1 : 0;
}
