import { and, eq, ne } from 'drizzle-orm';
import { serviceVolumeAttachments, services, type DB } from '@ninedeploy/db';
import { HttpError } from './errors.js';
import { listManagedVolumeNames } from './inventory.js';
import { agentOp } from './agentClient.js';
import { capture } from './exec.js';

/**
 * r351: the primary data volume a docker service mounts at `volumeMount` —
 * `engine/builders/docker.ts`, `remoteDocker.ts` and `fanout.ts` all derive
 * it from the slug alone, with no owner stamp.
 */
export const primaryServiceVolumeName = (slug: string): string => `nd-svc-${slug}-data`;

/**
 * r648: attachment volumes (`nd-svc-<slug>-<label>`) and primary volumes
 * (`nd-svc-<slug>-data`) share one namespace, and slugs may contain dashes:
 * service `shop` + label `api-data` spells service `shop-api`'s primary volume.
 * The attach route only judged ownership when the name already existed on the
 * host, so a member could pre-create the volume another service would later
 * mount as its primary data directory — and keep reading it afterwards.
 *
 * The service whose PRIMARY volume `volumeName` is, other than `exceptServiceId`
 * (null when the name is no service's primary volume).
 */
export async function primaryVolumeOwner(
  db: DB,
  volumeName: string,
  exceptServiceId: number,
): Promise<{ id: number; name: string } | null> {
  if (!volumeName.startsWith('nd-svc-') || !volumeName.endsWith('-data')) return null;
  const slug = volumeName.slice('nd-svc-'.length, -'-data'.length);
  if (!slug) return null;
  const owner = await db.query.services.findFirst({
    where: and(eq(services.slug, slug), ne(services.id, exceptServiceId)),
    columns: { id: true, name: true },
  });
  return owner && owner.id !== exceptServiceId ? owner : null;
}

/**
 * r648: the other half — a service starting to use its primary volume (create
 * with `volumeMount`, or a PATCH that turns it on) must not mount a volume
 * another service already has attached under that name. Existing primary
 * mounts are left alone; only a new collision is refused.
 */
export async function assertPrimaryVolumeNotAttachedElsewhere(
  db: DB,
  slug: string,
  serviceId: number | null,
): Promise<void> {
  const volume = primaryServiceVolumeName(slug);
  const rows = await db
    .select({ serviceId: serviceVolumeAttachments.serviceId })
    .from(serviceVolumeAttachments)
    .where(eq(serviceVolumeAttachments.volumeName, volume));
  if (rows.some((r) => r.serviceId !== serviceId)) {
    throw new HttpError(
      409,
      'slug_volume_attached',
      `The data volume '${volume}' is already attached to another service as an extra volume — enabling a volume mount here would share that service's data. Ask an operator to detach or rename that attachment first.`,
    );
  }
}

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
/**
 * r662: slack for clock skew between the panel (which stamped the service
 * row) and the docker host (which stamped the volume).
 */
const OWN_VOLUME_SKEW_MS = 5 * 60 * 1000;

/** The `CreatedAt` of a `docker volume inspect` JSON answer, or null. */
function volumeCreatedAt(text: string): Date | null {
  const m = /"CreatedAt"\s*:\s*"([^"]+)"/.exec(text) ?? /^\s*(\d{4}-\d{2}-\d{2}T\S+)\s*$/m.exec(text);
  if (!m?.[1]) return null;
  const at = new Date(m[1]);
  return Number.isNaN(at.getTime()) ? null : at;
}

export async function assertSlugVolumeNotRetained(
  slug: string,
  type: string,
  opts: { db?: DB; serverId?: number | null; ownerCreatedAt?: Date | null } = {},
): Promise<void> {
  const db = opts.db ?? null;
  const serverId = opts.serverId ?? null;
  const volume = primaryServiceVolumeName(slug);
  let retained: boolean;
  let unreachable: string | null = null;
  /** Docker's own creation stamp of the existing volume, when it could be read. */
  let createdAt: Date | null = null;
  if (serverId != null) {
    if (db === null) throw new Error('assertSlugVolumeNotRetained needs the db to reach a node agent');
    try {
      // tolerateExit: `docker volume inspect` exits 1 for a MISSING volume —
      // that is the answer, not a failure. Without it agentOp would throw on
      // exactly the case we are probing for, and the catch below would
      // fail-closed on every fresh slug (r470: every server-pinned create
      // answered 409 "treated as retained").
      const res = await agentOp(db, serverId, 'docker.volumeInspect', { name: volume }, () => undefined, { tolerateExit: true });
      retained = res.exitCode === 0;
      if (retained) createdAt = volumeCreatedAt(res.lines.join('\n'));
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
    if (retained && opts.ownerCreatedAt) {
      createdAt = volumeCreatedAt(
        await capture('docker', ['volume', 'inspect', '--format', '{{.CreatedAt}}', volume]).catch(() => ''),
      );
    }
  }
  if (!retained) return;
  // r662: an EXISTING service moving between hosts (`ownerCreatedAt` set)
  // may meet its own volume from an earlier placement there. Slugs are unique
  // among live rows, so a volume Docker created after this row existed can
  // only be this service's own; one created before it is a deleted service's
  // — the case the guard exists for. Unreadable stamps stay refused.
  if (opts.ownerCreatedAt && createdAt && createdAt.getTime() >= opts.ownerCreatedAt.getTime() - OWN_VOLUME_SKEW_MS) return;
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
