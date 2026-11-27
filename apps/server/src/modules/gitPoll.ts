import type { FastifyPluginAsync } from 'fastify';
import { gitPollInput } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { parseId, unprocessable } from '../lib/errors.js';
import { getGitPoll, gitPollSupported, gitPollView, setGitPoll } from '../lib/gitPoll.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';

/**
 * X2 Git polling: `GET`/`PUT /v1/services/:id/git-poll`. Reading is for
 * viewers; turning it on is a deploy setting (`member`), because a poll
 * queues deploys. Only a service with a Git repository can poll.
 */
export const gitPollRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/git-poll', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    return gitPollView(await getGitPoll(app.db, id), svc);
  });

  app.put('/:id/git-poll', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { poll } = gitPollInput.parse(req.body ?? {});
    // Turning it off is always allowed; on, there must be a repository to read.
    if (poll && !gitPollSupported(svc)) throw unprocessable('This service has no Git repository to poll: it deploys an image.', 'git_poll_unsupported');
    await setGitPoll(app.db, id, poll);
    void audit(app.db, req.user!.id, 'service.git_poll.set', `${svc.name} #${svc.id}`, { serviceId: id, intervalSeconds: poll?.intervalSeconds ?? null });
    return gitPollView(await getGitPoll(app.db, id), svc);
  });
};
