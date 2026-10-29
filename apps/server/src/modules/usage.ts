import type { FastifyPluginAsync } from 'fastify';
import { usageCostsInput, usageQuery } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { buildUsageReport, readUsageCosts, saveUsageCosts } from '../lib/usageReport.js';

/**
 * Usage and cost (ROADMAP item 9), operator only: `/v1/usage`. The report
 * covers every workspace, so it is not scoped to a member's view.
 */
export const usageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async (req) => {
    const { days } = usageQuery.parse(req.query ?? {});
    return buildUsageReport(app.db, days);
  });

  app.get('/costs', async () => readUsageCosts(app.db));

  app.put('/costs', async (req) => {
    const saved = await saveUsageCosts(app.db, usageCostsInput.parse(req.body ?? {}));
    void audit(app.db, req.user!.id, 'usage.costs_update', 'usage', { currency: saved.currency, servers: saved.servers });
    return saved;
  });
};
