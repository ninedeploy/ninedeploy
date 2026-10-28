import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { AgentOpModule } from './index.js';
import { str, validated } from './operands.js';

/**
 * G4.3 security review: `agent.rekey {tokenSha256}` replaces the agent's
 * shared-key hash. The new hash is written to `.agent-token-sha256` in the
 * agent's working directory (its persistent volume), which `main()` prefers
 * over `NINEDEPLOY_AGENT_TOKEN`, and the process exits so Docker's
 * `unless-stopped` policy brings it back with the new key.
 *
 * Why: a node created through a cloud API gets its first hash in the VM's
 * user data, which any container on that node can read from the metadata
 * service. The panel rekeys the node right after the first sealed ping, so
 * that copy no longer opens anything. Sealed only, so only the current key
 * holder can rekey.
 */

/** File (relative to the agent's working directory) holding the rekeyed hash. */
export const AGENT_TOKEN_HASH_FILE = '.agent-token-sha256';

const RE_HASH = /^[0-9a-f]{64}$/;

/** The rekeyed hash, or null when the node was never rekeyed (or the file is unreadable). */
export function loadRekeyedTokenHash(dir = process.cwd()): string | null {
  const file = joinPath(dir, AGENT_TOKEN_HASH_FILE);
  if (!existsSync(file)) return null;
  try {
    const value = readFileSync(file, 'utf8').trim();
    return RE_HASH.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Test seam: how the agent restarts itself after a rekey. */
export const rekeyRestart = {
  exit: (): void => {
    process.exit(0);
  },
  delayMs: 500,
};

export const agentRekeyOps: AgentOpModule = {
  name: 'agentRekey',
  caps: ['agent.rekey'],
  ops: {
    'agent.rekey': {
      cap: 'agent.rekey',
      sealedOnly: true,
      async run(params, onLine) {
        const hash = validated(str(params, 'tokenSha256'), RE_HASH, 'token hash');
        const dir = process.cwd();
        const file = joinPath(dir, AGENT_TOKEN_HASH_FILE);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${hash}\n`, { mode: 0o600 });
        renameSync(tmp, file);
        onLine('ND-REKEY ok');
        // After the reply is on its way: Docker restarts the container with the new key.
        setTimeout(() => rekeyRestart.exit(), rekeyRestart.delayMs);
        return 0;
      },
    },
  },
};
