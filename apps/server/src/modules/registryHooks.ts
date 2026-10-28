import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { deployments, services, users } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { enqueueUserDeploy } from '../lib/deployQueue.js';
import { badRequest, notFound, parseId } from '../lib/errors.js';
import { assertMayDeployStoredService } from '../lib/hostPrivilege.js';
import { panelOrigin } from '../lib/panelOrigin.js';
import {
  createRegistryHook,
  deleteRegistryHook,
  getRegistryHook,
  markRegistryPush,
  pushedImages,
  pushMatchesImage,
  tokenMatches,
  type StoredRegistryHook,
} from '../lib/registryHooks.js';
import { assertRemoteDatabaseReachable, assertRemoteDeploySupported, assertRemoteServiceSupported } from '../lib/remoteDeploy.js';
import { assertServiceRole, isOperator } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';

/**
 * G1.7 registry push webhooks: a secret URL per image service that Docker
 * Hub, GHCR, Harbor, a `registry:2` or a CI step calls after a push. When the
 * pushed repository and tag are the service's image, the service redeploys.
 *
 * Like a deploy hook, a call runs as the member who made the hook, with every
 * check a manual deploy makes re-done at call time. The token is stored only
 * as a hash, so the URL is shown once, when it is made.
 */

const view = (hook: StoredRegistryHook | null, userId: number, url: string | null = null) =>
  hook
    ? { enabled: true, mine: hook.userId === userId, url, createdAt: hook.createdAt, lastPushAt: hook.lastPushAt ?? null }
    : { enabled: false, mine: false, url: null, createdAt: null, lastPushAt: null };

/** Hook management, mounted under `/services`. */
export const serviceRegistryHookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/registry-hook', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    return view(await getRegistryHook(app.db, svc.id), req.user!.id);
  });

  // Turn the hook on, or rotate its URL. The caller becomes the identity it deploys as.
  app.post('/:id/registry-hook', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (svc.type !== 'docker' || !svc.image) throw badRequest('A registry webhook needs a service deployed from an image', 'not_an_image_service');
    await assertMayDeployStoredService(app.db, req.user!, svc);
    const had = await getRegistryHook(app.db, svc.id);
    const token = await createRegistryHook(app.db, svc.id, req.user!);
    void audit(app.db, req.user!.id, had ? 'service.registry_hook.rotate' : 'service.registry_hook.enable', svc.name, { serviceId: svc.id });
    return view(await getRegistryHook(app.db, svc.id), req.user!.id, `${await panelOrigin(app.db)}/v1/registry-hooks/${svc.id}/${token}`);
  });

  app.delete('/:id/registry-hook', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await deleteRegistryHook(app.db, svc.id);
    void audit(app.db, req.user!.id, 'service.registry_hook.disable', svc.name, { serviceId: svc.id });
    return view(null, req.user!.id);
  });
};

/** The hook itself, mounted under `/registry-hooks`. No session: the token is the credential. */
export const publicRegistryHookRoutes: FastifyPluginAsync = async (app) => {
  // `registry:2` notifications use their own media type; read them as JSON.
  app.addContentTypeParser(
    /^application\/vnd\.docker\.distribution\.events\.v\d\+json/,
    { parseAs: 'string' },
    app.getDefaultJsonParser('error', 'ignore'),
  );

  app.post('/:serviceId/:token', async (req, reply) => {
    const params = req.params as { serviceId: string; token: string };
    const serviceId = /^\d{1,10}$/.test(params.serviceId) ? Number(params.serviceId) : 0;
    const hook = serviceId > 0 ? await getRegistryHook(app.db, serviceId) : null;
    const svc = hook && tokenMatches(hook, String(params.token)) ? await app.db.query.services.findFirst({ where: eq(services.id, serviceId) }) : undefined;
    // One answer for a wrong token and a hook whose creator is gone.
    const creator = svc && hook ? await app.db.query.users.findFirst({ where: eq(users.id, hook.userId), columns: { id: true } }) : undefined;
    if (!svc || !hook || !creator) throw notFound('No such registry webhook');
    reply.code(202);
    const pushed = pushedImages(req.body);
    const match = svc.type === 'docker' && svc.image ? pushed.find((p) => pushMatchesImage(p, svc.image!)) : undefined;
    if (!match) {
      return { ignored: true, reason: pushed.length ? 'The pushed image is not this service\'s image and tag' : 'No pushed image in the payload' };
    }
    const user = { id: creator.id, isOperator: hook.operator && (await isOperator(app.db, creator)) };
    await assertServiceRole(app.db, svc, user, 'member');
    await assertMayDeployStoredService(app.db, user, svc);
    assertRemoteDeploySupported(svc);
    await assertRemoteDatabaseReachable(app.db, svc);
    await assertRemoteServiceSupported(app.db, svc);
    await markRegistryPush(app.db, svc.id, hook);
    // A deploy that has not pulled yet will pick the new image up; registries
    // also retry and send one event per tag, so answer with it.
    const pending = await app.db.query.deployments.findFirst({
      where: and(eq(deployments.serviceId, svc.id), inArray(deployments.status, ['queued', 'building', 'deploying'])),
      orderBy: desc(deployments.id),
    });
    if (pending?.status === 'queued') return { deploymentId: pending.id, alreadyQueued: true };
    const deploymentId = await enqueueUserDeploy(app.db, user, svc, { message: `Registry push: ${svc.image}` }, { selfApproval: false });
    // The auto-update sweep re-reads its baseline instead of deploying the same push again.
    await app.db.update(services).set({ autoUpdateDigest: null }).where(eq(services.id, svc.id));
    void audit(app.db, user.id, 'deploy.trigger', `${svc.name} #${deploymentId}`, { serviceId: svc.id, deploymentId, via: 'registry_hook' });
    return { deploymentId };
  });
};
