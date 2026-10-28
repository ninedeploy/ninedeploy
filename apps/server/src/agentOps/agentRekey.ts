import { createHash } from 'node:crypto';
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
 * holder can rekey. Until then such a node (`NINEDEPLOY_AGENT_REKEY_REQUIRED=1`)
 * runs nothing but {@link REKEY_BOOTSTRAP_OPS}.
 *
 * The file also records a fingerprint of the environment key it replaced: an
 * operator who re-runs the agent with a different `NINEDEPLOY_AGENT_TOKEN`
 * gets that key, not a stale rekeyed one left in the volume.
 */

/** File (relative to the agent's working directory) holding the rekeyed hash. */
export const AGENT_TOKEN_HASH_FILE = '.agent-token-sha256';

/** What an agent that still waits for its rekey answers. */
export const REKEY_BOOTSTRAP_OPS: ReadonlySet<string> = new Set(['agent.ping', 'agent.rekey']);

const RE_HASH = /^[0-9a-f]{64}$/;

const envKey = (): string => process.env['NINEDEPLOY_AGENT_TOKEN'] ?? '';
const fingerprint = (key: string): string => createHash('sha256').update(`nd-rekey:${key}`).digest('hex');

export interface RekeyedTokenHash {
  /** The rekeyed hash, or null when there is none to use. */
  hash: string | null;
  /** A rekeyed hash exists but was made for another environment key, so it is ignored. */
  stale: boolean;
}

/** The rekeyed hash for the current environment key (see {@link RekeyedTokenHash}). */
export function loadRekeyedTokenHash(dir = process.cwd(), key = envKey()): RekeyedTokenHash {
  const file = joinPath(dir, AGENT_TOKEN_HASH_FILE);
  if (!existsSync(file)) return { hash: null, stale: false };
  let hash: string | undefined;
  let replaced: string | undefined;
  try {
    [hash, replaced] = readFileSync(file, 'utf8').trim().split('\n').map((l) => l.trim());
  } catch {
    return { hash: null, stale: false };
  }
  if (!hash || !RE_HASH.test(hash)) return { hash: null, stale: false };
  if (replaced !== fingerprint(key)) return { hash: null, stale: true };
  return { hash, stale: false };
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
        writeFileSync(tmp, `${hash}\n${fingerprint(envKey())}\n`, { mode: 0o600 });
        renameSync(tmp, file);
        onLine('ND-REKEY ok');
        // After the reply is on its way: Docker restarts the container with the new key.
        setTimeout(() => rekeyRestart.exit(), rekeyRestart.delayMs);
        return 0;
      },
    },
  },
};
