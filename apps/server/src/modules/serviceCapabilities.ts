import type { FastifyPluginAsync } from 'fastify';
import type { ServiceCapabilitiesView } from '@ninedeploy/schemas';
import { parseId } from '../lib/errors.js';
import { loadServiceForUser } from '../lib/resourceAccess.js';
import { runtimeOf, serviceCapabilities } from '../lib/serviceCapabilities.js';

/**
 * C1: `GET /v1/services/:id/capabilities`, what this service can use and why
 * not (viewer). The panel disables a control before save from it; the routes
 * refuse with the same evaluation.
 */
export const serviceCapabilityRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/capabilities', async (req): Promise<ServiceCapabilitiesView> => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    return { serviceId: svc.id, runtime: runtimeOf(svc), capabilities: await serviceCapabilities(app.db, svc) };
  });
};
