import type { DB } from '@ninedeploy/db';
import { agentOp } from './agentClient.js';
import { assertNodeCapability } from './agentCapabilities.js';
import { badRequest } from './errors.js';
import { capture } from './exec.js';

/**
 * G3.1 the named volumes of a compose stack (`ndcmp-<slug>_<key>`), on the
 * panel host or a node (agent `volume.compose`, 0.18.7). Listing reads the
 * project label compose puts on every volume it creates; creating stamps the
 * same labels, so the stack's next `up` adopts the volume as its own.
 *
 * A volume with a fixed `name:` is labelled for the project too but is not
 * named after it; it is listed (`fixed: true`) so a move can refuse it rather
 * than leave it behind. External volumes and bind mounts carry no label and
 * are not compose's to move.
 */

export interface ComposeVolume {
  name: string;
  /** The volume's key in the compose file. */
  key: string;
  /** True when the name is not `<project>_<key>` (a fixed `name:`). */
  fixed: boolean;
}

export const composeProject = (slug: string): string => `ndcmp-${slug}`;

const FORMAT = '{{.Name}}\t{{.Label "com.docker.compose.volume"}}';
const RE_COMPOSE_VOLUME = /^ndcmp-[a-z0-9][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** `<name>\t<key>` lines (agent `docker.composeVolumes`, or the local `docker volume ls`) → volumes of `project`. */
export function parseComposeVolumes(lines: readonly string[], project: string): ComposeVolume[] {
  const out: ComposeVolume[] = [];
  for (const line of lines) {
    const [name = '', key = ''] = line.trim().split('\t');
    if (!name) continue;
    const fixed = !(name.startsWith(`${project}_`) && name.length <= 128 && RE_COMPOSE_VOLUME.test(name));
    out.push({ name, key, fixed });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const NODE_FEATURE = 'move a compose stack with its volumes';

/** Refuses (422) a node whose agent cannot list, create and transfer compose volumes. */
export async function assertComposeVolumesOnNode(db: DB, serverId: number): Promise<void> {
  await assertNodeCapability(db, serverId, { cap: 'volume.compose', feature: NODE_FEATURE, sealedRequired: true });
}

/** The stack's volumes where it runs now (`host` null = the panel host). */
export async function composeVolumes(db: DB, host: number | null, slug: string): Promise<ComposeVolume[]> {
  const project = composeProject(slug);
  if (host === null) {
    const out = await capture('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', FORMAT], { timeoutMs: 30_000 });
    return parseComposeVolumes(out.split('\n'), project);
  }
  await assertComposeVolumesOnNode(db, host);
  const res = await agentOp(db, host, 'docker.composeVolumes', { project }, () => undefined);
  return parseComposeVolumes(res.lines, project);
}

/**
 * Create `ndcmp-<slug>_<key>` on the target with compose's labels. An
 * existing volume compose made for the same project is reused (the restore
 * replaces its contents); anything else under that name is refused.
 */
export async function createComposeVolume(db: DB, host: number | null, name: string): Promise<void> {
  if (!RE_COMPOSE_VOLUME.test(name) || name.length > 128) throw badRequest(`${name} is not a compose stack volume`, 'move_fixed_volume_names');
  const i = name.indexOf('_');
  const project = name.slice(0, i);
  if (host !== null) {
    await assertComposeVolumesOnNode(db, host);
    await agentOp(db, host, 'docker.composeVolumeCreate', { name }, () => undefined);
    return;
  }
  const label = await capture('docker', ['volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', name], { timeoutMs: 30_000 }).then(
    (out) => out.trim(),
    () => null,
  );
  if (label === project) return;
  if (label !== null) throw new Error(`Volume ${name} exists on the panel host and was not created by compose for ${project}`);
  await capture('docker', ['volume', 'create', '--label', `com.docker.compose.project=${project}`, '--label', `com.docker.compose.volume=${name.slice(i + 1)}`, name], {
    timeoutMs: 60_000,
  });
}
