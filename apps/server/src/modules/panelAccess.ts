import type { FastifyPluginAsync } from 'fastify';
import { panelAccessUpdate, type PanelAccessView } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/errors.js';
import { normalizeIp, panelAccessConfig, readPanelAccess, wouldAllow, writePanelAccess } from '../lib/panelAccess.js';
import { config } from '../config.js';

/**
 * O4: `/v1/settings/panel-access`, the panel's IP allow-list (operator only,
 * interactive sessions only). Enforcement is the `panel-access` plugin; the
 * rules are in `lib/panelAccess.ts`.
 */
export const panelAccessRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async (req): Promise<PanelAccessView> => {
    const current = await readPanelAccess(app.db);
    return { ...current, yourIp: normalizeIp(req.ip), overridden: config.panelAccessOverride };
  });

  app.put('/', { preHandler: [app.requireInteractive] }, async (req): Promise<PanelAccessView> => {
    const input = panelAccessUpdate.parse(req.body ?? {});
    const parsed = panelAccessConfig.safeParse(input);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid allow-list', 'invalid_allow_list');
    const next = { ...parsed.data, cidrs: [...new Set(parsed.data.cidrs)] };
    if (next.enabled && next.cidrs.length === 0) throw badRequest('Add at least one address or range before turning the allow-list on', 'empty_allow_list');
    const yourIp = normalizeIp(req.ip);
    if (!wouldAllow(next, yourIp)) {
      throw conflict(`This list does not include your address (${yourIp}), so saving it would sign you out of the panel. Add it, or a range that contains it.`);
    }
    await writePanelAccess(app.db, next);
    void audit(app.db, req.user!.id, 'settings.panel_access', next.enabled ? 'on' : 'off', {
      enabled: next.enabled,
      cidrs: next.cidrs,
      includeTokens: next.includeTokens,
    });
    return { ...next, yourIp, overridden: config.panelAccessOverride };
  });
};
