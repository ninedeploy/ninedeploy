import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { serviceFiles, serviceVolumeAttachments } from '@ninedeploy/db';
import { MAX_SERVICE_FILES, type ServiceFile, type ServiceFileEntry, serviceFilePut, utf8Length } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest, conflict, notFound, parseId } from '../lib/errors.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { FILE_MOUNTS_PANEL_ONLY } from '../lib/serviceFiles.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';

/**
 * 0.16.3 file mounts, mounted under `/services`: list (viewer), read one with
 * its content (member: a config file can hold secrets, like an env value),
 * create or replace by path, delete. A change applies on the next deploy,
 * like an environment variable.
 */
export const serviceFileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const entry = (r: typeof serviceFiles.$inferSelect): ServiceFileEntry => ({
    id: r.id,
    path: r.containerPath,
    size: r.size,
    updatedAt: r.updatedAt.toISOString(),
  });

  app.get('/:id/files', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    const rows = await app.db.select().from(serviceFiles).where(eq(serviceFiles.serviceId, svc.id));
    return rows.sort((a, b) => a.containerPath.localeCompare(b.containerPath)).map(entry);
  });

  app.get('/:id/files/:fileId', async (req): Promise<ServiceFile> => {
    const params = req.params as { id: string; fileId: string };
    const svc = await loadServiceForUser(app.db, parseId(params.id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const row = await app.db.query.serviceFiles.findFirst({
      where: and(eq(serviceFiles.id, parseId(params.fileId)), eq(serviceFiles.serviceId, svc.id)),
    });
    if (!row) throw notFound('File not found');
    return { ...entry(row), content: decrypt(row.contentEncrypted) };
  });

  app.put('/:id/files', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const input = serviceFilePut.parse(req.body);
    // Stored where it would never be mounted is a silent no-op; say so instead.
    if (svc.type !== 'docker' || svc.serverId != null || svc.orchestrator === 'swarm') throw badRequest(FILE_MOUNTS_PANEL_ONLY, 'file_mounts_unsupported');
    // Docker refuses two mounts at one path; catch it here, not at deploy time.
    if (svc.volumeMount === input.path) throw conflict(`${input.path} is the service's data volume mount`);
    const attached = await app.db.query.serviceVolumeAttachments.findFirst({
      where: and(eq(serviceVolumeAttachments.serviceId, svc.id), eq(serviceVolumeAttachments.containerPath, input.path)),
    });
    if (attached) throw conflict(`${input.path} is where the volume ${attached.volumeName} is mounted`);

    const existing = await app.db.query.serviceFiles.findFirst({
      where: and(eq(serviceFiles.serviceId, svc.id), eq(serviceFiles.containerPath, input.path)),
    });
    const values = { contentEncrypted: encrypt(input.content), size: utf8Length(input.content) };
    let row: typeof serviceFiles.$inferSelect | undefined;
    if (existing) {
      [row] = await app.db.update(serviceFiles).set({ ...values, updatedAt: new Date() }).where(eq(serviceFiles.id, existing.id)).returning();
    } else {
      const all = await app.db.select({ id: serviceFiles.id }).from(serviceFiles).where(eq(serviceFiles.serviceId, svc.id));
      if (all.length >= MAX_SERVICE_FILES) throw conflict(`A service mounts at most ${MAX_SERVICE_FILES} files`);
      [row] = await app.db.insert(serviceFiles).values({ serviceId: svc.id, containerPath: input.path, ...values }).returning();
    }
    void audit(app.db, req.user!.id, existing ? 'service.file.update' : 'service.file.create', `${svc.name} ${input.path}`, { serviceId: svc.id });
    return entry(row!);
  });

  app.delete('/:id/files/:fileId', async (req) => {
    const params = req.params as { id: string; fileId: string };
    const svc = await loadServiceForUser(app.db, parseId(params.id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const gone = await app.db
      .delete(serviceFiles)
      .where(and(eq(serviceFiles.id, parseId(params.fileId)), eq(serviceFiles.serviceId, svc.id)))
      .returning({ path: serviceFiles.containerPath });
    if (!gone[0]) throw notFound('File not found');
    void audit(app.db, req.user!.id, 'service.file.delete', `${svc.name} ${gone[0].path}`, { serviceId: svc.id });
    return { ok: true };
  });
};
