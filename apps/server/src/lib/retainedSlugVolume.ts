import type { DB } from '@ninedeploy/db';
import { HttpError } from './errors.js';
import { listManagedVolumeNames } from './inventory.js';
import { agentOp } from './agentClient.js';

/**
 * r351: the primary data volume a docker service mounts at `volumeMount` —
 * `engine/builders/docker.ts`, `remoteDocker.ts` and `fanout.ts` all derive
 * it from the slug alone, with no owner stamp.
 */
export const primaryServiceVolumeName = (slug: string): string => `nd-svc-${slug}-data`;

/**
 * r351: refuse to create a service row whose slug would silently re-mount a
 * DELETED service's data.
 *
 * Deleting a service deliberately keeps `nd-svc-<slug>-data` (data outlives
 * the row, like a database volume). Slug uniqueness only covers live rows,
 * so a new service — possibly another tenant's — created under the freed
 * slug got the old volume mounted read-write on its first deploy: the
 * previous owner's uploads, SQLite files and secrets, with nothing in the
 * panel saying so. A retained volume is refused with 409
 * `slug_volume_retained`; an operator has to delete it (after a backup, if
 * the data is still wanted) from the Volumes page, or the caller picks
 * another slug.
 *
 * Callers invoke this only after the live-row duplicate check, so an
 * existing volume here is never the new row's own.
 *
 * Docker unreachable: decided as if the volume exists (fail closed — the same
 * rule `serviceVolumes.ts` applies to create-on-attach), except for a PM2
 * service, which never mounts a docker volume and must stay creatable on a
 * host whose daemon is down.
 *
 * r466: a service pinned to a remote node (`serverId`) mounts its volume ON
 * THE NODE — the panel host's volume list is the wrong machine entirely (a
 * local volume of the same name is NOT mounted by the new service, and a
 * node volume is invisible to a local check). For those, the existence probe
 * runs through the node's agent instead, with the same fail-closed rule: an
 * unreachable agent is decided as if the volume exists.
 */
export async function assertSlugVolumeNotRetained(
  slug: string,
  type: string,
  opts: { db?: DB; serverId?: number | null } = {},
): Promise<void> {
  const db = opts.db ?? null;
  const serverId = opts.serverId ?? null;
  const volume = primaryServiceVolumeName(slug);
  let retained: boolean;
  let unreachable: string | null = null;
  if (serverId != null) {
    if (db === null) throw new Error('assertSlugVolumeNotRetained needs the db to reach a node agent');
    try {
      const res = await agentOp(db, serverId, 'docker.volumeInspect', { name: volume }, () => undefined);
      retained = res.exitCode === 0;
    } catch (err) {
      // The agent itself blinked (offline node, unknown op on an old agent) —
      // fail closed: treat the node volume as retained.
      unreachable = err instanceof Error ? err.message : String(err);
      retained = true;
    }
  } else {
    let names: string[];
    try {
      names = await listManagedVolumeNames();
    } catch {
      if (type === 'pm2') return;
      throw new HttpError(
        409,
        'slug_volume_retained',
        `Could not ask Docker whether a deleted service's data volume '${volume}' still exists — retry once Docker is reachable.`,
      );
    }
    retained = names.includes(volume);
  }
  if (!retained) return;
  if (type === 'pm2' && unreachable) return;
  throw new HttpError(
    409,
    'slug_volume_retained',
    (serverId != null
      ? `The data volume '${volume}' of a deleted service still exists ON NODE #${serverId}` +
        (unreachable ? ` (the node could not be asked: ${unreachable} — treated as retained)` : '')
      : `The data volume '${volume}' of a deleted service still exists`) +
      ` — a new service with slug '${slug}' would mount its data. ` +
      (serverId != null
        ? `Pick another name/slug, or have an operator delete the node volume (Volumes page, ?serverId=${serverId}).`
        : 'Pick another name/slug, or have an operator back it up and delete it from the Volumes page first.'),
  );
}
