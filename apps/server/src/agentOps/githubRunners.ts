import { capture } from '../lib/exec.js';
import { ensureRunnerNetwork, listRunnerContainers, nodeIsolationScript, RUNNER_NAME_RE, runnerRunArgs } from '../lib/githubRunners.js';
import { hostScriptArgs } from '../lib/osUpdates.js';
import { writeSecretFile } from '../lib/secretFile.js';
import { GITHUB_RUNNER_DEFAULTS, githubRepoFullName } from '@ninedeploy/schemas';
import type { AgentOpModule } from './index.js';
import { helperImage } from './osUpdates.js';
import type { Params } from './operands.js';

/**
 * G4.5 GitHub Actions runners on a node (capability `gha.runner`, opt-in:
 * the node owner sets `NINEDEPLOY_AGENT_GHA_RUNNERS=on`; `off` turns it off
 * again). The panel asks GitHub for the just-in-time configuration and sends
 * it here only inside a sealed request; the agent:
 *
 *  - `gha.runner.prepare`: creates the isolated runner network and puts the
 *    panel host's firewall rules on THIS host (through the `nsenter` helper
 *    `host.packages` uses: the agent's own iptables would guard only its
 *    container). Nothing starts when they cannot be put in place.
 *  - `gha.runner.start {name, app, job, repo, runner, scope, cpus, memoryMb,
 *    jitConfig}`: prepares again (a firewall reload drops rules), then runs
 *    the runner exactly as the panel host does: no Docker socket, its own
 *    bridge, limits, the configuration in a 0600 env file, never argv.
 *  - `gha.runner.list` → `ND-GHA-RUNNERS <json>`; `gha.runner.stop {name}`
 *    removes one runner container this module started.
 */

const CAP = 'gha.runner' as const;
const RE_SCOPE = /^(org:[A-Za-z0-9][A-Za-z0-9-]{0,38}|repo:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/;
const RE_JIT = /^[A-Za-z0-9+/=]{16,65536}$/;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function positiveInt(p: Params, key: string): number {
  const v = p[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error(`gha.runner: invalid ${key}`);
  return v;
}

function runnerName(p: Params): string {
  const name = p['name'];
  if (typeof name !== 'string' || !RUNNER_NAME_RE.test(name)) throw new Error('gha.runner: invalid runner name');
  return name;
}

async function prepare(): Promise<void> {
  await ensureRunnerNetwork();
  try {
    await capture('docker', hostScriptArgs(helperImage(), nodeIsolationScript()), { timeoutMs: 60_000 });
  } catch (err) {
    throw new Error(`Could not put the runner firewall rules in place on this node: ${err instanceof Error ? err.message.slice(-300) : String(err)}`);
  }
}

async function start(p: Params, onLine: (line: string) => void): Promise<number> {
  const name = runnerName(p);
  const repo = p['repo'];
  if (typeof repo !== 'string' || !githubRepoFullName.safeParse(repo).success) throw new Error('gha.runner: invalid repo');
  const scope = p['scope'];
  if (typeof scope !== 'string' || !RE_SCOPE.test(scope)) throw new Error('gha.runner: invalid scope');
  const cpus = p['cpus'] ?? null;
  if (cpus !== null && (typeof cpus !== 'number' || !(cpus >= 0.25 && cpus <= 64))) throw new Error('gha.runner: invalid cpus');
  const memoryMb = p['memoryMb'] ?? null;
  if (memoryMb !== null && (typeof memoryMb !== 'number' || !Number.isInteger(memoryMb) || memoryMb < 256 || memoryMb > 262144)) throw new Error('gha.runner: invalid memoryMb');
  const jit = p['jitConfig'];
  if (typeof jit !== 'string' || !RE_JIT.test(jit)) throw new Error('gha.runner: invalid jitConfig');
  const meta = { name, githubAppId: positiveInt(p, 'app'), jobId: positiveInt(p, 'job'), repo, runnerId: positiveInt(p, 'runner'), scope };
  await prepare();
  const envFile = writeSecretFile('nd-gha', 'runner.env', `ND_JITCONFIG=${jit}\n`);
  try {
    await capture('docker', runnerRunArgs({ ...GITHUB_RUNNER_DEFAULTS, cpus: cpus as number | null, memoryMb: memoryMb as number | null }, meta, envFile.path), { timeoutMs: RUN_TIMEOUT_MS });
  } finally {
    envFile.cleanup();
  }
  onLine(`ND-GHA-RUNNER ${JSON.stringify({ started: name })}`);
  return 0;
}

export const githubRunnerOps: AgentOpModule = {
  name: 'agentOps/githubRunners.ts',
  caps: [CAP],
  ops: {
    'gha.runner.prepare': {
      cap: CAP,
      sealedOnly: true,
      async run(_p, onLine) {
        await prepare();
        onLine('ND-GHA-RUNNER {"prepared":true}');
        return 0;
      },
    },
    'gha.runner.start': { cap: CAP, sealedOnly: true, run: (p, onLine) => start(p, onLine) },
    'gha.runner.list': {
      cap: CAP,
      sealedOnly: true,
      async run(_p, onLine) {
        onLine(`ND-GHA-RUNNERS ${JSON.stringify(await listRunnerContainers())}`);
        return 0;
      },
    },
    'gha.runner.stop': {
      cap: CAP,
      sealedOnly: true,
      async run(p, onLine) {
        const name = runnerName(p);
        // Only a runner container this module started (its label), never another container by that name.
        if (!(await listRunnerContainers()).some((c) => c.name === name)) throw new Error(`gha.runner: no runner ${name} on this node`);
        await capture('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
        onLine(`ND-GHA-RUNNER ${JSON.stringify({ stopped: name })}`);
        return 0;
      },
    },
  },
};
