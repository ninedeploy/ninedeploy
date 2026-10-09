import { spawnValidated } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import type { Params } from './operands.js';

/**
 * Swarm membership of a node (multi-node T7, capability `swarm`, design §7.7).
 * The node owner's switch is `NINEDEPLOY_AGENT_SWARM` (agentOps/index.ts):
 * off removes the capability from the ping and refuses every op here.
 *
 * All three are SEALED only (the join token is a cluster credential; the
 * others ride the same rule so the capability has one transport story):
 *
 *  - `swarm.info {}`: `docker info --format '{{json .Swarm}}'`, one JSON line
 *    (LocalNodeState, NodeID, …) — how the panel learns the node's id.
 *  - `swarm.join {token, managerAddr}`: `docker swarm join --token <token>
 *    <managerAddr>`. The token is an argv element of this child — that is how
 *    the Docker CLI takes it — so it is visible in the node's process list
 *    for the join's duration (documented); it is never echoed: every output
 *    line has it masked.
 *  - `swarm.leave {}`: `docker swarm leave`, never `--force` (a worker leaves
 *    without it; forcing would let a manager break its cluster).
 *
 * Nothing here runs a caller's argv: the operands are a token of Docker's
 * shape and a `host:port`, both validated before anything is spawned.
 */

/** `SWMTKN-1-<cluster digest>-<secret>`: what `docker swarm join-token -q` prints. */
const RE_JOIN_TOKEN = /^SWMTKN-1-[a-z0-9-]{20,240}$/;
/** `host:port` (an IPv6 host in brackets); never a leading `-` (it would read as a flag). */
const RE_MANAGER_ADDR = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):(\d{1,5})$/;
const SWARM_TIMEOUT_MS = 120_000;

function knownKeys(params: Params, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) if (!allowed.includes(key)) throw new Error(`Invalid swarm param: ${key}`);
}

export function joinTokenOperand(value: unknown): string {
  if (typeof value !== 'string' || !RE_JOIN_TOKEN.test(value)) throw new Error('Invalid Swarm join token');
  return value;
}

export function managerAddrOperand(value: unknown): string {
  const m = typeof value === 'string' ? RE_MANAGER_ADDR.exec(value) : null;
  const port = m ? Number(m[1]) : 0;
  if (!m || port < 1 || port > 65535) throw new Error('Invalid Swarm manager address (host:port)');
  return value as string;
}

async function infoOp(params: Params, onLine: (line: string) => void): Promise<number> {
  knownKeys(params, []);
  return spawnValidated('docker', ['info', '--format', '{{json .Swarm}}'], onLine, { timeoutMs: SWARM_TIMEOUT_MS });
}

async function joinOp(params: Params, onLine: (line: string) => void): Promise<number> {
  knownKeys(params, ['token', 'managerAddr']);
  const token = joinTokenOperand(params['token']);
  const managerAddr = managerAddrOperand(params['managerAddr']);
  const masked = (line: string) => onLine(line.split(token).join('SWMTKN-1-***'));
  return spawnValidated('docker', ['swarm', 'join', '--token', token, managerAddr], masked, { timeoutMs: SWARM_TIMEOUT_MS });
}

async function leaveOp(params: Params, onLine: (line: string) => void): Promise<number> {
  knownKeys(params, ['force']);
  if (params['force'] !== undefined && params['force'] !== false) throw new Error('Invalid swarm param: force (a node never leaves by force)');
  return spawnValidated('docker', ['swarm', 'leave'], onLine, { timeoutMs: SWARM_TIMEOUT_MS });
}

export const swarmOps: AgentOpModule = {
  name: 'agentOps/swarm.ts',
  caps: ['swarm'],
  ops: {
    'swarm.info': { cap: 'swarm', sealedOnly: true, run: infoOp },
    'swarm.join': { cap: 'swarm', sealedOnly: true, run: joinOp },
    'swarm.leave': { cap: 'swarm', sealedOnly: true, run: leaveOp },
  },
};
