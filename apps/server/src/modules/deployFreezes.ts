import type { FastifyPluginAsync } from 'fastify';
import { deployFreezeCreate } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { createDeployFreeze, listDeployFreezes, liftDeployFreeze } from '../lib/deployFreeze.js';

/**
 * G5.5 deploy freezes, operator only: `/v1/deploy-freezes`. A freeze holds
 * every deploy it covers in the queue (see `lib/deployFreeze.ts`); lifting it
 * lets them start.
 */
export const deployFreezeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async () => listDeployFreezes(app.db));

  app.post('/', async (req) => {
    const input = deployFreezeCreate.parse(req.body ?? {});
    const freeze = await createDeployFreeze(app.db, input, req.user!.id);
    void audit(app.db, req.user!.id, 'deploy.freeze', freeze.targetName ?? freeze.scope, {
      freezeId: freeze.id,
      scope: freeze.scope,
      targetId: freeze.targetId,
      reason: freeze.reason,
      until: freeze.until,
    });
    return freeze;
  });

  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const freeze = await liftDeployFreeze(app.db, id);
    void audit(app.db, req.user!.id, 'deploy.unfreeze', freeze.targetName ?? freeze.scope, {
      freezeId: freeze.id,
      scope: freeze.scope,
      targetId: freeze.targetId,
    });
    return freeze;
  });
};
