import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { domains } from '@ninedeploy/db';
import { composeRouteInput, type ComposeRouteView } from '@ninedeploy/schemas';
import { writeDynamicConfig } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, parseId } from '../lib/errors.js';
import { getComposeRoute, inlineComposeServices, setComposeRoute } from '../lib/composeRoutes.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';

/**
 * G2.1 a domain per compose service: `GET/PUT /v1/domains/:id/compose-route`.
 * Reading follows the service; changing it is a routing setting (`member`)
 * and re-renders the proxy config.
 */
export const domainComposeRouteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const load = async (req: FastifyRequest) => {
    const d = await app.db.query.domains.findFirst({ where: eq(domains.id, parseId((req.params as { id: string }).id)) });
    if (!d) throw notFound('Domain not found');
    const svc = await loadServiceForUser(app.db, d.serviceId, req.user!);
    return { d, svc };
  };
  const view = async (domainId: number, composeContent: string | null): Promise<ComposeRouteView> => ({
    domainId,
    route: await getComposeRoute(app.db, domainId),
    services: inlineComposeServices(composeContent),
  });

  app.get('/:id/compose-route', async (req): Promise<ComposeRouteView> => {
    const { d, svc } = await load(req);
    return view(d.id, svc.composeContent ?? null);
  });

  app.put('/:id/compose-route', async (req): Promise<ComposeRouteView> => {
    const { d, svc } = await load(req);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (svc.type !== 'compose') throw badRequest('Only a compose stack has more than one service to route to', 'compose_route_unsupported');
    const { route } = composeRouteInput.parse(req.body ?? {});
    if (route) {
      // An inline stack says what it declares; a repository compose file is read at deploy time.
      const declared = inlineComposeServices(svc.composeContent);
      if (declared && !declared.includes(route.service)) {
        throw badRequest(`The compose file has no service "${route.service}" (it has: ${declared.join(', ')})`, 'compose_route_unknown_service');
      }
    }
    await setComposeRoute(app.db, d.id, route);
    await writeDynamicConfig(app.db).catch((err: unknown) => req.log.warn({ err }, 'proxy re-render failed'));
    void audit(app.db, req.user!.id, 'domain.compose_route.set', `${d.hostname} → ${route ? `${route.service}:${route.port}` : 'main service'} (${svc.name})`, {
      serviceId: svc.id,
      domainId: d.id,
    });
    return view(d.id, svc.composeContent ?? null);
  });
};
