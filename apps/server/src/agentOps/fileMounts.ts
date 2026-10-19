import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_SERVICE_FILE_BYTES, MAX_SERVICE_FILES, serviceFilePathProblem, utf8Length } from '@ninedeploy/schemas';
import type { AgentOpModule } from './index.js';
import { intOperand, type Params, RE_NAME } from './operands.js';

/**
 * 0.16.5 `docker.fileMounts`: a node service's file mounts (Service → Volumes
 * → Files), as the panel host has had them since 0.16.3.
 *
 * `file.writeMount` writes one file per request (a file is at most 256 KiB, the
 * agent's body limit 2 MiB) to `.agent-files/<service>/d<deployment>/<id>`;
 * `docker.runSpec` then bind-mounts it read-only through its `fileMounts`
 * field. The agent runs in AGENT_HOME, bind-mounted at the same path on the
 * host, so the absolute path it hands the daemon is the file on the host.
 *
 * The content can hold secrets: every directory down to the files is 0700.
 * The files stay 0644 for the container's user (the daemon resolves a bind
 * source as root; inside the container only the file's own mode counts). A
 * fresh directory per deployment keeps the outgoing container on the content
 * it started with; older ones are pruned, and `file.removeMounts` drops a
 * deleted service's.
 */

export const FILES_DIR = '.agent-files';
/** Deployment directories kept per service: the new one and the two before it. */
const KEEP_DEPLOYMENTS = 3;
const MAX_ID = 2 ** 31 - 1;
/** What `file.writeMount` answers and `docker.runSpec` accepts as a file. */
const RE_FILE_REF = /^\.agent-files\/([^/]+)\/d(\d{1,10})\/(\d{1,10})$/;

const serviceName = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 128 || !RE_NAME.test(value)) throw new Error('Invalid service name');
  return value;
};

const serviceDir = (service: string): string => path.join(process.cwd(), FILES_DIR, service);

/** One validated `fileMounts` entry of `docker.runSpec`: the host file and where it is mounted. */
export interface SpecFileMount {
  /** `.agent-files/<service>/d<deployment>/<id>`, relative to the agent's home. */
  file: string;
  mount: string;
}

/** Validate `docker.runSpec`'s `fileMounts`. Pure: whether each file exists is checked before the run. */
export function parseFileMounts(raw: unknown): SpecFileMount[] {
  const list = raw ?? [];
  if (!Array.isArray(list) || list.length > MAX_SERVICE_FILES) throw new Error('Invalid fileMounts');
  const mounts = list.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Invalid file mount');
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) if (key !== 'file' && key !== 'mount') throw new Error(`Invalid file mount field: ${key}`);
    const m = typeof e['file'] === 'string' ? RE_FILE_REF.exec(e['file']) : null;
    if (!m || !RE_NAME.test(m[1]!) || Number(m[2]) > MAX_ID || Number(m[3]) > MAX_ID) throw new Error('Invalid file mount file');
    const mount = e['mount'];
    if (
      typeof mount !== 'string' ||
      !mount.startsWith('/') ||
      mount.length > 255 ||
      mount.includes(':') ||
      /[\0\r\n]/.test(mount) ||
      mount.split('/').includes('..') ||
      serviceFilePathProblem(mount) !== null
    ) {
      throw new Error('Invalid file mount path');
    }
    return { file: e['file'] as string, mount };
  });
  if (new Set(mounts.map((f) => f.mount)).size !== mounts.length) throw new Error('Invalid fileMounts: duplicate mount path');
  return mounts;
}

/** The `-v` source of a file mount: its absolute path on the host. */
export const fileMountSource = (f: SpecFileMount): string => path.join(process.cwd(), f.file);

/** Throws unless every file was written by `file.writeMount` (a missing source would make Docker create a directory). */
export function assertFileMountsWritten(mounts: readonly SpecFileMount[]): void {
  for (const f of mounts) {
    let ok = false;
    try {
      const st = lstatSync(fileMountSource(f));
      ok = st.isFile() && !st.isSymbolicLink();
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`File mount ${f.mount}: ${f.file} was not written on this node`);
  }
}

function writeMountOp(p: Params, onLine: (line: string) => void): number {
  for (const key of Object.keys(p)) if (!['service', 'deploymentId', 'id', 'content'].includes(key)) throw new Error(`Invalid field: ${key}`);
  const service = serviceName(p['service']);
  const deploymentId = intOperand(p['deploymentId'], 1, MAX_ID, 'deploymentId');
  const id = intOperand(p['id'], 1, MAX_ID, 'file id');
  const content = p['content'];
  if (typeof content !== 'string' || utf8Length(content) > MAX_SERVICE_FILE_BYTES) throw new Error('Invalid file content');

  const root = path.join(process.cwd(), FILES_DIR);
  const svcDir = serviceDir(service);
  const dir = path.join(svcDir, `d${deploymentId}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is narrowed by the umask and never applied to a directory that already exists.
  for (const d of [root, svcDir, dir]) chmodSync(d, 0o700);
  const file = path.join(dir, String(id));
  // `wx` (O_CREAT|O_EXCL) never follows a link left at the name.
  rmSync(file, { force: true });
  writeFileSync(file, content, { mode: 0o644, flag: 'wx' });
  chmodSync(file, 0o644);
  pruneDeploymentDirs(svcDir, deploymentId);
  onLine(`wrote ${FILES_DIR}/${service}/d${deploymentId}/${id}`);
  return 0;
}

/** Drop all but the newest KEEP_DEPLOYMENTS directories (never `current`). */
function pruneDeploymentDirs(svcDir: string, current: number): void {
  const ids = readdirSync(svcDir)
    .map((name) => /^d(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  for (const id of ids.slice(KEEP_DEPLOYMENTS)) {
    if (id !== current) rmSync(path.join(svcDir, `d${id}`), { recursive: true, force: true });
  }
}

function removeMountsOp(p: Params, onLine: (line: string) => void): number {
  for (const key of Object.keys(p)) if (key !== 'service') throw new Error(`Invalid field: ${key}`);
  const service = serviceName(p['service']);
  rmSync(serviceDir(service), { recursive: true, force: true });
  onLine(`removed ${FILES_DIR}/${service}`);
  return 0;
}

export const fileMountOps: AgentOpModule = {
  name: 'agentOps/fileMounts.ts',
  // Also the `fileMounts` field of docker.runSpec (agentOps/runSpec.ts).
  caps: ['docker.fileMounts'],
  ops: {
    'file.writeMount': { cap: 'docker.fileMounts', sealedOnly: true, run: async (p, onLine) => writeMountOp(p, onLine) },
    // No secret travels in a removal.
    'file.removeMounts': { cap: 'docker.fileMounts', sealedOnly: false, run: async (p, onLine) => removeMountsOp(p, onLine) },
  },
};
