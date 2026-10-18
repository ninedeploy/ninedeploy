import type { FastifyPluginAsync } from 'fastify';
import { parseId } from '../lib/errors.js';
import { listHostAddresses } from '../lib/hostAddresses.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';

/**
 * 0.16.1 `GET /v1/services/:id/host-addresses`: the IPs a port mapping of this
 * service can be bound to, for the Network tab's Host IP field. A member's,
 * like editing the mappings. `detected: false` = the host could not be asked
 * (the field then takes any address, and Docker checks it at deploy time).
 * A node service gets none: mappings are published on the panel host only.
 */
export const hostAddressRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/host-addresses', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (svc.serverId != null) return { detected: false, addresses: [] };
    const addresses = await listHostAddresses();
    return { detected: addresses !== null, addresses: addresses ?? [] };
  });
};
