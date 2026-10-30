import { runOp } from '../../src/agent.js';

const [op, encoded] = process.argv.slice(2);
try {
  await runOp(op!, JSON.parse(encoded!), line => process.stdout.write(`${line}\n`), { sealed: true });
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
