import { eq } from 'drizzle-orm';
import { servers, services } from '@ninedeploy/db';
import { serverRoles } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { notFound, parseId } from '../lib/errors.js';

/**
 * Server roles: the build-server flag and its concurrency (multi-node,
 * design §6.2, §6.6).
 *
 * `PATCH /v1/servers/:id` (operator, like every /v1/servers route). Partial:
 * only the named keys change. Both default off / 1 on every existing row, so
 * no node builds for another service until an operator says so. Audited
 * `server.roles.update` with the previous values.
 *
 * Turning the role off does not touch the services that build there: their
 * next deploy fails with "no longer a build server" (it never silently builds
 * somewhere else); the response names them.
 */
export const serverRolesRoutes: FastifyPluginAsync = async (app) => {
  app.patch('/:id', { onRequest: [app.authenticate], preHandler: app.requireOperator }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = serverRoles.parse(req.body ?? {});
    const row = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
    if (!row) throw notFound('Server not found');
    const previous = { isBuildServer: row.isBuildServer, buildConcurrency: row.buildConcurrency };
    const next = {
      isBuildServer: input.isBuildServer ?? row.isBuildServer,
      buildConcurrency: input.buildConcurrency ?? row.buildConcurrency,
    };
    await app.db
      .update(servers)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(servers.id, id));
    void audit(app.db, req.user!.id, 'server.roles.update', row.name, { serverId: id, previous, next });
    const building = await app.db.query.services.findMany({ where: eq(services.buildServerId, id) });
    return {
      id,
      name: row.name,
      ...next,
      // The services that build on this node (design §6.2).
      buildServiceIds: building.filter((s) => s.buildOn === 'server').map((s) => s.id),
    };
  });
};
