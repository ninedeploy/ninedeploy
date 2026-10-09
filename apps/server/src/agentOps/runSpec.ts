import { spawnValidated } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import { intOperand, isManagedVolume, type Params, RE_IMAGE, RE_NAME, RE_PATH, switchedOff } from './operands.js';

/**
 * `docker.runSpec` (multi-node, capability `docker.runSpec`, design §1.6): a
 * structured `docker run` for what `docker.runEnv` has no slot for — a
 * command, labels, extra networks, several managed volumes, the Docker
 * socket. It replaces nothing: `docker.runEnv` stays byte-identical for older
 * panels and for services that need none of this.
 *
 * The request is a SPEC, never an argv: every field is validated, unknown
 * fields are refused, and the argv is built here from literal flags plus the
 * validated operands. `cmd` elements are appended after the image as
 * separate argv elements — never through a shell. Sealed only (the env-file
 * path and the command can carry secrets).
 */

const MAX_NAME = 128;
const MAX_EXTRA_NETWORKS = 8;
const MAX_VOLUMES = 16;
const MAX_CMD_ITEMS = 64;
const MAX_CMD_ITEM_CHARS = 4096;
const MAX_LABELS = 32;
const RESTART = ['unless-stopped', 'always', 'on-failure', 'no'] as const;
const RE_LABEL_KEY = /^ninedeploy\.[a-z0-9][a-z0-9._-]{0,127}$/;
/** Labels the op sets itself (r593 recovery labels); a spec cannot override them. */
const RESERVED_LABELS = new Set(['ninedeploy.managed', 'ninedeploy.deployment', 'ninedeploy.service']);
const SPEC_KEYS = new Set([
  'name', 'image', 'envFile', 'restart', 'network', 'extraNetworks', 'volumes', 'dockerSocket', 'cmd', 'labels', 'publish',
  'cpuShares', 'cpuLimitMilli', 'memLimitMb', 'managed', 'deploymentId', 'serviceId',
]);

/** `NINEDEPLOY_AGENT_DOCKER_SOCKET=off`: the node's owner forbids socket mounts. */
export function nodeDockerSocketForbidden(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchedOff(env['NINEDEPLOY_AGENT_DOCKER_SOCKET']);
}

const name = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.length > MAX_NAME || !RE_NAME.test(value)) throw new Error(`Invalid ${what}`);
  return value;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A validated spec, as the argv builder reads it. */
export interface RunSpec {
  name: string;
  image: string;
  envFile: string | null;
  restart: (typeof RESTART)[number];
  network: string;
  extraNetworks: string[];
  volumes: Array<{ name: string; mount: string; readOnly: boolean }>;
  dockerSocket: boolean;
  cmd: string[];
  labels: Array<[string, string]>;
  publish: string | null;
  cpuShares: number | null;
  cpuLimitMilli: number | null;
  memLimitMb: number | null;
}

