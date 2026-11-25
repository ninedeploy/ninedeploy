#!/usr/bin/env node
// Runs the workspace's tests as two streams at once: every other package's suite, one package at
// a time, and beside it the server suite in its processes (`pnpm test:server`).
// `pnpm test:workspace`; CI's `Test` step and `release:check` both run it.
//
// Why: the other packages ran first, one after the other, and the server suite began only when
// they had ended. The server suite's processes leave cores idle (timers, child processes), so
// the other packages fit beside them. One stream failing does not stop the other: a run then
// shows every failure there is, and ends with a line for each stream.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { streamOutcome, workspaceStreams } from './lib/server-test-shards.mjs';

if (process.argv.length > 2) {
  console.error('usage: pnpm test:workspace (it takes no arguments)');
  process.exit(2);
}
const streams = workspaceStreams();
const started = Date.now();
console.log(`workspace tests in two streams at once: "${Object.keys(streams).join(')" and "')}"`);
const codes = await Promise.all(Object.entries(streams).map(([name, args]) => new Promise((resolve) => {
  // On Windows pnpm is a `.cmd`, which cannot be started without a shell; the arguments are constants.
  const child = spawn('pnpm', args, { cwd: fileURLToPath(new URL('..', import.meta.url)), shell: process.platform === 'win32', stdio: ['ignore', 'inherit', 'inherit'] });
  const ended = (code, signal) => {
    const after = `${((Date.now() - started) / 60_000).toFixed(1)} minutes`;
    console.log(`workspace tests, stream "${name}": ${streamOutcome(code, signal)} after ${after}`);
    resolve(signal ? 1 : code);
  };
  child.on('error', (error) => { console.error(`workspace tests, stream "${name}": could not be started: ${String(error)}`); ended(1, undefined); });
  child.on('exit', (code, signal) => ended(code, signal));
})));
process.exitCode = codes.every((code) => code === 0) ? 0 : 1;
