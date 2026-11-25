#!/usr/bin/env node
// Runs the workspace's tests: first the packages whose tests keep Vitest's 5-second limit, alone
// as before; then two streams at once — the web and CLI suites, one package at a time — and
// beside them the server suite in its processes (`pnpm test:server`), at a lower CPU priority.
// `pnpm test:workspace`; CI's `Test` step and `release:check` both run it.
//
// Why: the other packages ran first, one after the other, and the server suite began only when
// they had ended. The server suite's processes leave cores idle (timers, child processes), so
// the web and CLI suites fit beside them. A stream that fails does not stop the other: a run
// then shows every failure there is, and ends with a line for each.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { streamOutcome, workspacePlan } from './lib/server-test-shards.mjs';

if (process.argv.length > 2) {
  console.error('usage: pnpm test:workspace (it takes no arguments)');
  process.exit(2);
}
const plan = workspacePlan();
const cwd = fileURLToPath(new URL('..', import.meta.url));
const started = Date.now();
const minutes = () => `${((Date.now() - started) / 60_000).toFixed(1)} minutes`;

// On Windows pnpm is a `.cmd`, which cannot be started without a shell; the arguments are constants.
const start = (name, args, lowPriority = false) => new Promise((resolve) => {
  // `nice` is inherited: every server process then yields a core to the packages' tests, and
  // takes what they leave, which is most of the runner.
  const nice = lowPriority && process.platform !== 'win32';
  const child = spawn(nice ? 'nice' : 'pnpm', nice ? ['-n', '10', 'pnpm', ...args] : args, { cwd, shell: process.platform === 'win32', stdio: ['ignore', 'inherit', 'inherit'] });
  const ended = (code, signal) => {
    console.log(`workspace tests, ${name}: ${streamOutcome(code, signal)} after ${minutes()}`);
    resolve(signal ? 1 : code);
  };
  child.on('error', (error) => { console.error(`workspace tests, ${name}: could not be started: ${String(error)}`); ended(1, undefined); });
  child.on('exit', (code, signal) => ended(code, signal));
});

const alone = await start('the packages that keep the 5-second test limit', plan.alone);
console.log('then two streams at once: the web and CLI suites, and beside them the server suite');
const codes = alone === 0 ? await Promise.all([
  start('stream "packages"', plan.beside.packages),
  start('stream "server"', plan.beside.server, true),
]) : [alone];
process.exitCode = codes.every((code) => code === 0) ? 0 : 1;
