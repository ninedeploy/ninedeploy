// A stand-in for the docker CLI in the R5 runner test. It records each call in
// FAKE_DOCKER_LOG and, for `run`, prints what the job container would see.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env['FAKE_DOCKER_LOG'];
if (log) appendFileSync(log, `${args[0]} ${args.slice(1).join(' ')}\n`);

if (args[0] === 'ps') {
  // One container left by an earlier run of this runner.
  process.stdout.write('orphan-1\n');
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
