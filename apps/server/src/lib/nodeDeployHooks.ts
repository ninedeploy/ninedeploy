import type { AgentCall } from '../engine/builders/remoteDocker.js';
import { envForAgent } from '../engine/builders/remoteRun.js';
import { splitHookCommand } from './hookCommand.js';
import { NODE_HOOK_OUTPUT, NODE_HOOK_REPLY, type NodeHookReceipt } from './nodeDeployHookRun.js';
import { confirmedNodeEnvFile } from './nodeEnvReceipt.js';

/**
 * P2, panel side: run a node service's pre-deploy or post-deploy hook through
 * its agent, as a one-off container from the release image (the agent side is
 * lib/nodeDeployHookRun.ts). The env reaches the node as the same 0600 env
 * file a replica gets, removed afterwards. Output goes to the deploy log,
 * whose sink masks the service's secret values.
 *
 * Throws when the hook fails, times out, or its run cannot be confirmed.
 */

/** As long as a panel-host hook may take, within the agent's own bound. */
export const NODE_HOOK_TIMEOUT_SECONDS = 3600;

export interface NodeHookInput {
  service: { id: number; slug: string; cpuLimitMilli: number; memLimitMb: number };
  deploymentId: number;
  phase: 'pre-deploy' | 'post-deploy';
  cmd: string;
  /** The release image as the node knows it (a tag or a sha256 id); the agent resolves and pins the id. */
  image: string;
  env: Record<string, string>;
  network?: string;
  /** The node database bridges the service's replicas join. */
  extraNetworks?: string[];
  log: (line: string) => void;
}

/**
 * The image id the new release's container runs on the node (a post-deploy
 * hook runs from exactly that image). `runtime.imageDigest` is set only for a
 * real registry digest, so the node is asked.
 */
export async function nodeRuntimeImage(agent: AgentCall, runtime: { runtimeId: string; nodeTargets?: ReadonlyArray<{ id: string }>; nodeReadinessId?: string }): Promise<string> {
  const ref = runtime.nodeTargets?.[0]?.id ?? runtime.nodeReadinessId ?? runtime.runtimeId;
  const res = await agent('docker.inspect', { name: ref, format: 'image' }, () => undefined);
  const id = res.lines.filter((l) => l.trim()).at(-1)?.trim();
  if (res.exitCode !== 0 || !id || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('the image of the new release could not be read on the node, so the hook was not run');
  return id;
}

export async function runNodeHook(agent: AgentCall, input: NodeHookInput): Promise<NodeHookReceipt> {
  const argv = splitHookCommand(input.cmd);
  if (argv.length === 0 || !argv[0]) throw new Error(`The ${input.phase} hook has no command`);
  const envName = `nd-hook-${input.service.slug}-${input.deploymentId}-${input.phase === 'pre-deploy' ? 'pre' : 'post'}`;
  const wrote = await agent('file.writeEnv', { name: envName, env: envForAgent(input.env) }, () => undefined);
  const envFile = confirmedNodeEnvFile(wrote, envName);
  try {
    let receipt: NodeHookReceipt | null = null;
    const res = await agent('docker.hookRun', {
      serviceId: input.service.id,
      deploymentId: input.deploymentId,
      phase: input.phase,
      image: input.image,
      argv,
      envFile,
      network: input.network ?? 'ninedeploy',
      ...(input.extraNetworks?.length && { extraNetworks: input.extraNetworks }),
      ...(input.service.cpuLimitMilli > 0 && { cpuLimitMilli: input.service.cpuLimitMilli }),
      ...(input.service.memLimitMb > 0 && { memLimitMb: input.service.memLimitMb }),
      timeoutSeconds: NODE_HOOK_TIMEOUT_SECONDS,
    }, (line) => {
      if (line.startsWith(NODE_HOOK_OUTPUT)) input.log(line.slice(NODE_HOOK_OUTPUT.length));
      else if (line.startsWith(NODE_HOOK_REPLY)) {
        try { receipt = JSON.parse(line.slice(NODE_HOOK_REPLY.length)) as NodeHookReceipt; } catch { receipt = null; }
      } else input.log(line);
    }, { timeoutMs: (NODE_HOOK_TIMEOUT_SECONDS + 120) * 1000 });
    // The streamed sink and the collected lines carry the same receipt; the last one is the agent's.
    const last = [...res.lines].reverse().find((l) => l.startsWith(NODE_HOOK_REPLY));
    if (last) {
      try { receipt = JSON.parse(last.slice(NODE_HOOK_REPLY.length)) as NodeHookReceipt; } catch { receipt = null; }
    }
    const r = receipt as NodeHookReceipt | null;
    if (res.exitCode !== 0 || !r || typeof r.exitCode !== 'number' || !/^sha256:[a-f0-9]{64}$/.test(String(r.imageId))) {
      throw new Error(`The ${input.phase} hook's run on the node could not be confirmed`);
    }
    if (r.timedOut) throw new Error(`The ${input.phase} hook timed out after ${NODE_HOOK_TIMEOUT_SECONDS} s on the node`);
    if (r.exitCode !== 0) throw new Error(`The ${input.phase} hook exited with code ${r.exitCode} on the node`);
    return r;
  } finally {
    await agent('file.deleteEnv', { name: envName }, () => undefined).catch(() => undefined);
  }
}
