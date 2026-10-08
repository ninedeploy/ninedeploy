import fp from 'fastify-plugin';
import { deployingFeedback, outcomeFeedback } from '../lib/githubFeedback.js';

/**
 * Deploy feedback to GitHub (0.13): commit statuses and preview PR comments
 * for services whose GitHub link opted in (`lib/githubFeedback.ts`).
 *
 * Listens on the kernel bus, so it must be registered after the kernel
 * plugin: `service.deploying` comes straight from the pipeline, and
 * `deployment.status_changed` from the audit bridge (`deploy.success|failed|
 * cancelled`). Purely observational — the listeners never throw, and the bus
 * does not await them, so a slow or failing GitHub never holds up a deploy.
 */
export default fp(
  async (fastify) => {
    const events = fastify.kernel?.events;
    if (!events || !fastify.db) return;
    const log = fastify.log.child({ module: 'github-feedback' });
    const off = [
      events.on('service.deploying', (p) => deployingFeedback(fastify.db, log, p.serviceId, p.deployId)),
      events.on('deployment.status_changed', (p) => outcomeFeedback(fastify.db, log, p.deploymentId, p.status)),
    ];
    fastify.addHook('onClose', async () => {
      for (const unsubscribe of off) unsubscribe();
    });
  },
  { name: 'ninedeploy-github-feedback' },
);