/** Validate a `docker.runSpec` request. Throws `Invalid …` naming the first bad field. */
export function parseRunSpec(p: Params, env: NodeJS.ProcessEnv = process.env): RunSpec {
  for (const key of Object.keys(p)) if (!SPEC_KEYS.has(key)) throw new Error(`Invalid runSpec field: ${key}`);
  const image = p['image'];
  if (typeof image !== 'string' || image.length > 255 || !RE_IMAGE.test(image)) throw new Error('Invalid image');

  let envFile: string | null = null;
  if (p['envFile'] !== undefined) {
    const m = typeof p['envFile'] === 'string' ? /^\.agent-env\/([^/]+)\.env$/.exec(p['envFile']) : null;
    if (!m) throw new Error('Invalid env file path');
    envFile = `.agent-env/${name(m[1], 'env file path')}.env`;
  }

  const restart = p['restart'] ?? 'unless-stopped';
  if (!RESTART.includes(restart as (typeof RESTART)[number])) throw new Error('Invalid restart policy');

  const network = name(p['network'] ?? 'ninedeploy', 'network');
  if (!network.startsWith('ninedeploy') && !network.startsWith('nd-')) throw new Error('Invalid network: must be ninedeploy* or nd-*');
  const rawExtra = p['extraNetworks'] ?? [];
  if (!Array.isArray(rawExtra) || rawExtra.length > MAX_EXTRA_NETWORKS) throw new Error('Invalid extraNetworks');
  const extraNetworks = rawExtra.map((n) => {
    const net = name(n, 'extra network');
    if (!net.startsWith('nd-')) throw new Error('Invalid extra network: must be nd-*');
    return net;
  });
  if (new Set([network, ...extraNetworks]).size !== extraNetworks.length + 1) throw new Error('Invalid extraNetworks: duplicate network');

  const rawVolumes = p['volumes'] ?? [];
  if (!Array.isArray(rawVolumes) || rawVolumes.length > MAX_VOLUMES) throw new Error('Invalid volumes');
  const volumes = rawVolumes.map((v) => {
    if (!isPlainObject(v)) throw new Error('Invalid volume');
    for (const key of Object.keys(v)) if (!['name', 'mount', 'readOnly'].includes(key)) throw new Error(`Invalid volume field: ${key}`);
    if (typeof v['name'] !== 'string' || !isManagedVolume(v['name'])) throw new Error('Invalid volume name (nd-svc-* or nd-db-*)');
    const mount = v['mount'];
    if (typeof mount !== 'string' || !mount.startsWith('/') || mount.length > 4096 || !RE_PATH(mount) || mount.includes(':')) {
      throw new Error('Invalid volume mount path');
    }
    if (v['readOnly'] !== undefined && typeof v['readOnly'] !== 'boolean') throw new Error('Invalid volume readOnly');
    return { name: v['name'], mount, readOnly: v['readOnly'] === true };
  });
  if (new Set(volumes.map((v) => v.mount)).size !== volumes.length) throw new Error('Invalid volumes: duplicate mount path');

  if (p['dockerSocket'] !== undefined && typeof p['dockerSocket'] !== 'boolean') throw new Error('Invalid dockerSocket');
  const dockerSocket = p['dockerSocket'] === true;
  if (dockerSocket && nodeDockerSocketForbidden(env)) {
    throw new Error('Docker socket mounts are disabled on this node by its owner (NINEDEPLOY_AGENT_DOCKER_SOCKET=off)');
  }
  if (dockerSocket && volumes.some((v) => v.mount === '/var/run/docker.sock')) throw new Error('Invalid volumes: duplicate mount path');

  const rawCmd = p['cmd'] ?? [];
  if (!Array.isArray(rawCmd) || rawCmd.length > MAX_CMD_ITEMS) throw new Error('Invalid cmd');
  const cmd = rawCmd.map((c) => {
    if (typeof c !== 'string' || c.length > MAX_CMD_ITEM_CHARS || c.includes('\0')) throw new Error('Invalid cmd element');
    return c;
  });

  const rawLabels = p['labels'] ?? {};
  if (!isPlainObject(rawLabels) || Object.keys(rawLabels).length > MAX_LABELS) throw new Error('Invalid labels');
  const labels: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(rawLabels).sort(([a], [b]) => a.localeCompare(b))) {
    if (!RE_LABEL_KEY.test(key) || RESERVED_LABELS.has(key)) throw new Error(`Invalid label ${key}`);
    if (typeof value !== 'string' || value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error(`Invalid label ${key}`);
    labels.push([key, value]);
  }
  const managed = p['managed'] ?? 'service';
  if (managed !== 'service' && managed !== 'database') throw new Error('Invalid managed kind');
  labels.unshift(['ninedeploy.managed', managed]);
  if (p['deploymentId'] !== undefined) labels.push(['ninedeploy.deployment', String(intOperand(p['deploymentId'], 1, 2 ** 31 - 1, 'deploymentId'))]);
  if (p['serviceId'] !== undefined) labels.push(['ninedeploy.service', String(intOperand(p['serviceId'], 1, 2 ** 31 - 1, 'serviceId'))]);

  let publish: string | null = null;
  if (p['publish'] !== undefined) {
    const m = typeof p['publish'] === 'string' ? /^(\d{1,5}):(\d{1,5})$/.exec(p['publish']) : null;
    const ports = m ? [Number(m[1]), Number(m[2])] : [];
    if (!m || ports.some((n) => n < 1 || n > 65535)) throw new Error('Invalid publish spec');
    publish = `${ports[0]}:${ports[1]}`;
  }
  const optInt = (key: string, max: number) => (p[key] === undefined ? null : intOperand(p[key], 1, max, key));
  return {
    name: name(p['name'], 'name'),
    image,
    envFile,
    restart: restart as RunSpec['restart'],
    network,
    extraNetworks,
    volumes,
    dockerSocket,
    cmd,
    labels,
    publish,
    cpuShares: optInt('cpuShares', 262_144),
    cpuLimitMilli: optInt('cpuLimitMilli', 1_024_000),
    memLimitMb: optInt('memLimitMb', 4_194_304),
  };
}

