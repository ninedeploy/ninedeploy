import { randomUUID } from 'node:crypto';
import { HELPER_IMAGE } from '../lib/inventory.js';
import { AGENT_LONG_OP_TIMEOUT_MS } from '../lib/agentClient.js';
import { spawnValidated, spawnValidatedStream } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import { isManagedVolume, type Params, str, validated } from './operands.js';
import type { PreparedStream, StreamKindHandler } from './stream.js';

/**
 * Volume ops on a node (multi-node, capability `volume.manage`, design §1.1,
 * §4) and the two volume stream kinds. Only managed names (`nd-svc-*`,
 * `nd-db-*`) are ever touched; bind mounts stay refused everywhere. The
 * archive format is the panel host's (`tar -czf` of the volume's root through
 * the same pinned helper image, restored by the same staging script from
 * engine/database.ts), so a node backup restores on the panel and back.
 */

const managedVolume = (value: string | undefined): string => validated(value, isManagedVolume, 'volume name (nd-svc-* or nd-db-*)');

/** `ninedeploy.*` labels a created volume carries (provenance, like the panel's). */
const RE_VOLUME_LABEL_KEY = /^ninedeploy\.[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_VOLUME_LABELS = 16;

function volumeLabels(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid volume labels');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_VOLUME_LABELS) throw new Error('Invalid volume labels: too many');
  const argv: string[] = [];
  for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!RE_VOLUME_LABEL_KEY.test(key) || typeof value !== 'string' || value.length > 256 || /[\0\r\n]/.test(value)) {
      throw new Error(`Invalid volume label ${key}`);
    }
    argv.push('--label', `${key}=${value}`);
  }
  return argv;
}

/** Exit 0 when the volume exists (the existence probe). */
const volumeExists = async (name: string): Promise<boolean> => (await spawnValidated('docker', ['volume', 'inspect', name], () => undefined)) === 0;

/** Exit code `docker.volumeCreate` answers when `ifExists: 'fail'` met an existing volume. */
export const VOLUME_EXISTS_EXIT = 3;

/**
 * `docker.volumeCreate {name, labels?, ifExists?}`. Idempotent like the
 * panel's `createDockerVolume` (`ifExists: 'ok'`, the default); `'fail'`
 * answers {@link VOLUME_EXISTS_EXIT} with an `ND-VOLUME-EXISTS` line instead
 * — a database refuses to adopt a retained volume (design §12).
 */
async function volumeCreateOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const name = managedVolume(str(params, 'name'));
  const labels = volumeLabels(params['labels']);
  const ifExists = params['ifExists'] ?? 'ok';
  if (ifExists !== 'ok' && ifExists !== 'fail') throw new Error('Invalid ifExists');
  if (ifExists === 'fail' && (await volumeExists(name))) {
    onLine(`ND-VOLUME-EXISTS ${name}`);
    return VOLUME_EXISTS_EXIT;
  }
  return spawnValidated('docker', ['volume', 'create', ...labels, name], onLine);
}

/** `docker.volumeList`: one JSON line per volume (a literal format string, never the caller's). */
async function volumeListOp(onLine: (line: string) => void): Promise<number> {
  return spawnValidated('docker', ['volume', 'ls', '--format', '{{json .}}'], onLine);
}

export const volumeOps: AgentOpModule = {
  name: 'agentOps/volumes.ts',
  caps: ['volume.manage'],
  ops: {
    'docker.volumeCreate': { cap: 'volume.manage', sealedOnly: false, run: (p, onLine) => volumeCreateOp(p, onLine) },
    'docker.volumeList': { cap: 'volume.manage', sealedOnly: false, run: (_p, onLine) => volumeListOp(onLine) },
  },
};

// ── stream kinds ─────────────────────────────────────────────────────────────

/** Running containers that mount the volume (a restore under them is refused). */
async function containersUsing(volume: string): Promise<string[]> {
  const ids: string[] = [];
  await spawnValidated('docker', ['ps', '-q', '--filter', `volume=${volume}`], (l) => {
    if (/^[0-9a-f]{12,64}$/.test(l.trim())) ids.push(l.trim());
  });
  return ids;
}

/** `volume.export {volume}` (agent→panel): `tar -czf - -C /v .` of the volume, read-only, no network. */
export const volumeExportKind: StreamKindHandler = {
  keys: ['volume'],
  async prepare(params) {
    const volume = managedVolume(str(params, 'volume'));
    // `docker run -v` would CREATE a missing volume: check first.
    if (!(await volumeExists(volume))) throw new Error(`Volume ${volume} does not exist on this node`);
    return {
      direction: 'agent-to-panel',
      async start() {
        const child = spawnValidatedStream(
          'docker',
          ['run', '--rm', '--network', 'none', '-v', `${volume}:/v:ro`, HELPER_IMAGE, 'tar', '-czf', '-', '-C', '/v', '.'],
          { timeoutMs: AGENT_LONG_OP_TIMEOUT_MS },
        );
        return {
          stream: child.stdout,
          done: child.exit.then(({ code, stderr }) => {
            if (code !== 0) throw new Error(`the volume export exited with ${code}: ${stderr.trim().slice(-500)}`);
            return { volume };
          }),
          abort: () => child.kill(),
        };
      },
    } satisfies PreparedStream;
  },
};

