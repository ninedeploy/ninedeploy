import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { deployments, type Service } from '@ninedeploy/db';
import { serviceBuildOn } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { enqueueUserDeploy } from '../lib/deployQueue.js';
import { badRequest, conflict, parseId } from '../lib/errors.js';
import { assertMayDeployStoredService } from '../lib/hostPrivilege.js';
import { assertRemoteServiceSupported } from '../lib/remoteDeploy.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import {
  isUploadSourced,
  listSourceUploads,
  SOURCE_UPLOAD_MAX_BYTES,
  SourceArchiveError,
  storeSourceUpload,
  UPLOAD_SOURCE_PANEL_BUILD,
} from '../lib/sourceUpload.js';

/** Body types an archive may be sent as; the format is decided by its magic bytes. */
const ARCHIVE_TYPES = ['application/zip', 'application/gzip', 'application/x-gzip', 'application/x-zip-compressed', 'application/octet-stream'];

/**
 * 0.16.1 deploy from an uploaded archive. Mounted under `/services`.
 *
 *  - `GET  /:id/source` — the kept uploads (viewer).
 *  - `POST /:id/source` — a raw `.zip` / `.tar.gz` body (member). Validated,
 *    kept, and deployed unless `?deploy=false`.
 *
 * Only a docker service with no repository, image or inline stack takes
 * uploads (lib/sourceUpload.ts `isUploadSourced`); on a node (0.16.7) the
 * panel builds it and ships the image. Authentication, the member check and those service rules all run at
 * `onRequest`, before a byte of the (up to 100 MiB) body is read; the route's
 * own `bodyLimit` lifts the app-wide 1 MiB for this route alone (past it,
 * Fastify's 413 goes through the global error envelope).
 */
export const sourceUploadRoutes: FastifyPluginAsync = async (app) => {
  for (const type of ARCHIVE_TYPES) {
    if (app.hasContentTypeParser(type)) app.removeContentTypeParser(type);
  }
  app.addContentTypeParser(ARCHIVE_TYPES, { parseAs: 'buffer', bodyLimit: SOURCE_UPLOAD_MAX_BYTES }, (_req, body, done) => done(null, body));

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) =>
    (app as FastifyInstance & { authenticate: (r: FastifyRequest, p: FastifyReply) => Promise<void> }).authenticate(req, reply);

  app.get('/:id/source', { onRequest: [authenticate] }, async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    return { uploadSourced: isUploadSourced(svc), maxBytes: SOURCE_UPLOAD_MAX_BYTES, uploads: listSourceUploads(svc.id) };
  });

  // Resolved before the body is read, kept for the handler.
  const target = new WeakMap<FastifyRequest, Service>();
  const guard = async (req: FastifyRequest) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await assertMayDeployStoredService(app.db, req.user!, svc);
    if (!isUploadSourced(svc)) {
      throw conflict(
        svc.type !== 'docker'
          ? `Uploaded source applies to docker services; this one is a ${svc.type} service.`
          : 'This service deploys from a repository, an image or an inline stack. Uploads are for a service created without one (New → Upload source).',
      );
    }
    // 0.16.7: on a node the panel builds the archive and ships the image
    // (serviceBuildOn); a placement chosen elsewhere cannot fetch it, and a
    // deploy is checked against the node (it must receive an image) before a
    // byte of the body is read.
    if (svc.serverId != null) {
      if (serviceBuildOn(svc) !== 'panel') throw badRequest(UPLOAD_SOURCE_PANEL_BUILD, 'remote_deploy_unsupported');
      if ((req.query as { deploy?: string }).deploy !== 'false') await assertRemoteServiceSupported(app.db, svc);
    }
    target.set(req, svc);
  };

  app.post(
    '/:id/source',
    { onRequest: [authenticate, guard], bodyLimit: SOURCE_UPLOAD_MAX_BYTES },
    async (req, reply) => {
      const svc = target.get(req)!;
      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        throw badRequest('Send the archive as the raw request body (Content-Type: application/zip or application/gzip).');
      }
      let stored: Awaited<ReturnType<typeof storeSourceUpload>>;
      try {
        stored = await storeSourceUpload(svc.id, body);
      } catch (err) {
        if (err instanceof SourceArchiveError) throw badRequest(err.message, 'invalid_archive');
        throw err;
      }
      void audit(app.db, req.user!.id, 'service.source_upload', `${svc.name} @ ${stored.sha.slice(0, 7)}`, {
        serviceId: svc.id,
        bytes: stored.bytes,
        format: stored.format,
      });
      const deploy = (req.query as { deploy?: string }).deploy !== 'false';
      let deploymentId: number | null = null;
      if (deploy) {
        // An in-flight build keeps running; this upload deploys after it.
        const inflight = await app.db.query.deployments.findFirst({
          where: and(eq(deployments.serviceId, svc.id), inArray(deployments.status, ['building', 'deploying'])),
          orderBy: desc(deployments.id),
        });
        deploymentId = await enqueueUserDeploy(app.db, req.user!, svc, {
          message: `Uploaded source (${(stored.bytes / 1024 / 1024).toFixed(1)} MiB ${stored.format})`,
          commitSha: stored.sha,
        });
        void audit(app.db, req.user!.id, 'deploy.trigger', `${svc.name} #${deploymentId}`, { serviceId: svc.id, deploymentId, queuedBehind: inflight?.id ?? null });
      }
      reply.code(201);
      return { ...stored, deploymentId };
    },
  );
};
