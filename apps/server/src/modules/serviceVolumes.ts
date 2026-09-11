import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { deployments, serviceVolumeAttachments, type services } from '@ninedeploy/db';
import {
  createServiceVolumeAttachment,
  updateServiceVolumeAttachment,
} from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { createDockerVolume } from '../engine/database.js';
import { capture } from '../lib/exec.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import {
  assertDatabaseRole,
  assertServiceRole,
  loadDatabaseForUser,
  visibleServiceIdSet,
  type AuthedUser,
} from '../lib/resourceAccess.js';
import { badRequest, conflict, forbidden, notFound, parseId as num } from '../lib/errors.js';
import { containerRunning, listManagedVolumeNames, HELPER_IMAGE } from '../lib/inventory.js';
import type { DB } from '@ninedeploy/db';

/** Live on-disk size of a named Docker volume (bytes), via a throwaway alpine container. */
async function volumeSize(name: string): Promise<number> {
  try {
    const out = await capture('docker', ['run', '--rm', '-v', `${name}:/v`, HELPER_IMAGE, 'sh', '-c', 'du -sb /v']);
    return Number(out.trim().split(/\s+/)[0]!) || 0;
  } catch {
    return 0;
  }
}

interface InventoryEntry {
  id: number;
  serviceId: number;
  volumeName: string;
  containerPath: string;
  readOnly: boolean;
  sizeBytes: number;
  inUse: boolean;
  sharedWith: number;
  createdAt: string;
  updatedAt: string;
}

/** Derive the managed volume name from either an existing `volumeName`
 *  or a `create.label` (slugified + service-prefixed). Pure function
 *  exported for tests. */
export function resolveVolumeNameImpl(
  svc: { slug: string },
  input: { volumeName?: string; create?: { label: string } },
): string {
  if (input.volumeName) {
    if (!input.volumeName.startsWith('nd-svc-') && !input.volumeName.startsWith('nd-db-')) {
      throw badRequest('Only managed volumes (nd-svc-* or nd-db-*) can be attached');
    }
    return input.volumeName;
  }
  if (input.create?.label) {
    const label = input.create.label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!label) throw badRequest('Invalid label');
    return `nd-svc-${svc.slug}-${label}`;
  }
  throw badRequest('Either volumeName or create.label is required');
}

/**
 * Cross-tenant volume guard.
 *
 * Volume names are host-global: `nd-svc-<slug>-<label>` and `nd-db-<slug>-data`
 * identify data that belongs to some OTHER service or database as soon as the
 * caller can name it. `resolveVolumeNameImpl` only proves the name is shaped
 * like a managed volume — without an ownership decision, a member could mount
 * another tenant's volume (database volumes included) read-write into their
 * own container, or point config-repair at it and delete files from its root.
 *
 * Rule for non-operators:
 *  • every service that already has the volume attached must be visible to
 *    the caller — sharing within the tenant set they can see stays possible;
 *  • `nd-db-*` additionally requires `admin` on every database the name could
 *    belong to — a data volume is full data access, the same tier as
 *    credentials and backups in resourceAccess.ts. Prefix matching is
 *    deliberately conservative because slugs overlap (`team-a` /
 *    `team-a-2`): an ambiguous name is refused unless every candidate clears
 *    the bar;
 *  • a managed name with no visible owner (orphaned, or no matching rows) is
 *    operator-only — nobody below operator can prove whose data it is.
 */
async function assertVolumeOwnership(db: DB, user: AuthedUser, volumeName: string): Promise<void> {
  if (user.isOperator) return;

  const visible = await visibleServiceIdSet(db, user);
  const attached = await db
    .select({ serviceId: serviceVolumeAttachments.serviceId })
    .from(serviceVolumeAttachments)
    .where(eq(serviceVolumeAttachments.volumeName, volumeName));
  for (const row of attached) {
    if (visible !== null && !visible.has(row.serviceId)) {
      throw forbidden('This volume is attached to a service that is not visible to you');
    }
  }

  if (volumeName.startsWith('nd-db-')) {
    const rows = await db.query.databases.findMany();
    const candidates = rows.filter(
      (d) =>
        volumeName === `nd-db-${d.slug}-data` ||
        volumeName === `nd-db-${d.slug}` ||
        volumeName.startsWith(`nd-db-${d.slug}-`),
    );
    if (candidates.length === 0) {
      throw forbidden('No database visible to you owns this volume — ask an operator to attach it');
    }
    for (const d of candidates) {
      await loadDatabaseForUser(db, d.id, user);
      await assertDatabaseRole(db, d, user, 'admin');
    }
    return;
  }

  if (attached.length === 0) {
    throw forbidden('This volume has no active attachment visible to you — ask an operator to attach it');
  }
}

