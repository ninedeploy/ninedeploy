import { MULTI_NODE_CAPABILITIES, type MultiNodeCapability } from '@ninedeploy/schemas';
import { imageOps } from './images.js';
import type { Params } from './operands.js';
import { switchedOff } from './operands.js';
import { runSpecOps } from './runSpec.js';
import { streamOps } from './stream.js';
import { volumeOps } from './volumes.js';

/**
 * The multi-node op registry (design §1, §9 M8).
 *
 * agent.ts is the protocol's hot spot, so ops added after 0.15 live in
 * agentOps/*.ts and are reached only through this table. Each module declares
 * the capabilities it implements and its ops; agent.ts advertises a
 * capability in the sealed `agent.ping` only when a module here declares it,
 * and lists every op here in `HANDLED_OPS` so the exec route reaches it.
 *
 * One labelled block per task. A task adds its module inside its own block
 * and nowhere else; the order of the blocks never matters (capabilities are
 * advertised in `MULTI_NODE_CAPABILITIES` order).
 */

/** What every registered op receives besides its params. */
export interface AgentOpContext {
  /** The request arrived inside a sealed envelope. */
  sealed: boolean;
}

export interface AgentOpDef {
  /** The capability that advertises (and gates) this op. */
  cap: MultiNodeCapability;
  /**
   * Refused unless the request arrived sealed. A function decides per request
   * (for example "sealed when `env` is non-empty").
   */
  sealedOnly: boolean | ((params: Params) => boolean);
  /** Run the op: validate every operand first, then act. Resolves the exit code; throws for bad params. */
  run(params: Params, onLine: (line: string) => void, ctx: AgentOpContext): Promise<number>;
}

export interface AgentOpModule {
  /** The module's file, for messages and tests. */
  name: string;
  /** Capabilities the module implements (a parameter-level capability may have no op of its own). */
  caps: readonly MultiNodeCapability[];
  ops: Readonly<Record<string, AgentOpDef>>;
}

export const AGENT_OP_MODULES: readonly AgentOpModule[] = [
  // ── 0.16 T2 agent transport ──
  streamOps,
  runSpecOps,
  volumeOps,
  imageOps,
  // ── end 0.16 T2 ──
  // ── 0.16 T3 node builds and private clones ── (agentOps/builds.ts; `git.sshkey` from agentOps/gitCredential.ts)
  // ── end 0.16 T3 ──
  // ── 0.16 T5 node volumes ── (more ops on `volume.manage`, if any, in agentOps/volumes.ts)
  // ── end 0.16 T5 ──
  // ── 0.16 T6 node databases ── (agentOps/databases.ts; the db stream kinds are in agentOps/stream.ts)
  // ── end 0.16 T6 ──
  // ── 0.16 T7 swarm ── (agentOps/swarm.ts)
  // ── end 0.16 T7 ──
];

/**
 * The node owner's switches (design §1.1): set to off/false/0/no/disabled in
 * the agent's environment, they remove the capability from the ping — so the
 * panel refuses the feature before anything runs — and the op refuses too.
 * `docker.runSpec`'s socket switch (`NINEDEPLOY_AGENT_DOCKER_SOCKET`) refuses
 * only socket mounts and is enforced in agentOps/runSpec.ts.
 */
export const AGENT_KILL_SWITCHES: Readonly<Partial<Record<MultiNodeCapability, readonly string[]>>> = {
  'build.nixpacks': ['NINEDEPLOY_AGENT_BUILDS'],
  'build.railpack': ['NINEDEPLOY_AGENT_BUILDS'],
  'git.sshkey': ['NINEDEPLOY_AGENT_STATIC_CREDENTIALS'],
  'db.manage': ['NINEDEPLOY_AGENT_DATABASES'],
  swarm: ['NINEDEPLOY_AGENT_SWARM'],
};

/** The switch that turned `cap` off on this node, or null. */
export function capabilityKillSwitch(cap: MultiNodeCapability, env: NodeJS.ProcessEnv = process.env): string | null {
  return (AGENT_KILL_SWITCHES[cap] ?? []).find((name) => switchedOff(env[name])) ?? null;
}

/** Every registered op by name. Built once; a duplicate or undeclared capability is a programming error. */
export function buildOpTable(modules: readonly AgentOpModule[]): ReadonlyMap<string, AgentOpDef> {
  const table = new Map<string, AgentOpDef>();
  for (const mod of modules) {
    for (const [op, def] of Object.entries(mod.ops)) {
      if (table.has(op)) throw new Error(`agent op ${op} is registered twice (${mod.name})`);
      if (!mod.caps.includes(def.cap)) throw new Error(`agent op ${op} uses capability ${def.cap}, which ${mod.name} does not declare`);
      table.set(op, def);
    }
  }
  return table;
}

export const AGENT_OPS: ReadonlyMap<string, AgentOpDef> = buildOpTable(AGENT_OP_MODULES);

/** The multi-node capabilities this agent implements, in `MULTI_NODE_CAPABILITIES` order. */
export function registeredCapabilities(modules: readonly AgentOpModule[] = AGENT_OP_MODULES): MultiNodeCapability[] {
  const declared = new Set(modules.flatMap((m) => m.caps));
  return MULTI_NODE_CAPABILITIES.filter((cap) => declared.has(cap));
}

/** What the ping advertises after the 0.15 list: the registered capabilities the node's owner has not switched off. */
export function advertisedCapabilities(env: NodeJS.ProcessEnv = process.env): MultiNodeCapability[] {
  return registeredCapabilities().filter((cap) => capabilityKillSwitch(cap, env) === null);
}

/**
 * Run a registered op, or answer null when `op` is not one (agent.ts then
 * tries its own table). The kill switch and the sealed-only rule are checked
 * before the op validates anything, so a refused op touches nothing.
 */
export async function runRegisteredOp(
  op: string,
  params: Params,
  onLine: (line: string) => void,
  ctx: AgentOpContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  const def = AGENT_OPS.get(op);
  if (!def) return null;
  const killed = capabilityKillSwitch(def.cap, env);
  if (killed !== null) throw new Error(`${op} is disabled on this node by its owner (${killed}=off)`);
  const sealedOnly = typeof def.sealedOnly === 'function' ? def.sealedOnly(params) : def.sealedOnly;
  if (sealedOnly && !ctx.sealed) {
    throw new Error(`Refusing ${op} over the unencrypted transport: it is accepted only inside a sealed request`);
  }
  return def.run(params, onLine, ctx);
}
