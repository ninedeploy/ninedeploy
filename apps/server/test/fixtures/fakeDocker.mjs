// A stand-in for the docker CLI in the R5 runner test. It records each call in
// the file named by a leading `--log <file>` (the runner gives `docker run` an
// environment of its own, so an environment variable would not reach it) and,
// for `run`, prints what the job container would see.
import { appendFileSync, readFileSync } from 'node:fs';

let args = process.argv.slice(2);
let log;
if (args[0] === '--log') {
  log = args[1];
  args = args.slice(2);
}
if (log) appendFileSync(log, `${args[0]} ${args.slice(1).join(' ')}\n`);

if (args[0] === 'ps') {
  // One container left by an earlier run of this runner.
  process.stdout.write('orphan-1\n');
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'ls') {
  // And its job network.
  process.stdout.write('orphan-net-1\n');
  process.exit(0);
}
if (args[0] !== 'run') process.exit(0);

const scriptMount = args[args.indexOf('-v', args.indexOf('-v') + 1) + 1] ?? '';
const script = readFileSync(scriptMount.split(':/nd-ci/')[0], 'utf8');
const names = [];
for (let i = 0; i < args.length; i++) if (args[i] === '-e' && !args[i + 1].includes('=')) names.push(args[i + 1]);
process.stdout.write(`image ${args[args.length - 3]}\n`);
for (const n of names) process.stdout.write(`${n}=${process.env[n] ?? ''}\n`);
process.stderr.write('a line on stderr\n');
process.exit(/exit 3/.test(script) ? 3 : 0);
