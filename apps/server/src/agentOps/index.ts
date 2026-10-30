import { containerMutationOps } from './containerMutation.js';
import { databaseClientOps } from './databaseClient.js';
import { studioOps } from './studios.js';
import { proxyTrafficOps } from './proxyTraffic.js';
import { containerReadinessOps } from './containerReadiness.js';
import { containerMetricsOps } from './containerMetrics.js';
import { containerLifecycleOps } from './containerLifecycle.js';
import { MULTI_NODE_CAPABILITIES, type MultiNodeCapability } from '@ninedeploy/schemas';
import { buildOps } from './builds.js';
import { observabilityOps } from './observability.js';
import { databaseOps } from './databases.js';
import { fileMountOps } from './fileMounts.js';
import { gitKeyOps } from './gitCredential.js';
import { imageOps } from './images.js';
import type { Params } from './operands.js';
import { switchedOff } from './operands.js';
import { runSpecOps } from './runSpec.js';
import { streamOps } from './stream.js';
import { swarmOps } from './swarm.js';
import { composeVolumeOps, nodeVolumeOps, volumeOps } from './volumes.js';
import { proxyRoutingOps } from './proxyRouting.js';
import { containerIdentityOps } from './containerIdentity.js';
import { containerToolOps } from './containerTools.js';
import { volumeFileOps } from './volumeFiles.js';
import { osUpdateOps } from './osUpdates.js';
import { agentRekeyOps } from './agentRekey.js';
import { imageScanOps } from './imageScan.js';
import { tunnelOps } from './tunnels.js';
import { githubRunnerOps } from './githubRunners.js';
import { publicAccessOps } from './publicAccess.js';
import { pgbouncerOps } from './pgbouncer.js';

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
  /** Internal local-panel override; remote agent requests cannot supply this path. */
  lifecycleJournalRoot?: string;
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
  containerMutationOps,
  containerLifecycleOps,
  containerMetricsOps,
  containerReadinessOps,
  proxyTrafficOps,
  studioOps,
  databaseClientOps,
  volumeFileOps,
  containerToolOps,
  containerIdentityOps,
  proxyRoutingOps,
  observabilityOps,
  // ── 0.16 T2 agent transport ──
  streamOps,
  runSpecOps,
  volumeOps,
  imageOps,
  // ── end 0.16 T2 ──
  // ── 0.16 T3 node builds and private clones ── (agentOps/builds.ts; `git.sshkey` from agentOps/gitCredential.ts)
  buildOps,
  gitKeyOps,
  // ── end 0.16 T3 ──
  // ── 0.16 T5 node volumes ── (more ops on `volume.manage`, if any, in agentOps/volumes.ts)
  nodeVolumeOps,
  // ── end 0.16 T5 ──
  // ── 0.16 T6 node databases ── (agentOps/databases.ts; the db stream kinds are in agentOps/stream.ts)
  databaseOps,
  // ── end 0.16 T6 ──
  // ── 0.16 T7 swarm ── (agentOps/swarm.ts)
  swarmOps,
  // ── end 0.16 T7 ──
  // 0.16.5 file mounts on a node (agentOps/fileMounts.ts; the `fileMounts` field of docker.runSpec)
  fileMountOps,
  // G4.2 OS security updates (agentOps/osUpdates.ts)
  osUpdateOps,
  // G4.3 rekey after a cloud bootstrap (agentOps/agentRekey.ts)
  agentRekeyOps,
  // G5.1 Trivy image scans (agentOps/imageScan.ts)
  imageScanOps,
  // G3.1 compose stack volumes moved with their stack (agentOps/volumes.ts)
  composeVolumeOps,
  // G5.8 tunnels to node services (agentOps/tunnels.ts; the channel is GET /agent/tunnel)
  tunnelOps,
  // G4.5 GitHub Actions runners on a node (agentOps/githubRunners.ts; opt-in)
  githubRunnerOps,
  // ROADMAP item 10: public access to node databases (agentOps/publicAccess.ts)
  publicAccessOps,
  // ROADMAP item 10: PgBouncer for node databases (agentOps/pgbouncer.ts)
  pgbouncerOps,
];

/**
 * The node owner's switches (design §1.1): set to off/false/0/no/disabled in
 * the agent's environment, they remove the capability from the ping — so the
 * panel refuses the feature before anything runs — and the op refuses too.
 * `docker.runSpec`'s socket switch (`NINEDEPLOY_AGENT_DOCKER_SOCKET`) refuses
 * only socket mounts and is enforced in agentOps/runSpec.ts.
 */
