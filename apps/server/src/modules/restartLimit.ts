import type { FastifyPluginAsync } from 'fastify';
import { restartLimitInput } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { parseId } from '../lib/errors.js';
import { assertServiceCapability } from '../lib/serviceCapabilities.js';
import { assertNodeLifecycleAvailable } from '../lib/nodeLifecycleRuntime.js';
import { getRestartLimit, restartLimitView, setRestartLimit } from '../lib/restartLimit.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';

/**
 * G1.3 restart-loop limit: `GET`/`PUT /v1/services/:id/restart-limit`.
 * Reading is for viewers; setting it is a deploy setting (`member`). On a
 * node (P2), turning it on asks the node's agent, live, for what Stop needs.
 */
export const restartLimitRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/restart-limit', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    return restartLimitView(await getRestartLimit(app.db, id), id);
  });

  app.put('/:id/restart-limit', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { limit } = restartLimitInput.parse(req.body ?? {});
    // Turning it off is always allowed; on, it must be a service the sweep samples.
    if (limit) {
      await assertServiceCapability(app.db, svc, 'restartLimit');
      // P2: on a node, the limiter stops it as the Stop button does, so the node must take that Stop.
      if (svc.serverId != null) await assertNodeLifecycleAvailable(app.db, svc);
    }
    await setRestartLimit(app.db, id, limit);
    void audit(app.db, req.user!.id, 'service.restart_limit.set', `${svc.name} #${svc.id}`, { serviceId: id, limit });
    return restartLimitView(await getRestartLimit(app.db, id), id);
  });
};
