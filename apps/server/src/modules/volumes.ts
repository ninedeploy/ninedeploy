import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { databases, services, serviceVolumeAttachments } from '@ninedeploy/db';
import { volumeFileWrite, volumePathCreate } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { removeVolume, volumeExists, volumeLabels } from '../engine/database.js';
import { capture } from '../lib/exec.js';
import { agentOp } from '../lib/agentClient.js';
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
 * Resolve owners for a whole batch of volume names with ONE read of each
 * table. The old per-volume `volumeOwner` re-read services/databases/
 * attachments (full tables) for every name — the Volumes page cost 3V queries
 * before it even started measuring sizes.
 */
async function volumeOwners(
  db: FastifyInstance['db'],
  names: string[],
): Promise<Map<string, VolumeOwner>> {
  if (names.length === 0) return new Map();
  const [svcs, dbs, atts] = await Promise.all([
    db.select().from(services),
    db.select().from(databases),
    db.select().from(serviceVolumeAttachments),
  ]);
  const out = new Map<string, VolumeOwner>();
  for (const name of names) {
    const owner = resolveVolumeOwner(svcs, dbs, name, atts);
    if (owner) {
      out.set(name, { kind: owner.kind, id: owner.refId, name: owner.name, engine: owner.engine, containerName: owner.containerName });
    }
  }
  return out;
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
    const owners = await volumeOwners(app.db, names);
    for (const name of names) {
      const owner = owners.get(name) ?? null;
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
    const owners = await volumeOwners(app.db, names);
    for (const name of names) {
      if (owners.has(name)) continue;
      const size = await volumeSize(name);
      await removeVolume(name, (line) => req.log.info(line));
      // removeVolume tolerates a failed `docker volume rm` (an ownerless
      // volume can still be mounted by an orphaned container) — reporting it
      // deleted while it survived would be a lie, so verify it landed.
      if (await volumeExists(name)) {
        req.log.warn(`volume ${name} survived prune (in use by an unmanaged container?) — skipping`);
        continue;
      }
      freedBytes += size;
      deletedCount++;
    }

    void audit(app.db, req.user!.id, 'volume.prune', `pruned ${deletedCount} retained volume(s)`);
    return { ok: true, deleted: deletedCount, freedBytes };
  });

  // Permanently delete a retained volume (the real, destructive cleanup).
  // Admin-only + audited: this irreversibly destroys a service's or database's
  // persistent data — so it REFUSES volumes whose owner's container is running
  // (stop the service/database first) and non-managed volume names.
  //
  // r466: `?serverId=N` deletes a NODE-side retained volume through that
  // node's agent — a remote service's data volume lives on the node, was
  // invisible to the panel's volume list, and could never be cleaned up. The
  // in-use refusal rides docker itself: `volume rm` on the node fails while a
  // container mounts it, and the verify below turns that into a 409.
  app.delete<{ Params: { name: string }; Querystring: { serverId?: string } }>(
    '/:name',
    { preHandler: [app.requireAdmin] },
    async (req) => {
      const name = (req.params as { name: string }).name;
      if (!name.startsWith('nd-svc-') && !name.startsWith('nd-db-')) {
        throw badRequest('not a managed volume');
      }
      const serverId = Number((req.query as { serverId?: string }).serverId ?? 0) || null;
      if (serverId !== null) {
        const sink = (line: string) => req.log.info(line);
        // r470: agentOp THROWS on non-zero exits by contract, so both calls
        // below tolerate exits and read the code themselves. `volume rm` exit 1
        // on the node is docker's "volume is in use" refusal — the caller's
        // 409, not a panel 500. Transport failures (node offline, sealed reply
        // refused) still throw and surface as 5xx, which is what they are.
        const rm = await agentOp(app.db, serverId, 'docker.volumeRm', { name }, sink, { tolerateExit: true });
        if (rm.exitCode !== 0) {
          throw conflict(`Volume is in use on node #${serverId} — stop the service/database on that node before deleting the volume`);
        }
        // Existence probe: exit 1 means the volume is GONE, which is the goal.
        const verify = await agentOp(app.db, serverId, 'docker.volumeInspect', { name }, sink, { tolerateExit: true });
        if (verify.exitCode === 0) {
          throw conflict(`Volume could not be deleted on node #${serverId} — docker reported success but the volume is still there`);
        }
        void audit(app.db, req.user!.id, 'volume.delete', `${name} on node #${serverId}`);
        return { ok: true, node: serverId };
      }
      const owner = (await volumeOwners(app.db, [name])).get(name) ?? null;
      if (owner && (await containerRunning(owner.containerName))) {
        throw conflict(`Volume is in use by ${owner.kind} "${owner.name}" — stop it before deleting the volume`);
      }
      void audit(app.db, req.user!.id, 'volume.delete', name);
      await removeVolume(name, (line) => req.log.info(line));
      if (await volumeExists(name)) {
        throw conflict(`Volume could not be deleted — it is still mounted by a container docker did not name (docker volume rm failed silently)`);
      }
      return { ok: true };
    },
  );

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
