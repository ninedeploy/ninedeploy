import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { databases, services, serviceVolumeAttachments } from '@ninedeploy/db';
import { volumeFileWrite, volumePathCreate } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { removeVolume, volumeLabels } from '../engine/database.js';
import { capture } from '../lib/exec.js';
import { ensureDockerImage } from '../lib/dockerPull.js';
import { containerRunning, resolveVolumeOwner, HELPER_IMAGE } from '../lib/inventory.js';
import { badRequest, conflict } from '../lib/errors.js';
import {
  deleteVolumePath,
  isManagedVolume,
  listVolumeDir,
  makeVolumeDir,
  readVolumeFile,
  safeRelPath,
  writeVolumeFile,
} from '../engine/volumeFiles.js';

interface VolumeOwner {
  kind: 'service' | 'database';
  id: number;
  name: string;
  engine?: string;
  containerName: string | null;
}

/**
 * Resolve the owner (service/database) of a managed volume name, if any.
 * Callers guarantee the name starts with nd-svc-/nd-db-; anything else is
 * ownerless (orphan) by definition. Also consults the
 * `service_volume_attachments` table so user-attached volumes (which do
 * not have to follow the legacy `nd-svc-<slug>-data` naming) resolve to
 * the right owning service.
 */
async function volumeOwner(db: FastifyInstance['db'], name: string): Promise<VolumeOwner | null> {
  const [svcs, dbs, atts] = await Promise.all([
    db.select().from(services),
    db.select().from(databases),
    db.select().from(serviceVolumeAttachments),
  ]);
  const owner = resolveVolumeOwner(svcs, dbs, name, atts);
  if (!owner) return null;
  return { kind: owner.kind, id: owner.refId, name: owner.name, engine: owner.engine, containerName: owner.containerName };
}

/** Volume size for a named Docker volume (bytes), via a throwaway alpine container. */
async function volumeSize(name: string): Promise<number> {
  try {
    await ensureDockerImage(HELPER_IMAGE, () => undefined);
    const out = await capture('docker', ['run', '--rm', '-v', `${name}:/v`, HELPER_IMAGE, 'sh', '-c', 'du -sb /v']);
    return Number(out.trim().split(/\s+/)[0]!) || 0;
  } catch {
    return 0;
  }
}

/** Creation labels of an ownerless managed volume, as the API's `retainedFrom`
 *  shape; omitted entirely when the volume carries no provenance (created
 *  before labeling, or by hand). */
async function retainedProvenance(
  name: string,
): Promise<{ retainedFrom?: { name: string | null; engine: string | null } }> {
  try {
    const labels = await volumeLabels(name);
    if (labels['ninedeploy.managed'] !== 'database') return {};
    return {
      retainedFrom: {
        name: labels['ninedeploy.database.name'] ?? labels['ninedeploy.database.slug'] ?? null,
        engine: labels['ninedeploy.database.engine'] ?? null,
      },
    };
  } catch {
    return {};
  }
}

