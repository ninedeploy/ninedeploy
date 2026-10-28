import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { buildConfigs, type DB, type Service } from '@ninedeploy/db';
import { pendingApplyInput, pendingStagingInput } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { HttpError, parseId } from '../lib/errors.js';
import {
  clearApplied,
  clearPending,
  pendingChanges,
  rawChanges,
  readPending,
  setStaging,
  stageChanges,
  type VisibleView,
} from '../lib/pendingChanges.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';
import { serialize, serializeBuild } from './services.js';

/**
 * G5.2 pending changes tray: `/v1/services/:id/pending`.
 *  - `GET` (viewer): the staged changes as a diff, and whether staging is on.
 *  - `PUT` (member): stage an edit (a PATCH body); `PUT …/staging` switches staging.
 *  - `DELETE` (member): discard the staged changes.
 *  - `POST …/apply` (member): apply the reviewed `version` of the tray
 *    through `PATCH /v1/services/:id` with the caller's credentials, then
 *    optionally queue a deploy.
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

/** What `GET /v1/services/:id` shows this caller (security review: the tray shows no more). */
async function visibleView(db: DB, svc: Service, isOperator: boolean): Promise<VisibleView> {
  const fields: Record<string, unknown> = { ...serialize(svc) };
  // The stack's YAML is operator-only on GET (it can carry literal secrets).
  if (isOperator) fields['composeContent'] = svc.composeContent ?? null;
  else delete fields['composeContent'];
  const build = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, svc.id) });
  return { fields, build: build ? { ...serializeBuild(build) } : {} };
}

export const pendingChangeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/pending', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    return pendingChanges(app.db, svc, await visibleView(app.db, svc, req.user!.isOperator));
  });

  app.put('/:id/pending', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const view = await stageChanges(app.db, svc, req.body, req.user!.id, await visibleView(app.db, svc, req.user!.isOperator));
    void audit(app.db, req.user!.id, 'service.changes.stage', svc.name, { serviceId: id, fields: view.changes.map((c) => c.field) });
    return view;
  });

  app.put('/:id/pending/staging', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { staging } = pendingStagingInput.parse(req.body ?? {});
    const view = await setStaging(app.db, svc, staging, await visibleView(app.db, svc, req.user!.isOperator));
    void audit(app.db, req.user!.id, 'service.changes.staging', svc.name, { serviceId: id, staging });
    return view;
  });

  app.delete('/:id/pending', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await clearPending(app.db, id);
    void audit(app.db, req.user!.id, 'service.changes.discard', svc.name, { serviceId: id });
    return pendingChanges(app.db, svc, await visibleView(app.db, svc, req.user!.isOperator));
  });

  app.post('/:id/pending/apply', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { deploy, includeOthers, version } = pendingApplyInput.parse(req.body ?? {});
    // One snapshot: the checks, the diff and the PATCH body all come from it.
    const snapshot = await readPending(app.db, id);
    const changes = await rawChanges(app.db, svc, snapshot.patch);
    if (changes.length === 0) throw new HttpError(409, 'nothing_pending', 'There are no pending changes to apply');
    // Security review (TOCTOU): only the tray the caller reviewed is applied.
    if ((snapshot.version ?? snapshot.updatedAt) !== version) {
      throw new HttpError(409, 'pending_changed', 'The pending changes changed since you reviewed them; review them again');
    }
    // Security review: the PATCH runs with the caller's authority. Changes
    // someone else staged (or of unknown origin) are applied only on purpose.
    const others = changes.filter((c) => snapshot.stagedBy[c.field] !== req.user!.id);
    if (others.length > 0 && !includeOthers) {
      throw new HttpError(
        409,
        'others_changes',
        `${others.length} of the pending changes were staged by someone else; review them and apply with includeOthers, or discard them`,
      );
    }
    const headers = forwardedAuth(req.headers);
    const res = await app.inject({ method: 'PATCH', url: `/v1/services/${id}`, headers, payload: snapshot.patch });
    if (res.statusCode >= 400) {
      // The tray is kept: the caller fixes or discards the refused change.
      const body = res.json() as { error?: { code?: string; message?: string } };
      throw new HttpError(res.statusCode, body.error?.code ?? 'apply_refused', body.error?.message ?? 'The changes were refused');
    }
    await clearApplied(app.db, id, snapshot);
    const applied = changes.map((c) => c.field);
    void audit(app.db, req.user!.id, 'service.changes.apply', svc.name, {
      serviceId: id,
      fields: applied,
      deploy,
      stagedBy: Object.fromEntries(changes.map((c) => [c.field, snapshot.stagedBy[c.field] ?? null])),
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