/**
 * The argv of `docker run` (or `docker create` when extra networks must be
 * connected before the start). Literal flags plus validated operands only;
 * `--memory-swap` equals `--memory`, as `resourceArgs` does for runEnv.
 */
export function runSpecArgv(spec: RunSpec, verb: 'run' | 'create'): string[] {
  const argv = verb === 'run' ? ['run', '-d'] : ['create'];
  argv.push('--name', spec.name, '--restart', spec.restart, '--network', spec.network);
  for (const [key, value] of spec.labels) argv.push('--label', `${key}=${value}`);
  if (spec.cpuShares !== null) argv.push('--cpu-shares', String(spec.cpuShares));
  if (spec.cpuLimitMilli !== null) argv.push('--cpus', String(spec.cpuLimitMilli / 1000));
  if (spec.memLimitMb !== null) argv.push('--memory', `${spec.memLimitMb}m`, '--memory-swap', `${spec.memLimitMb}m`);
  for (const v of spec.volumes) argv.push('-v', `${v.name}:${v.mount}${v.readOnly ? ':ro' : ''}`);
  if (spec.dockerSocket) argv.push('-v', '/var/run/docker.sock:/var/run/docker.sock');
  if (spec.envFile !== null) argv.push('--env-file', spec.envFile);
  if (spec.publish !== null) argv.push('-p', spec.publish);
  argv.push(spec.image, ...spec.cmd);
  return argv;
}

async function runSpecOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const spec = parseRunSpec(params);
  if (spec.extraNetworks.length === 0) return spawnValidated('docker', runSpecArgv(spec, 'run'), onLine);
  // Several networks: create, connect each, then start — `docker run` takes
  // one `--network` on every daemon this supports. A failure removes the
  // half-made container so a retry starts clean.
  const created = await spawnValidated('docker', runSpecArgv(spec, 'create'), onLine);
  if (created !== 0) return created;
  for (const net of spec.extraNetworks) {
    const connected = await spawnValidated('docker', ['network', 'connect', net, spec.name], onLine);
    if (connected !== 0) {
      await spawnValidated('docker', ['rm', '-f', spec.name], () => undefined);
      return connected;
    }
  }
  const started = await spawnValidated('docker', ['start', spec.name], onLine);
  if (started !== 0) await spawnValidated('docker', ['rm', '-f', spec.name], () => undefined);
  return started;
}

export const runSpecOps: AgentOpModule = {
  name: 'agentOps/runSpec.ts',
  caps: ['docker.runSpec'],
  ops: {
    'docker.runSpec': { cap: 'docker.runSpec', sealedOnly: true, run: (p, onLine) => runSpecOp(p, onLine) },
  },
};
