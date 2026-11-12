import { z } from 'zod';
import { RE_IMAGE, RE_IMAGE_ID } from '../agentOps/operands.js';
import { spawnValidated } from './spawnValidated.js';

/**
 * P2, agent side: a deploy hook of a node service, run as a one-off container
 * from the release's own image (the release-phase model), never as a shell on
 * the node. The agent enforces the shape itself, whatever the panel sends:
 *
 * - the image is resolved to its sha256 id first and created with `--pull never`;
 * - the command is exec'd as on the panel host (`runHook` splits it and runs
 *   `bin args` with no shell): `--entrypoint <argv0>` plus the rest;
 * - the service's network (and its node database bridges) and limits only: no
 *   port, no mount, no socket, not privileged, `no-new-privileges`, a pids
 *   limit, `--rm`;
 * - a name and a `ninedeploy.managed=hook` label that no replica, inventory or
 *   creation fence matches (they look for `managed=service` and replica names);
 * - a hard timeout, after which (and after any other end, a cancel included)
 *   the container is removed.
 *
 * Every line the hook prints is prefixed, so no hook output can pose as the
 * agent's own `ND-HOOK` receipt.
 */

export const NODE_HOOK_REPLY = 'ND-HOOK ';
export const NODE_HOOK_OUTPUT = '│ ';
export const NODE_HOOK_LABEL = 'hook';

// An argument may be empty (`tool "" flag`); the executable may not.
const argvItem = z.string().max(4096).refine((s) => !s.includes('\0'), 'NUL in a hook argument');
export const nodeHookRunParams = z.object({
  serviceId: z.number().int().min(1).max(2 ** 31),
  deploymentId: z.number().int().min(1).max(2 ** 31),
  phase: z.enum(['pre-deploy', 'post-deploy']),
  image: z.string().max(255).refine((s) => RE_IMAGE.test(s), 'Invalid image'),
  argv: z.array(argvItem).min(1).max(64).refine((a) => a[0] !== '', 'The hook needs an executable'),
  envFile: z.string().regex(/^\.agent-env\/[A-Za-z0-9][A-Za-z0-9_.-]*\.env$/),
  network: z.string().regex(/^(?:ninedeploy|nd-[a-z0-9][a-z0-9_.-]*)$/),
  /** The node database bridges (`nd-dbnet-<slug>`) the service's replicas join, so a migration reaches them. */
  extraNetworks: z.array(z.string().regex(/^nd-[a-z0-9][a-z0-9_.-]*$/)).max(16).optional(),
  cpuLimitMilli: z.number().int().min(1).max(1_024_000).optional(),
  memLimitMb: z.number().int().min(6).max(4_194_304).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600),
}).strict();
export type NodeHookRunParams = z.infer<typeof nodeHookRunParams>;

export interface NodeHookReceipt { exitCode: number; timedOut: boolean; imageId: string }

export const nodeHookContainerName = (p: Pick<NodeHookRunParams, 'serviceId' | 'deploymentId' | 'phase'>) =>
  `nd-hook-${p.serviceId}-${p.deploymentId}-${p.phase === 'pre-deploy' ? 'pre' : 'post'}`;

/**
 * The `docker create` argv for a validated request and its resolved image id.
 * The container is then joined to the extra networks and started attached
 * (`docker start -a`), which streams its output and exits with its code.
 */
export function nodeHookCreateArgs(p: NodeHookRunParams, imageId: string): string[] {
  if (!RE_IMAGE_ID.test(imageId)) throw new Error('Invalid image id');
  const [bin, ...args] = p.argv;
  return [
    'create', '--rm', '--name', nodeHookContainerName(p), '--pull', 'never',
    '--network', p.network,
    '--label', `ninedeploy.managed=${NODE_HOOK_LABEL}`,
    '--label', `ninedeploy.hook.service=${p.serviceId}`,
    '--label', `ninedeploy.hook.deployment=${p.deploymentId}`,
    '--label', `ninedeploy.hook.phase=${p.phase}`,
    '--security-opt', 'no-new-privileges', '--pids-limit', '4096',
    ...(p.cpuLimitMilli ? ['--cpus', String(p.cpuLimitMilli / 1000)] : []),
    ...(p.memLimitMb ? ['--memory', `${p.memLimitMb}m`, '--memory-swap', `${p.memLimitMb}m`] : []),
    '--env-file', p.envFile,
    '--entrypoint', bin!,
    imageId, ...args,
  ];
}

type Spawn = (argv: string[], onLine: (line: string) => void, opts?: { timeoutMs?: number }) => Promise<number>;
const dockerSpawn: Spawn = (argv, onLine, opts) => spawnValidated('docker', argv, onLine, opts);
const TIMEOUT_EXIT = 124;

async function output(spawn: Spawn, argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await spawn(argv, (l) => { if (lines.length < 50) lines.push(l); }, { timeoutMs: 15_000 });
  return { code, lines };
}

/** Remove a container under the hook name only when it is a hook container. Throws when the name holds anything else. */
async function clearHookName(spawn: Spawn, name: string): Promise<void> {
  const seen = await output(spawn, ['inspect', '--type', 'container', '--format', '{{index .Config.Labels "ninedeploy.managed"}}', name]);
  if (seen.code !== 0) return; // no such container
  if (seen.lines.join('').trim() !== NODE_HOOK_LABEL) throw new Error(`Container name ${name} is held by something other than a deploy hook; it was left alone`);
  await output(spawn, ['rm', '-f', name]);
}

export async function runNodeDeployHook(raw: unknown, sink: (line: string) => void, spawn: Spawn = dockerSpawn): Promise<NodeHookReceipt> {
  const parsed = nodeHookRunParams.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid deploy hook operands');
  const p = parsed.data;
  const resolved = await output(spawn, ['image', 'inspect', '--format', '{{.Id}}', p.image]);
  const imageId = resolved.lines.join('').trim();
  if (resolved.code !== 0 || !RE_IMAGE_ID.test(imageId)) throw new Error(`The release image ${p.image} is not on the node`);
  const name = nodeHookContainerName(p);
  await clearHookName(spawn, name);
  let code = 1;
  let started = Date.now();
  try {
    const created = await output(spawn, nodeHookCreateArgs(p, imageId));
    if (created.code !== 0) throw new Error(`The hook container could not be created: ${created.lines.join(' ').slice(-300)}`);
    for (const network of new Set(p.extraNetworks ?? [])) {
      const joined = await output(spawn, ['network', 'connect', network, name]);
      if (joined.code !== 0) throw new Error(`The hook container could not join ${network}: ${joined.lines.join(' ').slice(-300)}`);
    }
    started = Date.now();
    code = await spawn(['start', '--attach', name], (line) => sink(`${NODE_HOOK_OUTPUT}${line}`), { timeoutMs: p.timeoutSeconds * 1000 });
  } finally {
    // `--rm` covers a normal end; a timeout or a cancel kills only the CLI,
    // and a failed create or connect leaves a created container behind.
    await clearHookName(spawn, name).catch(() => undefined);
  }
  // A hook may exit 124 itself; only a run that lasted the whole budget timed out.
  const timedOut = code === TIMEOUT_EXIT && Date.now() - started >= p.timeoutSeconds * 1000 - 100;
  return { exitCode: code, timedOut, imageId };
}
