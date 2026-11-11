import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { domains } from '@ninedeploy/db';
import { ERROR_PAGE_STATUSES, errorPagesInput, maintenanceInput, type ErrorPageStatus } from '@ninedeploy/schemas';
import { ERROR_PAGE_PREFIX, MAINTENANCE_PREFIX, writeDynamicConfig } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { badRequest, HttpError, parseId } from '../lib/errors.js';
import { assertNodeCapability } from '../lib/agentCapabilities.js';
import { clearNodePagesOutcome, nodePagesFailure } from '../lib/nodePagesSync.js';
import { assertServiceCapability } from '../lib/serviceCapabilities.js';
import { getErrorPages, getMaintenance, maintenanceView, restoreMaintenance, setErrorPages, setMaintenance } from '../lib/maintenance.js';
import { DEFAULT_ERROR, hostMatches, maintenanceAnswer, page } from '../lib/maintenancePages.js';
import { wakeUnreachableReason } from '../lib/panelUpstream.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';
import { getSettingString } from '../lib/settings.js';

/**
 * G2.2 maintenance mode and custom error pages.
 *
 * Management, under `/v1/services`: reading is for viewers, changing is a
 * deploy-level setting (`member`). A change re-renders the proxy config.
 *
 * The pages, outside `/v1` like the wake endpoint: Traefik sends a service in
 * maintenance to `/_nd/maintenance/<id>/<original path>` (addPrefix), and
 * fetches a custom error page from `/_nd/errors/<id>/<status>` (the `errors`
 * middleware), both with the visitor's own Host header. A page is served only
 * when that Host is one of the service's active domains and not the panel's
 * own, so a custom page's HTML never runs on another origin.
 */

/** Whether `host` is one of the service's active domains (exact, or under a `*.` wildcard) and not the panel's own host. */
async function hostBelongsTo(db: Parameters<FastifyPluginAsync>[0]['db'], serviceId: number, host: string): Promise<boolean> {
  if (!host) return false;
  const panel = String((await getSettingString(db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? '').trim().toLowerCase();
  if (panel && host === panel) return false;
  const rows = await db.select({ hostname: domains.hostname }).from(domains).where(and(eq(domains.serviceId, serviceId), eq(domains.status, 'active')));
  return rows.some((d) => hostMatches(String(d.hostname ?? '').trim().toLowerCase(), host));
}

const hostOf = (req: FastifyRequest) => String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();

/** The pages Traefik reaches. Registered at the root of the app, next to the wake endpoint. */
export const maintenancePageRoutes: FastifyPluginAsync = async (app) => {
  // Any body: it is never read, and an unparsable one must not turn into a 400.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, _body, done) => done(null, undefined));
  const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
  const notFound = (reply: FastifyReply) => reply.code(404).type('text/plain; charset=utf-8').send('Not found\n');

  const maintenance = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const id = Number((req.params as { serviceId: string }).serviceId);
    if (!Number.isSafeInteger(id) || id < 1 || !(await hostBelongsTo(app.db, id, hostOf(req)))) return notFound(reply);
    const m = await getMaintenance(app.db, id);
    const answer = maintenanceAnswer(m);
    reply.code(503).header('retry-after', String(m?.retryAfterSeconds ?? 5));
    const html = /text\/html/.test(String(req.headers.accept ?? ''));
    return html ? reply.type('text/html; charset=utf-8').send(answer.html) : reply.type('text/plain; charset=utf-8').send(answer.text);
  };
  app.route({ method: [...methods], url: `${MAINTENANCE_PREFIX}/:serviceId`, handler: maintenance });
  app.route({ method: [...methods], url: `${MAINTENANCE_PREFIX}/:serviceId/*`, handler: maintenance });

  app.route({
    method: [...methods],
    url: `${ERROR_PAGE_PREFIX}/:serviceId/:status`,
    handler: async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const { serviceId, status } = req.params as { serviceId: string; status: string };
      const id = Number(serviceId);
      const code = (ERROR_PAGE_STATUSES as readonly string[]).includes(status) ? (status as ErrorPageStatus) : null;
      if (!code || !Number.isSafeInteger(id) || id < 1 || !(await hostBelongsTo(app.db, id, hostOf(req)))) return notFound(reply);
      const custom = (await getErrorPages(app.db, id)).pages[code];
      reply.code(Number(code)).type('text/html; charset=utf-8');
      return reply.send(custom ?? page(...DEFAULT_ERROR[code]));
    },
  });
};