/** Inventory of NineDeploy-managed persistent volumes. Mounted under /volumes. */
export const volumeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // L-12: the instance-wide volume inventory (names, sizes, owning service)
  // is infrastructure metadata about every tenant. Mutating volume routes were
  // already admin-only; the listing had been left open.
  app.get('/', { preHandler: [app.requireAdmin] }, async () => {
    let raw = '';
    try {
      raw = await capture('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    } catch {
      return [];
    }

    const names = raw
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith('nd-svc-') || n.startsWith('nd-db-'));

    const out: Array<{ name: string; sizeBytes: number; owner: { kind: 'service' | 'database'; id: number; name: string; engine?: string } | null; inUse: boolean; retainedFrom?: { name: string | null; engine: string | null } }> = [];
    for (const name of names) {
      const owner = await volumeOwner(app.db, name);
      const inUse = owner ? await containerRunning(owner.containerName) : false;
      out.push({
        name,
        sizeBytes: await volumeSize(name),
        owner: owner ? { kind: owner.kind, id: owner.id, name: owner.name, engine: owner.engine } : null,
        inUse,
        // Ownerless managed volumes keep their data on purpose; their creation
        // labels say WHAT was deleted even though the row is long gone.
        ...(owner ? {} : await retainedProvenance(name)),
      });
    }
    return out;
  });

  // Permanently delete all unattached / retained volumes (bulk cleanup).
  app.post('/prune', { preHandler: [app.requireAdmin] }, async (req) => {
    let raw = '';
    try {
      raw = await capture('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    } catch {
      return { ok: true, deleted: 0, freedBytes: 0 };
    }

    const names = raw
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith('nd-svc-') || n.startsWith('nd-db-'));

    let deletedCount = 0;
    let freedBytes = 0;
    for (const name of names) {
      const owner = await volumeOwner(app.db, name);
      if (!owner) {
        const size = await volumeSize(name);
        await removeVolume(name, (line) => req.log.info(line));
        freedBytes += size;
        deletedCount++;
      }
    }

    void audit(app.db, req.user!.id, 'volume.prune', `pruned ${deletedCount} retained volume(s)`);
    return { ok: true, deleted: deletedCount, freedBytes };
  });

  // Permanently delete a retained volume (the real, destructive cleanup).
  // Admin-only + audited: this irreversibly destroys a service's or database's
  // persistent data — so it REFUSES volumes whose owner's container is running
  // (stop the service/database first) and non-managed volume names.
  app.delete('/:name', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = (req.params as { name: string }).name;
    if (!name.startsWith('nd-svc-') && !name.startsWith('nd-db-')) {
      throw badRequest('not a managed volume');
    }
    const owner = await volumeOwner(app.db, name);
    if (owner && (await containerRunning(owner.containerName))) {
      throw conflict(`Volume is in use by ${owner.kind} "${owner.name}" — stop it before deleting the volume`);
    }
    void audit(app.db, req.user!.id, 'volume.delete', name);
    await removeVolume(name, (line) => req.log.info(line));
    return { ok: true };
  });

  // ── File manager inside a volume ─────────────────────────────────────────
  // All routes are admin-only + audited: this is full read/write access to
  // the volume's data (same power as the exec terminal, so same guard).
  const guardVolume = (name: string): string => {
    if (!isManagedVolume(name)) throw badRequest('not a managed volume');
    return name;
  };
  const guardPath = (raw: unknown): string => {
    const rel = safeRelPath(String(raw ?? ''));
    if (rel === null) throw badRequest('invalid path');
    return rel;
  };

  app.get('/:name/files', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = guardVolume((req.params as { name: string }).name);
    const rel = guardPath((req.query as { path?: string }).path);
    return { path: rel, entries: await listVolumeDir(name, rel) };
  });

  app.get('/:name/files/content', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const name = guardVolume((req.params as { name: string }).name);
    const rel = guardPath((req.query as { path?: string }).path);
    if (!rel) throw badRequest('a path inside the volume is required');
    void audit(app.db, req.user!.id, 'volume.file.read', `${name}:${rel}`);
    const file = await readVolumeFile(name, rel);
    reply.header('content-type', 'application/json');
    return file;
  });

  app.put('/:name/files', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = guardVolume((req.params as { name: string }).name);
    const input = volumeFileWrite.parse(req.body);
    const rel = guardPath(input.path);
    if (!rel) throw badRequest('a path inside the volume is required');
    void audit(app.db, req.user!.id, 'volume.file.write', `${name}:${rel}`);
    await writeVolumeFile(name, rel, input.contentBase64, (line) => req.log.info(line));
    return { ok: true };
  });

  app.post('/:name/files/dir', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = guardVolume((req.params as { name: string }).name);
    const input = volumePathCreate.parse(req.body);
    const rel = guardPath(input.path);
    void audit(app.db, req.user!.id, 'volume.file.mkdir', `${name}:${rel}`);
    await makeVolumeDir(name, rel);
    return { ok: true };
  });

  app.delete('/:name/files', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = guardVolume((req.params as { name: string }).name);
    const rel = guardPath((req.query as { path?: string }).path);
    if (!rel) throw badRequest('a path inside the volume is required');
    void audit(app.db, req.user!.id, 'volume.file.delete', `${name}:${rel}`);
    await deleteVolumePath(name, rel, (line) => req.log.info(line));
    return { ok: true };
  });
};
