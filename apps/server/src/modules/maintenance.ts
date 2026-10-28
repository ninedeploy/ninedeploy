import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { domains } from '@ninedeploy/db';
import { ERROR_PAGE_STATUSES, errorPagesInput, maintenanceInput, type ErrorPageStatus } from '@ninedeploy/schemas';
import { ERROR_PAGE_PREFIX, MAINTENANCE_PREFIX, writeDynamicConfig } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { badRequest, parseId } from '../lib/errors.js';
import { getErrorPages, getMaintenance, maintenanceView, setErrorPages, setMaintenance } from '../lib/maintenance.js';
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

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f7f7f8;color:#1f2328}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}main{max-width:32rem;padding:1.5rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.75;white-space:pre-line}</style>
</head><body><main><h1>${escapeHtml(title)}</h1>${text ? `<p>${escapeHtml(text)}</p>` : ''}</main></body></html>`;
}

const DEFAULT_ERROR: Record<ErrorPageStatus, [string, string]> = {
  '502': ['Bad gateway', 'The app did not answer properly. Try again in a moment.'],
  '503': ['Service unavailable', 'The app is not available right now. Try again in a moment.'],
  '504': ['Gateway timeout', 'The app took too long to answer. Try again in a moment.'],
};

/** Whether `host` is one of the service's active domains (exact, or under a `*.` wildcard) and not the panel's own host. */
async function hostBelongsTo(db: Parameters<FastifyPluginAsync>[0]['db'], serviceId: number, host: string): Promise<boolean> {
  if (!host) return false;
  const panel = String((await getSettingString(db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? '').trim().toLowerCase();
  if (panel && host === panel) return false;
  const rows = await db.select({ hostname: domains.hostname }).from(domains).where(and(eq(domains.serviceId, serviceId), eq(domains.status, 'active')));
  return rows.some((d) => {
    const h = String(d.hostname ?? '').trim().toLowerCase();
    return h === host || (h.startsWith('*.') && host.endsWith(h.slice(1)) && host.split('.').length === h.split('.').length);
  });
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
    // Switched off a moment ago: the routes are on their way back to the app.
    const title = m?.title ?? 'Back in a moment';
    const message = m ? m.message : 'This page reloads shortly.';
    const retry = m?.retryAfterSeconds ?? 5;
    reply.code(503).header('retry-after', String(retry));
    const html = /text\/html/.test(String(req.headers.accept ?? ''));
    return html ? reply.type('text/html; charset=utf-8').send(page(title, message)) : reply.type('text/plain; charset=utf-8').send(`${title}. ${message}\n`);
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

  app.get('/:id/maintenance', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    return maintenanceView(await getMaintenance(app.db, svc.id));
  });

  app.put('/:id/maintenance', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { maintenance } = maintenanceInput.parse(req.body ?? {});
    if (maintenance) {
      if (svc.serverId != null) throw badRequest('Maintenance mode is for services on the panel host for now', 'maintenance_unsupported');
      // The page is served by the panel: Traefik must be able to reach it.
      const unreachable = await wakeUnreachableReason();
      if (unreachable) throw badRequest(`Cannot turn maintenance on: ${unreachable}`, 'maintenance_unreachable');
    }
    await setMaintenance(app.db, svc.id, maintenance);
    await rerender((m) => req.log.warn(m));
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
      if (svc.serverId != null) throw badRequest('Custom error pages are for services on the panel host for now', 'error_pages_unsupported');
      const unreachable = await wakeUnreachableReason();
      if (unreachable) throw badRequest(`Cannot use custom error pages: ${unreachable}`, 'error_pages_unreachable');
    }
    await setErrorPages(app.db, svc.id, pages);
    await rerender((m) => req.log.warn(m));
    void audit(app.db, req.user!.id, 'service.error_pages.set', `${svc.name} #${svc.id}`, {
      serviceId: svc.id,
      statuses: Object.keys(pages).filter((k) => (pages as Record<string, string | undefined>)[k]?.trim()),
    });
    return getErrorPages(app.db, svc.id);
  });
};

