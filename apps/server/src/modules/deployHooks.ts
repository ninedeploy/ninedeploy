import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { deployments, services, users } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { enqueueUserDeploy } from '../lib/deployQueue.js';
import { notFound, parseId } from '../lib/errors.js';
import { assertMayDeployStoredService } from '../lib/hostPrivilege.js';
import { panelOrigin } from '../lib/panelOrigin.js';
import { assertRemoteDatabaseReachable, assertRemoteDeploySupported, assertRemoteServiceSupported } from '../lib/remoteDeploy.js';
import { assertServiceRole, isOperator } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';

/**
 * Deploy hooks: a secret URL that redeploys one service when called with
 * POST, for a CI job or a script that has no Git webhook to lean on (Coolify's
 * and Dokploy's "deploy webhook"). Off until a member turns it on; the token
 * in the URL is the only credential, can be rotated and turned off.
 *
 * A call runs as the member who created the hook, with every check a manual
 * deploy makes, re-done at call time: a member who lost the service (or was
 * deleted) leaves a hook that answers 403/404. Operator authority is the
 * smaller of what the creating request had and what the user has now, so a
 * hook made through a scope-restricted API token never deploys with more.
 */

const newToken = () => randomBytes(24).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** Hook management, mounted under `/services`. */
export const serviceDeployHookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // The URL is shown to the member it deploys as, and to nobody else: it
  // carries that member's authority (an operator's hook on a compose stack
  // deploys what a plain member could not), so another member sees only that
  // a hook exists. Rotating it makes it theirs, with their own authority.
  const view = async (token: string | null, mine: boolean) =>
    token
      ? { enabled: true, url: mine ? `${await panelOrigin(app.db)}/v1/deploy-hooks/${token}` : null, mine }
      : { enabled: false, url: null, mine: false };

  app.get('/:id/deploy-hook', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    return view(svc.deployHookToken ?? null, svc.deployHookUserId === req.user!.id);
  });

  // Turn the hook on, or rotate its URL (the old one stops working). The
  // caller becomes the identity the hook deploys as.
  app.post('/:id/deploy-hook', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    // Making the hook is the same act as deploying: refuse it where a deploy would be refused.
    await assertMayDeployStoredService(app.db, req.user!, svc);
    const token = newToken();
    await app.db
      .update(services)
      .set({ deployHookToken: token, deployHookUserId: req.user!.id, deployHookOperator: req.user!.isOperator })
      .where(eq(services.id, svc.id));
    void audit(app.db, req.user!.id, svc.deployHookToken ? 'service.deploy_hook.rotate' : 'service.deploy_hook.enable', svc.name, { serviceId: svc.id });
    return view(token, true);
  });

  app.delete('/:id/deploy-hook', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await app.db.update(services).set({ deployHookToken: null, deployHookUserId: null, deployHookOperator: false }).where(eq(services.id, svc.id));
    void audit(app.db, req.user!.id, 'service.deploy_hook.disable', svc.name, { serviceId: svc.id });
    return view(null, false);
  });
};

/** The hook itself, mounted under `/deploy-hooks`. No session: the token is the credential. POST only, so a link preview never deploys. */
export const publicDeployHookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/:token', async (req, reply) => {
    const token = String((req.params as { token: string }).token);
    const svc = TOKEN_RE.test(token) ? await app.db.query.services.findFirst({ where: eq(services.deployHookToken, token) }) : undefined;
    // One answer for a wrong token and a hook whose creator is gone: nothing to learn by guessing.
    const creator = svc?.deployHookUserId != null ? await app.db.query.users.findFirst({ where: eq(users.id, svc.deployHookUserId), columns: { id: true } }) : undefined;
    if (!svc || !creator) throw notFound('No such deploy hook');
    const user = { id: creator.id, isOperator: svc.deployHookOperator && (await isOperator(app.db, creator)) };
    // Every check a manual deploy makes, as that user, now.
    await assertServiceRole(app.db, svc, user, 'member');
    await assertMayDeployStoredService(app.db, user, svc);
    assertRemoteDeploySupported(svc);
    await assertRemoteDatabaseReachable(app.db, svc);
    await assertRemoteServiceSupported(app.db, svc);
    // A build already running answers with its id, like a second manual click.
    const inflight = await app.db.query.deployments.findFirst({
      where: and(eq(deployments.serviceId, svc.id), inArray(deployments.status, ['building', 'deploying'])),
      orderBy: desc(deployments.id),
    });
    reply.code(202);
    if (inflight) return { deploymentId: inflight.id, alreadyInProgress: true };
    // 0.16.13: whoever holds the URL is not the admin who made it — into an
    // approval-gated lane the deploy waits like any other.
    const deploymentId = await enqueueUserDeploy(app.db, user, svc, { message: 'Deploy hook' }, { selfApproval: false });
    void audit(app.db, user.id, 'deploy.trigger', `${svc.name} #${deploymentId}`, { serviceId: svc.id, deploymentId, via: 'deploy_hook' });
    return { deploymentId };
  });
};
