import type { AgentOpResult } from './agentClient.js';

/** Accept only the one env file this request asked the node to write. */
export function confirmedNodeEnvFile(result: AgentOpResult, name: string): string {
  const file = `.agent-env/${name}.env`;
  const receipts = result.lines.filter(line => line.startsWith('wrote '));
  if (result.exitCode !== 0 || receipts.length !== 1 || receipts[0] !== `wrote ${file}`) {
    throw new Error('Node environment file receipt is unconfirmed; deployment was not started');
  }
  return file;
}