/**
 * `volume.import {volume}` (panel→agent): the verified archive goes through
 * the panel host's restore script (stage, then swap), so a corrupt archive
 * leaves the volume as it was. Refused while a running container uses it.
 */
export const volumeImportKind: StreamKindHandler = {
  keys: ['volume'],
  async prepare(params) {
    const volume = managedVolume(str(params, 'volume'));
    if (!(await volumeExists(volume))) throw new Error(`Volume ${volume} does not exist on this node (create it first)`);
    const refuseInUse = async () => {
      if ((await containersUsing(volume)).length > 0) throw new Error(`Volume ${volume} is in use by a running container; stop it before restoring`);
    };
    await refuseInUse();
    return {
      direction: 'panel-to-agent',
      gunzip: false,
      async apply(file) {
        await refuseInUse();
        const { volumeRestoreScript, VOLUME_TMP_ARCHIVE } = await import('../engine/database.js');
        const created: string[] = [];
        const create = await spawnValidated(
          'docker',
          ['create', '--network', 'none', '-v', `${volume}:/v`, HELPER_IMAGE, 'sh', '-c', volumeRestoreScript(randomUUID().slice(0, 8))],
          (l) => created.push(l.trim()),
        );
        const cid = created.find((l) => /^[0-9a-f]{12,64}$/.test(l));
        if (create !== 0 || !cid) throw new Error(`could not create the restore helper: ${created.join(' ').slice(-500)}`);
        const output: string[] = [];
        try {
          const copied = await spawnValidated('docker', ['cp', file, `${cid}:${VOLUME_TMP_ARCHIVE}`], (l) => output.push(l));
          if (copied !== 0) throw new Error(`docker cp exited with ${copied}: ${output.join(' ').slice(-500)}`);
          const ran = await spawnValidated('docker', ['start', '-a', cid], (l) => output.push(l), { timeoutMs: AGENT_LONG_OP_TIMEOUT_MS });
          if (ran !== 0) throw new Error(`the restore exited with ${ran} (the volume keeps its previous contents): ${output.join(' ').slice(-500)}`);
        } finally {
          await spawnValidated('docker', ['rm', '-f', cid], () => undefined);
        }
        return { volume };
      },
    } satisfies PreparedStream;
  },
};

// ── 0.16 T5 node volumes ─────────────────────────────────────────────────────
// The Volumes page for a node (design §4.2, §4.3) needs two answers
// `docker.volumeList` does not give: which containers mount each volume (the
// `inUse` flag, and the restore guard's "stop the service first"), and how
// big a volume is. Both are read-only, on `volume.manage` (advertised since
// the same release), and take only literal formats or a managed name.

/** Separator of a `docker.volumeUsage` line: `<container>\t<state>\t<mounts>`. */
export const VOLUME_USAGE_FORMAT = '{{.Names}}\t{{.State}}\t{{.Mounts}}';

/**
 * `docker.volumeUsage`: one line per container on the node (running or not)
 * with the names of the volumes it mounts — the panel keeps the managed ones.
 * A literal format string, never the caller's.
 */
async function volumeUsageOp(onLine: (line: string) => void): Promise<number> {
  return spawnValidated('docker', ['ps', '-a', '--no-trunc', '--format', VOLUME_USAGE_FORMAT], onLine);
}

/** Exit code `docker.volumeSize` answers for a volume that does not exist (it is never created). */
export const VOLUME_MISSING_EXIT = 4;

/**
 * `docker.volumeSize {name}`: `du -sb` of the volume through the pinned helper
 * image, read-only and without a network — the panel host's own size probe
 * (modules/volumes.ts). The existence check comes first: `docker run -v`
 * would CREATE a missing volume.
 */
async function volumeSizeOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const name = managedVolume(str(params, 'name'));
  if (!(await volumeExists(name))) {
    onLine(`ND-VOLUME-MISSING ${name}`);
    return VOLUME_MISSING_EXIT;
  }
  return spawnValidated('docker', ['run', '--rm', '--network', 'none', '-v', `${name}:/v:ro`, HELPER_IMAGE, 'du', '-sb', '/v'], onLine);
}

export const nodeVolumeOps: AgentOpModule = {
  name: 'agentOps/volumes.ts (node volumes)',
  caps: ['volume.manage'],
  ops: {
    'docker.volumeUsage': { cap: 'volume.manage', sealedOnly: false, run: (_p, onLine) => volumeUsageOp(onLine) },
    'docker.volumeSize': { cap: 'volume.manage', sealedOnly: false, run: (p, onLine) => volumeSizeOp(p, onLine) },
  },
};
// ── end 0.16 T5 ──