export const AGENT_KILL_SWITCHES: Readonly<Partial<Record<MultiNodeCapability, readonly string[]>>> = {
  'docker.mutations': ['NINEDEPLOY_AGENT_CONTAINER_MUTATIONS'],
  'docker.lifecycle': ['NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE'],
  'docker.lifecycle.generations': ['NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE'],
  'docker.lifecycle.creationFence': ['NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE'],
  'docker.lifecycle.retire': ['NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE'],
  'docker.metrics': ['NINEDEPLOY_AGENT_CONTAINER_METRICS'],
  'proxy.traffic': ['NINEDEPLOY_AGENT_PROXY_TRAFFIC'],
  'db.studio': ['NINEDEPLOY_AGENT_DATABASES', 'NINEDEPLOY_AGENT_DATABASE_STUDIOS'],
  'db.client': ['NINEDEPLOY_AGENT_DATABASES', 'NINEDEPLOY_AGENT_DATABASE_CLIENTS'],
  'db.publicAccess': ['NINEDEPLOY_AGENT_DATABASES', 'NINEDEPLOY_AGENT_PUBLIC_DATABASES'],
  'db.pgbouncer': ['NINEDEPLOY_AGENT_DATABASES', 'NINEDEPLOY_AGENT_PGBOUNCER'],
  'volume.files': ['NINEDEPLOY_AGENT_VOLUME_FILES'],
  'docker.containerTools': ['NINEDEPLOY_AGENT_CONTAINER_TOOLS'],
  'build.nixpacks': ['NINEDEPLOY_AGENT_BUILDS'],
  'build.railpack': ['NINEDEPLOY_AGENT_BUILDS'],
  'docker.buildOptions': ['NINEDEPLOY_AGENT_BUILDS'],
  'git.sshkey': ['NINEDEPLOY_AGENT_STATIC_CREDENTIALS'],
  'db.manage': ['NINEDEPLOY_AGENT_DATABASES'],
  'db.dump.extra': ['NINEDEPLOY_AGENT_DATABASES'],
  // G5.1: Trivy on the node is the node owner's call.
  'image.scan': ['NINEDEPLOY_AGENT_IMAGE_SCAN'],
  // G3.1: compose volume transfers are the node owner's call.
  'volume.compose': ['NINEDEPLOY_AGENT_VOLUME_COMPOSE'],
  // G5.8: tunnels into service containers are the node owner's call.
  'tunnel.tcp': ['NINEDEPLOY_AGENT_TUNNELS'],
  // G4.5: opt-in below; `off` turns it off again.
  'gha.runner': ['NINEDEPLOY_AGENT_GHA_RUNNERS'],
  // 0.16.6: GPUs and added Linux capabilities are the node owner's call.
  'docker.runtimeOptions': ['NINEDEPLOY_AGENT_RUNTIME_OPTIONS'],
  // G4.2: the host's package configuration is the node owner's call too.
  'host.packages': ['NINEDEPLOY_AGENT_HOST_PACKAGES'],
};

/**
 * Capabilities the node's owner must OPT IN to (security review M2): off
 * until the variable is set. `swarm`: `NINEDEPLOY_AGENT_SWARM_MANAGER=<host:port>`
 * names the one manager the node may join (agentOps/swarm.ts enforces it).
 */
export const AGENT_OPT_IN: Readonly<Partial<Record<MultiNodeCapability, string>>> = {
  'proxy.traffic': 'NINEDEPLOY_AGENT_PROXY_TRAFFIC',
  swarm: 'NINEDEPLOY_AGENT_SWARM_MANAGER',
  // G4.5: a node runs other people's CI jobs only when its owner says so.
  'gha.runner': 'NINEDEPLOY_AGENT_GHA_RUNNERS',
};

/** The switch that turned `cap` off on this node (or the opt-in variable left unset), or null. */
export function capabilityKillSwitch(cap: MultiNodeCapability, env: NodeJS.ProcessEnv = process.env): string | null {
  const optIn = AGENT_OPT_IN[cap];
  if (optIn !== undefined && (env[optIn] ?? '').trim() === '') return optIn;
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
  if (killed !== null) {
    throw new Error(
      Object.values(AGENT_OPT_IN).includes(killed)
        ? `${op} is not enabled on this node: its owner has not opted in (${killed} is not set)`
        : `${op} is disabled on this node by its owner (${killed}=off)`,
    );
  }
  const sealedOnly = typeof def.sealedOnly === 'function' ? def.sealedOnly(params) : def.sealedOnly;
  if (sealedOnly && !ctx.sealed) {
    throw new Error(`Refusing ${op} over the unencrypted transport: it is accepted only inside a sealed request`);
  }
  return def.run(params, onLine, ctx);
}