/** Per-service volume attachment management. Mounted under
 * /v1/services/:id/volumes so the service owner (or admin) can list, attach,
 * update and detach volumes scoped to ONE service.
 *
 * Persistence: every successful attach/detach also enqueues a background
 * deployment so the running container picks up the new mount. Docker
 * cannot hot-swap `-v` flags, so the container must be re-created — the
 * same `docker run` re-runs through the existing pipeline. */
export const serviceVolumesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // ── helpers ───────────────────────────────────────────────────────────
  const ensureSupportsVolumes = (svc: typeof services.$inferSelect): void => {
    if (svc.type !== 'docker' && svc.type !== 'compose') {
      throw badRequest(`Service type '${svc.type}' does not support volume attachments — use 'docker' or 'compose'`);
    }
  };

  // Auto-provision a new managed volume when the user submits
  // `create.label`. The label is slugified and prefixed to produce a
  // unique managed name; the resulting row is what gets persisted.
  const resolveVolumeName = resolveVolumeNameImpl;

  /** Queue a background deployment so the runtime picks up the new mount.
   * Returns the new deployment id; the worker claims and runs it. */
  const queueRedeploy = async (serviceId: number, message: string): Promise<number> => {
    const [dep] = await app.db
      .insert(deployments)
      .values({ serviceId, status: 'queued', trigger: 'user', message })
      .returning();
    return dep!.id;
  };

  // ── GET /:id/volumes — list a service's attachments ──────────────────
  app.get('/:id/volumes', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    ensureSupportsVolumes(svc);

    const rows = await app.db
      .select()
      .from(serviceVolumeAttachments)
      .where(eq(serviceVolumeAttachments.serviceId, svc.id))
      .orderBy(desc(serviceVolumeAttachments.id));

    // Cross-service sharing: how many OTHER services also attach this volume.
    // Scoped to visibleServiceIdSet so counts never include other tenants' services.
    const visibleSvs = await visibleServiceIdSet(app.db, req.user!);
    const allVolumeAtts = visibleSvs === null
      ? await app.db.select().from(serviceVolumeAttachments)
      : await app.db.select().from(serviceVolumeAttachments).where(inArray(serviceVolumeAttachments.serviceId, [...visibleSvs]));
    const sharingByVolume = new Map<string, number>();
    for (const a of allVolumeAtts) {
      sharingByVolume.set(a.volumeName, (sharingByVolume.get(a.volumeName) ?? 0) + 1);
    }

    const out: InventoryEntry[] = await Promise.all(
      rows.map(async (r) => {
        const size = await volumeSize(r.volumeName);
        const inUse = await containerRunning(svc.runtimeId);
        return {
          id: r.id,
          serviceId: r.serviceId,
          volumeName: r.volumeName,
          containerPath: r.containerPath,
          readOnly: r.readOnly,
          sizeBytes: size,
          inUse,
          sharedWith: (sharingByVolume.get(r.volumeName) ?? 1) - 1,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
    );
    return out;
  });

  // ── POST /:id/volumes — attach (or create+attach) ─────────────────────
  app.post('/:id/volumes', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    ensureSupportsVolumes(svc);
    const input = createServiceVolumeAttachment.parse(req.body);

    // Refuse to mount at the legacy primary path if that path is already
    // claimed by `service.volumeMount` (would silently shadow data).
    if (svc.volumeMount && input.containerPath === svc.volumeMount) {
      throw badRequest(`Path '${svc.volumeMount}' is already used by the service's primary volume mount — pick a different path`);
    }

    const volumeName = resolveVolumeName(svc, input);
    // Ownership decision BEFORE the docker existence probe: a member naming
    // another tenant's volume must get 403, not a 404 that confirms the
    // volume exists on the host.
    if (input.volumeName) {
      await assertVolumeOwnership(app.db, req.user!, volumeName);
    } else {
      // `create.label` builds `nd-svc-<slug>-<label>` by concatenation, so a
      // chosen slug + label can spell ANOTHER service's volume (`shop` +
      // `api-data` = `shop-api` + `data`), and `docker volume create` is
      // idempotent on an existing name — the "new" volume would be the
      // victim's data (r096). A name that already exists on the host gets the
      // same ownership decision as an explicit `volumeName`. If docker cannot
      // be asked, decide as if it exists (fail closed).
      const onHost = await listManagedVolumeNames().then(
        (names) => names.includes(volumeName),
        () => true,
      );
      if (onHost) await assertVolumeOwnership(app.db, req.user!, volumeName);
    }
    // For create-on-attach, the volume does not have to exist yet; we
    // provision it on the next deploy. For an existing-volume attach, the
    // volume MUST already exist on this host (a typo from the operator
    // should not silently create a fresh empty volume).
    if (input.volumeName) {
      const known = (await listManagedVolumeNames().catch(() => [] as string[])).includes(volumeName);
      if (!known) throw notFound(`Volume '${volumeName}' does not exist on this host`);
    }

    let row: typeof serviceVolumeAttachments.$inferSelect;
    try {
      const [inserted] = await app.db
        .insert(serviceVolumeAttachments)
        .values({
          serviceId: svc.id,
          volumeName,
          containerPath: input.containerPath,
          readOnly: input.readOnly ?? false,
        })
        .returning();
      row = inserted!;
    } catch (err) {
      // Unique-index violations: surface as 409 (path or volume already
      // attached) so the operator can correct the input rather than chase a
      // raw sqlite error.
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE.*container_path/i.test(msg) || /container_path/i.test(msg) && /UNIQUE/i.test(msg)) {
        throw conflict(`Path '${input.containerPath}' is already mounted on this service`);
      }
      if (/UNIQUE.*volume_name/i.test(msg) || /volume_name/i.test(msg) && /UNIQUE/i.test(msg)) {
        throw conflict(`Volume '${volumeName}' is already attached to this service`);
      }
      throw err;
    }
    void audit(app.db, req.user!.id, 'service.volume.attach', `${svc.name}:${volumeName}→${row.containerPath}`);

    // For create-on-attach, provision the named volume now so subsequent
    // /volumes inventory reads (and the user-facing file manager) see it.
    if (input.create?.label) {
      try {
        await createDockerVolume(volumeName, (line) => req.log.info(line));
      } catch (err) {
        // Provisioning failed — undo the row so we do not end up with a
        // phantom attachment the next deploy will fail on.
        await app.db.delete(serviceVolumeAttachments).where(eq(serviceVolumeAttachments.id, row.id));
        throw err;
      }
    }

    // Auto-redeploy. The queued row is picked up by the existing worker
    // (same path as a manual `POST /services/:id/deploys`).
    const deploymentId = await queueRedeploy(svc.id, `Volume attached: ${volumeName} → ${row.containerPath}`);

    return { attachment: row, deploymentId };
  });

  // ── POST /:id/volumes/config-repair — regenerate a first-boot config ──
  // Config-once images (WordPress et al.) write their settings file INTO a
  // persistent volume on the very first boot and never refresh it from env.
  // When managed-database values change later, the app keeps dialing the old
  // ones and a green deploy "mysteriously" breaks it. This endpoint deletes
  // that baked file from the volume and queues a redeploy, so the next boot
  // regenerates it from the CURRENT environment — no manual volume spelunking.
  const repairConfig = z
    .object({
      filePath: z.string().regex(/^[A-Za-z0-9._-]+$/, 'Single file name inside the volume root'),
      volumeName: z.string().regex(/^nd-(svc|db)-[a-z0-9_.-]+$/).optional(),
      attachmentId: z.number().int().positive().optional(),
    })
    .refine((v) => (v.volumeName != null) !== (v.attachmentId != null), {
      message: 'Provide exactly one of volumeName or attachmentId',
    });

  app.post('/:id/volumes/config-repair', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    ensureSupportsVolumes(svc);
    const input = repairConfig.parse(req.body ?? {});

    let volumeName: string;
    if (input.attachmentId != null) {
      const row = await app.db.query.serviceVolumeAttachments.findFirst({
        where: and(eq(serviceVolumeAttachments.id, input.attachmentId), eq(serviceVolumeAttachments.serviceId, svc.id)),
      });
      if (!row) throw notFound('Volume attachment not found');
      volumeName = row.volumeName;
    } else {
      volumeName = input.volumeName!;
    }

    // Same defense-in-depth as `volumeBackupDir`: the name is a host-side
    // docker argument. Charset is already restricted upstream; assert again
    // cheaply instead of trusting history.
    if (/[^a-zA-Z0-9_.-]/.test(volumeName)) throw badRequest('Invalid volume name');

    // The attachmentId path is scoped to this service, but the row may
    // predate the attach-time ownership check (or share the volume with a
    // service the caller cannot see) — resolve the name and apply the same
    // guard before deleting anything from the volume root.
    await assertVolumeOwnership(app.db, req.user!, volumeName);

    await capture('docker', [
      'run', '--rm', '-v', `${volumeName}:/data`, HELPER_IMAGE, 'sh', '-c',
      `rm -f -- '/data/${input.filePath}'`,
    ]);
    void audit(app.db, req.user!.id, 'service.volume.config_repair', `${svc.name}:${volumeName}/${input.filePath}`);

    const deploymentId = await queueRedeploy(
      svc.id,
      `Config repaired: ${volumeName}/${input.filePath} removed — regenerates from current env on boot`,
    );
    return { ok: true, deploymentId };
  });

  // ── PATCH /:id/volumes/:attId — change path / readonly ────────────────
  app.patch('/:id/volumes/:attId', async (req) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    ensureSupportsVolumes(svc);
    const attId = num((req.params as { attId: string }).attId);
    const input = updateServiceVolumeAttachment.parse(req.body);

    const existing = await app.db.query.serviceVolumeAttachments.findFirst({
      where: and(eq(serviceVolumeAttachments.id, attId), eq(serviceVolumeAttachments.serviceId, svc.id)),
    });
    if (!existing) throw notFound('Volume attachment not found');

    // Path changes must not collide with the primary volume or another attachment.
    if (input.containerPath && input.containerPath !== existing.containerPath) {
      if (svc.volumeMount && input.containerPath === svc.volumeMount) {
        throw badRequest(`Path '${svc.volumeMount}' is already used by the service's primary volume mount`);
      }
    }

    const update: { containerPath?: string; readOnly?: boolean } = {};
    if (input.containerPath !== undefined) update.containerPath = input.containerPath;
    if (input.readOnly !== undefined) update.readOnly = input.readOnly;
    const set = { ...update, updatedAt: new Date() };

    let updated: typeof serviceVolumeAttachments.$inferSelect | undefined;
    try {
      [updated] = await app.db
        .update(serviceVolumeAttachments)
        .set(set)
        .where(eq(serviceVolumeAttachments.id, attId))
        .returning();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE.*container_path/i.test(msg)) {
        throw conflict(`Path '${input.containerPath}' is already mounted on this service`);
      }
      throw err;
    }
    if (!updated) throw notFound('Volume attachment not found');
    void audit(app.db, req.user!.id, 'service.volume.update', `${svc.name}:${updated.volumeName}`);
    const deploymentId = await queueRedeploy(svc.id, `Volume attachment updated: ${updated.volumeName}`);
    return { attachment: updated, deploymentId };
  });

  // ── DELETE /:id/volumes/:attId — detach (volume survives) ─────────────
  app.delete('/:id/volumes/:attId', async (req, reply) => {
    const svc = await loadServiceForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    ensureSupportsVolumes(svc);
    const attId = num((req.params as { attId: string }).attId);

    const existing = await app.db.query.serviceVolumeAttachments.findFirst({
      where: and(eq(serviceVolumeAttachments.id, attId), eq(serviceVolumeAttachments.serviceId, svc.id)),
    });
    if (!existing) throw notFound('Volume attachment not found');

    await app.db.delete(serviceVolumeAttachments).where(eq(serviceVolumeAttachments.id, attId));
    void audit(app.db, req.user!.id, 'service.volume.detach', `${svc.name}:${existing.volumeName}`);

    // The queued redeploy recreates the container WITHOUT this mount — the
    // same mechanism attach/update use (Docker cannot hot-swap -v flags).
    // No stop-first requirement: blue-green keeps the old container serving
    // until the replacement is healthy, so detaching mid-run is safe; the DB
    // and the runtime only disagree for the seconds before the worker claims
    // the deployment.
    await queueRedeploy(svc.id, `Volume detached: ${existing.volumeName}`);

    // Detaching a volume from the LAST service leaves an orphan managed
    // volume on the host. Inventory (nd-svc-* prefix) still tracks it; the
    // operator can prune it from /volumes. We intentionally do NOT delete
    // the volume itself — that would lose data and is too easy to trigger
    // by accident.
    const stillReferenced = (await app.db
      .select()
      .from(serviceVolumeAttachments)
      .where(eq(serviceVolumeAttachments.volumeName, existing.volumeName))).length > 0;
    if (!stillReferenced) {
      req.log.info({ volume: existing.volumeName }, 'volume has no remaining attachments; now ownerless — prune from /volumes to remove');
    }

    reply.status(204);
  });
};

/** Exposed for tests so the volume-name derivation logic can be exercised
 *  without an HTTP round-trip. The production route is registered at
 *  /v1/services/:id/volumes (see api.ts). */
export const _internal = {
  resolveVolumeName: (svc: { slug: string }, input: { volumeName?: string; create?: { label: string } }): string =>
    resolveVolumeNameImpl(svc, input),
};
