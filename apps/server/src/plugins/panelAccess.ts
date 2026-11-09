import fp from 'fastify-plugin';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { panelAccessVerdict } from '../lib/panelAccess.js';

/**
 * O4: enforces the panel IP allow-list on every request, WebSocket upgrades
 * included (they skip `authenticate`). Registered at the root so the hook sees
 * all routes. What is and is not covered is documented in `lib/panelAccess.ts`.
 */
export default fp(
  async (fastify) => {
    fastify.addHook('onRequest', async (req) => {
      const verdict = await panelAccessVerdict(
        fastify.db,
        { ip: req.ip, method: req.method, routeUrl: req.routeOptions.url, headers: req.headers },
        { disabled: config.panelAccessOverride },
      );
      if (verdict === 'deny') {
        throw new HttpError(
          403,
          'panel_access_denied',
          'This panel only accepts sign-ins from its listed addresses, and yours is not one of them. Ask an operator to add it.',
        );
      }
    });
  },
  { name: 'ninedeploy-panel-access', dependencies: ['ninedeploy-db'] },
);
