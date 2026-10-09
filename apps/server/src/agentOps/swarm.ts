import { request, type RequestOptions } from 'node:http';
import { spawnValidated } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import { type Params, switchedOff } from './operands.js';

/**
 * Swarm membership of a node (multi-node T7, capability `swarm`, design §7.7).
 *
 * OPT-IN on the node (security review M2): the agent advertises `swarm` and
 * accepts these ops only while its owner sets
 * `NINEDEPLOY_AGENT_SWARM_MANAGER=<host:port>`, the manager address the node
 * may join — and `swarm.join` accepts exactly that address and nothing else,
 * so a compromised panel cannot point the node at a swarm of its own. While
 * `NINEDEPLOY_AGENT_DOCKER_SOCKET=off`, `swarm.join` is refused too: a swarm
 * manager can schedule a task that mounts the socket, which is what that
 * switch forbids.
 *
 * All three are SEALED only:
 *
 *  - `swarm.info {}`: `docker info --format '{{json .Swarm}}'`, one JSON line
 *    (LocalNodeState, NodeID, …).
 *  - `swarm.join {token, managerAddr}`: through the Docker Engine API
 *    (`POST /swarm/join` on the agent's daemon socket), NOT the CLI — `docker
 *    swarm join` takes the token only as an argv element (there is no
 *    `--token-file`), where the node's process list would show it. The token
 *    is never echoed; errors are masked.
 *  - `swarm.leave {}`: `docker swarm leave`, never `--force` (a worker leaves
 *    without it; forcing would let a manager break its cluster).
 */

export const SWARM_MANAGER_ENV = 'NINEDEPLOY_AGENT_SWARM_MANAGER';
/** `SWMTKN-1-<cluster digest>-<secret>`: what `docker swarm join-token -q` prints. */
const RE_JOIN_TOKEN = /^SWMTKN-1-[a-z0-9-]{20,240}$/;
/** `host:port` (an IPv6 host in brackets); never a leading `-` (it would read as a flag). */
const RE_MANAGER_ADDR = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):(\d{1,5})$/;
const SWARM_TIMEOUT_MS = 120_000;
const mask = (s: string) => s.replace(/SWMTKN-1-[A-Za-z0-9-]+/g, 'SWMTKN-1-***');

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

// ── the Docker Engine API (the token must not reach an argv) ────────────────

export type EngineRequester = (method: string, path: string, body: unknown) => Promise<{ status: number; body: string }>;

/** Where the agent's Docker daemon listens: `DOCKER_HOST` (unix:// or plain tcp://), else the default socket. */
export function engineEndpoint(env: NodeJS.ProcessEnv = process.env): RequestOptions {
  const host = (env['DOCKER_HOST'] ?? '').trim();
  if (host === '') return { socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock' };
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  if (host.startsWith('npipe://')) return { socketPath: host.slice('npipe://'.length).replace(/\//g, '\\') };
  if (host.startsWith('tcp://')) {
    if (switchedOn(env['DOCKER_TLS_VERIFY']) || (env['DOCKER_CERT_PATH'] ?? '') !== '') {
      throw new Error('swarm.join talks to the Docker daemon directly and does not support a TLS DOCKER_HOST; use the daemon socket');
    }
    const url = new URL(`http://${host.slice('tcp://'.length)}`);
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  throw new Error(`Unsupported DOCKER_HOST for swarm.join: ${host.split('://')[0]}://`);
}
const switchedOn = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim());

const defaultRequester: EngineRequester = (method, path, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      { ...engineEndpoint(), method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: SWARM_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`the Docker daemon did not answer within ${SWARM_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    req.end(data);
  });

let engine: EngineRequester = defaultRequester;
/** Test seam: replace the Engine API transport (null restores the real one). */
export function setEngineRequester(r: EngineRequester | null): void {
  engine = r ?? defaultRequester;
}

// ── ops ────────────────────────────────────────────────────────────────────

async function infoOp(params: Params, onLine: (line: string) => void): Promise<number> {
  knownKeys(params, []);
  return spawnValidated('docker', ['info', '--format', '{{json .Swarm}}'], onLine, { timeoutMs: SWARM_TIMEOUT_MS });
}

async function joinOp(params: Params, onLine: (line: string) => void): Promise<number> {
  knownKeys(params, ['token', 'managerAddr']);
  const token = joinTokenOperand(params['token']);
  const managerAddr = managerAddrOperand(params['managerAddr']);
  const allowed = (process.env[SWARM_MANAGER_ENV] ?? '').trim();
  if (managerAddr !== allowed) {
    throw new Error(`Refusing to join ${managerAddr}: this node joins only the manager its owner named (${SWARM_MANAGER_ENV}=${allowed || 'unset'})`);
  }
  if (switchedOff(process.env['NINEDEPLOY_AGENT_DOCKER_SOCKET'])) {
    throw new Error('Refusing to join a swarm while NINEDEPLOY_AGENT_DOCKER_SOCKET=off: a swarm manager can schedule a task that mounts the Docker socket');
  }
  let res: { status: number; body: string };
  try {
    res = await engine('POST', '/swarm/join', { ListenAddr: '0.0.0.0:2377', AdvertiseAddr: '', DataPathAddr: '', RemoteAddrs: [managerAddr], JoinToken: token });
  } catch (err) {
    onLine(mask(`swarm join failed: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
  if (res.status >= 200 && res.status < 300) {
    onLine('This node joined a swarm as a worker.');
    return 0;
  }
  let message = res.body;
  try {
    message = (JSON.parse(res.body) as { message?: string }).message ?? res.body;
  } catch {
    /* plain text */
  }
  onLine(mask(`swarm join failed (${res.status}): ${message}`.split(token).join('SWMTKN-1-***')).slice(0, 1000));
  return 1;
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
