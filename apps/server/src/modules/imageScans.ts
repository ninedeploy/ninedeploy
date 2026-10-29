import type { FastifyPluginAsync } from 'fastify';
import { imageScanPolicyPatch } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { HttpError, parseId } from '../lib/errors.js';
import {
  composeImageSetId,
  composeScannableOnPanel,
  composeStackImages,
  containerImageId,
  scanComposeStack,
  scanNodeServiceImage,
  scannableOnNode,
  getImageScanPolicy,
  getImageScanResult,
  scannableOnPanel,
  scanServiceImage,
  setImageScanPolicy,
  trivyImage,
} from '../lib/imageScan.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';
import { isSwarmService } from '../engine/swarmDeploy.js';

/**
 * G5.1 image vulnerability scanning.
 *  - `/v1/image-scanning` (operator): the policy, and which Trivy image runs.
 *  - `/v1/services/:id/image-scan`: the service's latest scan (viewer), and a
 *    scan of what runs now (admin), which runs in the background.
 */
export const imageScanPolicyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async () => ({ policy: await getImageScanPolicy(app.db), trivyImage: trivyImage() }));

  app.put('/', async (req) => {
    const patch = imageScanPolicyPatch.parse(req.body ?? {});
    const policy = await setImageScanPolicy(app.db, patch);
    void audit(app.db, req.user!.id, 'image_scan.policy', 'image-scanning', { ...policy });
    return { policy, trivyImage: trivyImage() };
  });
};

/** Services with a scan running now (a second request is refused, not queued). */
const scanning = new Set<number>();

export const serviceImageScanRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/image-scan', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    return { result: await getImageScanResult(app.db, id), scanning: scanning.has(id) };
  });

  app.post('/:id/image-scan', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    if (!(await getImageScanPolicy(app.db)).enabled) {
      throw new HttpError(409, 'image_scanning_off', 'Image scanning is off; an operator turns it on under Settings → Image scanning');
    }
    const compose = composeScannableOnPanel(svc);
    // G5.1: a docker service on a node is scanned by the node's agent.
    if (svc.serverId != null && scannableOnNode(svc, isSwarmService(svc))) {
      if (!svc.runtimeId) throw new HttpError(409, 'image_scan_not_running', 'The service has no running container to scan; deploy it first');
      if (scanning.has(id)) throw new HttpError(409, 'image_scan_running', 'A scan of this service is already running');
      scanning.add(id);
      try {
        const { assertNodeCapability } = await import('../lib/agentCapabilities.js');
        await assertNodeCapability(app.db, svc.serverId, { cap: 'image.scan', feature: 'scan images for vulnerabilities', sealedRequired: true });
      } catch (err) {
        scanning.delete(id);
        throw err;
      }
      void scanNodeServiceImage(app.db, { id, serverId: svc.serverId, runtimeId: svc.runtimeId }, 'manual')
        .then((r) => {
          if (r) void audit(app.db, req.user!.id, 'image_scan.run', svc.name, { serviceId: id, imageId: r.imageId, status: r.status, critical: r.counts.critical, high: r.counts.high });
        })
        .catch((err) => req.log.warn({ err, serviceId: id }, 'image scan failed'))
        .finally(() => scanning.delete(id));
      return reply.code(202).send({ started: true, imageId: null });
    }
    if (!compose && !scannableOnPanel(svc, isSwarmService(svc))) {
      throw new HttpError(409, 'image_scan_unsupported', 'Only docker services and compose stacks that run on the panel host (not on Swarm) are scanned for now');
    }
    if (!svc.runtimeId) throw new HttpError(409, 'image_scan_not_running', 'The service has no running container to scan; deploy it first');
    if (scanning.has(id)) throw new HttpError(409, 'image_scan_running', 'A scan of this service is already running');
    if (compose) {
      scanning.add(id);
      let images: Array<{ imageId: string; services: string[] }>;
      try {
        images = await composeStackImages(svc.slug);
      } catch (err) {
        scanning.delete(id);
        throw new HttpError(409, 'image_scan_not_running', `Could not list the stack's images: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!images.length) {
        scanning.delete(id);
        throw new HttpError(409, 'image_scan_not_running', 'The stack has no running container to scan; deploy it first');
      }
      void scanComposeStack(app.db, id, images, 'manual')
        .then((r) => {
          void audit(app.db, req.user!.id, 'image_scan.run', svc.name, { serviceId: id, imageId: r.imageId, status: r.status, critical: r.counts.critical, high: r.counts.high });
        })
        .catch((err) => req.log.warn({ err, serviceId: id }, 'image scan failed'))
        .finally(() => scanning.delete(id));
      return reply.code(202).send({ started: true, imageId: composeImageSetId(images) });
    }
    scanning.add(id);
    let imageId: string;
    try {
      imageId = await containerImageId(svc.runtimeId);
    } catch (err) {
      scanning.delete(id);
      throw new HttpError(409, 'image_scan_not_running', `Could not read the running image: ${err instanceof Error ? err.message : String(err)}`);
    }
    void scanServiceImage(app.db, id, imageId, 'manual')
      .then((r) => {
        void audit(app.db, req.user!.id, 'image_scan.run', svc.name, {
          serviceId: id,
          imageId,
          status: r.status,
          critical: r.counts.critical,
          high: r.counts.high,
        });
      })
      .catch((err) => req.log.warn({ err, serviceId: id }, 'image scan failed'))
      .finally(() => scanning.delete(id));
    return reply.code(202).send({ started: true, imageId });
  });
};
