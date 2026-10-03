import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { autoPruneConfigUpdate } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { unprocessable } from '../lib/errors.js';
import { executeAutoPrune, getAutoPruneStatus, saveAutoPruneConfig } from '../engine/autoPrune.js';

export const housekeepingRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  // Get disk usage & auto-prune config status
  app.get('/prune/config', async () => {
    return getAutoPruneStatus(app.db);
  });

  // Update auto-prune configuration
  app.patch('/prune/config', async (req) => {
    const parsed = autoPruneConfigUpdate.safeParse(req.body);
    if (!parsed.success) {
      throw unprocessable(parsed.error.issues[0]!.message);
    }

    const updated = await saveAutoPruneConfig(app.db, parsed.data);
    void audit(app.db, req.user!.id, 'housekeeping.config_updated', `Updated auto-prune settings (threshold: ${updated.thresholdPercent}%)`);
    return updated;
  });

  // Manually trigger prune run
  app.post('/prune', async (req) => {
    const result = await executeAutoPrune(app.db);
    void audit(app.db, req.user!.id, 'housekeeping.prune_executed', `Executed disk auto-prune (freed: ${result.freedBytes} bytes)`);
    return result;
  });
};