/** Management, mounted under `/services`. */
export const serviceMaintenanceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const rerender = (log: (msg: string) => void) =>
    writeDynamicConfig(app.db).catch((err: unknown) => log(`proxy re-render failed: ${err instanceof Error ? err.message : String(err)}`));

  /**
   * Who serves the pages must be able to: on the panel host, Traefik must reach
   * the panel; on a node (P2), the node's agent must serve them itself.
   */
  const assertPagesReachable = async (svc: { serverId: number | null }, what: string, code: string) => {
    if (svc.serverId != null) {
      await assertNodeCapability(app.db, svc.serverId, { cap: 'proxy.pages', feature: 'serve maintenance and error pages', sealedRequired: true });
      return;
    }
    const unreachable = await wakeUnreachableReason();
    if (unreachable) throw badRequest(`${what}: ${unreachable}`, code);
  };
  /**
   * Save, then re-render. P2: for a node service being switched on, the save
   * counts only when THIS re-render's node sync wrote the service's pages and
   * the page server answered. Anything else (the page server failed, the
   * node was unreachable, the sync stopped before its pages step) restores the
   * previous value and re-renders again: nothing re-syncs a node on its own,
   * so a kept setting would claim a maintenance mode no visitor ever sees.
   */
  const saveAndApply = async (
    svc: { id: number; serverId: number | null },
    enabling: boolean,
    what: string,
    save: () => Promise<void>,
    restore: () => Promise<void>,
    log: (m: string) => void,
  ) => {
    if (svc.serverId == null || !enabling) {
      await save();
      await rerender(log);
      return;
    }
    clearNodePagesOutcome(svc.serverId);
    await save();
    await rerender(log);
    const failure = await nodePagesFailure(app.db, svc.serverId, svc.id);
    if (failure === null) return;
    await restore();
    await rerender(log);
    throw new HttpError(502, 'node_pages_unapplied', `${what} was not changed: node #${svc.serverId} could not serve it (${failure}). Its domains keep answering as before.`);
  };

  app.get('/:id/maintenance', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    return maintenanceView(await getMaintenance(app.db, svc.id));
  });

  app.put('/:id/maintenance', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { maintenance } = maintenanceInput.parse(req.body ?? {});
    if (maintenance) {
      // C1: not for fan-out; the proxies of its other hosts would keep routing to the app.
      await assertServiceCapability(app.db, svc, 'maintenance');
      await assertPagesReachable(svc, 'Cannot turn maintenance on', 'maintenance_unreachable');
    }
    const previous = await getMaintenance(app.db, svc.id);
    await saveAndApply(svc, !!maintenance, 'Maintenance mode', () => setMaintenance(app.db, svc.id, maintenance),
      () => restoreMaintenance(app.db, svc.id, previous), (m) => req.log.warn(m));
    void audit(app.db, req.user!.id, maintenance ? 'service.maintenance.on' : 'service.maintenance.off', `${svc.name} #${svc.id}`, {
      serviceId: svc.id,
      ...(maintenance && { bypass: maintenance.bypass.length }),
    });
    return maintenanceView(await getMaintenance(app.db, svc.id));
  });

  app.get('/:id/error-pages', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    return getErrorPages(app.db, svc.id);
  });

  app.put('/:id/error-pages', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { pages } = errorPagesInput.parse(req.body ?? {});
    const any = Object.values(pages).some((html) => typeof html === 'string' && html.trim() !== '');
    if (any) {
      await assertServiceCapability(app.db, svc, 'errorPages');
      await assertPagesReachable(svc, 'Cannot use custom error pages', 'error_pages_unreachable');
    }
    const previous = (await getErrorPages(app.db, svc.id)).pages;
    await saveAndApply(svc, any, 'The custom error pages', () => setErrorPages(app.db, svc.id, pages),
      () => setErrorPages(app.db, svc.id, previous), (m) => req.log.warn(m));
    void audit(app.db, req.user!.id, 'service.error_pages.set', `${svc.name} #${svc.id}`, {
      serviceId: svc.id,
      statuses: Object.keys(pages).filter((k) => (pages as Record<string, string | undefined>)[k]?.trim()),
    });
    return getErrorPages(app.db, svc.id);
  });
};

