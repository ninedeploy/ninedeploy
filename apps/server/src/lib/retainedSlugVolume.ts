import { HttpError } from './errors.js';
import { listManagedVolumeNames } from './inventory.js';

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
 */
export async function assertSlugVolumeNotRetained(slug: string, type: string): Promise<void> {
  const volume = primaryServiceVolumeName(slug);
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
  if (!names.includes(volume)) return;
  throw new HttpError(
    409,
    'slug_volume_retained',
    `The data volume '${volume}' of a deleted service still exists — a new service with slug '${slug}' would mount its data. ` +
      'Pick another name/slug, or have an operator back it up and delete it from the Volumes page first.',
  );
}
