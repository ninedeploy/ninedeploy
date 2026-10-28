import type { FastifyPluginAsync } from 'fastify';
import { pendingApplyInput, pendingStagingInput } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { HttpError, parseId } from '../lib/errors.js';
import { clearPending, pendingChanges, pendingPatch, setStaging, stageChanges } from '../lib/pendingChanges.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';

/**
 * G5.2 pending changes tray: `/v1/services/:id/pending`.
 *  - `GET` (viewer): the staged changes as a diff, and whether staging is on.
 *  - `PUT` (member): stage an edit (a PATCH body); `PUT …/staging` switches staging.
 *  - `DELETE` (member): discard the staged changes.
 *  - `POST …/apply` (member): apply them through `PATCH /v1/services/:id` with
 *    the caller's credentials, then optionally queue a deploy.
 */

/** The headers that carry the caller's credentials (a test seam: the test app authenticates by its own headers). */
export const pendingForwardHeaders = ['authorization', 'cookie'];

/** The caller's own credentials, for the requests `apply` makes on its behalf. */
function forwardedAuth(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json' };
  for (const h of pendingForwardHeaders) {
    const v = headers[h];
    if (typeof v === 'string') out[h] = v;
  }
  return out;
}

export const pendingChangeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/pending', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    return pendingChanges(app.db, await loadServiceForUser(app.db, id, req.user!));
  });

  app.put('/:id/pending', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const view = await stageChanges(app.db, svc, req.body, req.user!.id);
    void audit(app.db, req.user!.id, 'service.changes.stage', svc.name, { serviceId: id, fields: view.changes.map((c) => c.field) });
    return view;
  });

  app.put('/:id/pending/staging', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { staging } = pendingStagingInput.parse(req.body ?? {});
    const view = await setStaging(app.db, svc, staging);
    void audit(app.db, req.user!.id, 'service.changes.staging', svc.name, { serviceId: id, staging });
    return view;
  });

  app.delete('/:id/pending', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await clearPending(app.db, id);
    void audit(app.db, req.user!.id, 'service.changes.discard', svc.name, { serviceId: id });
    return pendingChanges(app.db, svc);
  });

  app.post('/:id/pending/apply', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { deploy, includeOthers } = pendingApplyInput.parse(req.body ?? {});
    const before = await pendingChanges(app.db, svc);
    const patch = await pendingPatch(app.db, id);
    if (!patch || before.changes.length === 0) throw new HttpError(409, 'nothing_pending', 'There are no pending changes to apply');
    // Security review: the PATCH runs with the caller's authority. Changes
    // someone else staged (or of unknown origin) are applied only on purpose.
    const others = before.changes.filter((c) => c.stagedByUserId !== req.user!.id);
    if (others.length > 0 && !includeOthers) {
      throw new HttpError(
        409,
        'others_changes',
        `${others.length} of the pending changes were staged by someone else (${[...new Set(others.map((c) => c.stagedBy ?? 'unknown'))].join(', ')}); ` +
          'review them and apply with includeOthers, or discard them',
      );
    }
    const headers = forwardedAuth(req.headers);
    const res = await app.inject({ method: 'PATCH', url: `/v1/services/${id}`, headers, payload: patch });
    if (res.statusCode >= 400) {
      // The tray is kept: the caller fixes or discards the refused change.
      const body = res.json() as { error?: { code?: string; message?: string } };
      throw new HttpError(res.statusCode, body.error?.code ?? 'apply_refused', body.error?.message ?? 'The changes were refused');
    }
    await clearPending(app.db, id);
    const applied = before.changes.map((c) => c.field);
    void audit(app.db, req.user!.id, 'service.changes.apply', svc.name, {
      serviceId: id,
      fields: applied,
      deploy,
      stagedBy: Object.fromEntries(before.changes.map((c) => [c.field, c.stagedByUserId])),
    });
    let deploymentId: number | null = null;
    if (deploy) {
      const dep = await app.inject({ method: 'POST', url: `/v1/services/${id}/deploys`, headers, payload: {} });
      if (dep.statusCode >= 400) {
        const body = dep.json() as { error?: { code?: string; message?: string } };
        throw new HttpError(dep.statusCode, body.error?.code ?? 'deploy_refused', `The changes were applied, but the deploy was refused: ${body.error?.message ?? dep.statusCode}`);
      }
      deploymentId = (dep.json() as { deploymentId?: number }).deploymentId ?? null;
    }
    return { applied, deploymentId };
  });
};
