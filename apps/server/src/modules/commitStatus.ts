import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { sources } from '@ninedeploy/db';
import { serviceCommitStatusInput } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest, parseId } from '../lib/errors.js';
import { getCommitStatusSetting, parseRepoUrl, reportsCommitStatus, setCommitStatusSetting } from '../lib/gitCommitStatus.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';

/**
 * `GET|PUT /v1/services/:id/commit-status` (ROADMAP 0.16.8 item 8): commit
 * statuses on GitLab, Gitea and Bitbucket for a service that clones through a
 * token source of that type (lib/gitCommitStatus.ts). Reading needs `member`;
 * switching needs `admin`, since it sends the source's token to the provider.
 * Previews report through their parent, so their own setting is refused.
 */

export const commitStatusRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  /** Why this service cannot report, or null when it can. */
  const unavailable = async (svc: { sourceId: number | null; repoUrl: string | null; previewParentServiceId: number | null }) => {
    if (svc.previewParentServiceId != null) return 'A preview reports through its parent service';
    if (!svc.sourceId || !svc.repoUrl) return 'The service does not clone through a git source';
    const src = await app.db.query.sources.findFirst({ where: eq(sources.id, svc.sourceId) });
    if (!src || !reportsCommitStatus(src.type)) return 'Commit statuses here are for GitLab, Gitea and Bitbucket token sources (GitHub reports through the GitHub App)';
    if (!src.tokenEncrypted) return 'The source has no token';
    const repo = parseRepoUrl(svc.repoUrl);
    if (!repo) return 'The repository URL is not an https URL';
    if (src.type === 'bitbucket' && repo.host !== 'bitbucket.org') return 'Bitbucket statuses are for bitbucket.org repositories';
    return null;
  };

  app.get('/:id/commit-status', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const src = svc.sourceId ? await app.db.query.sources.findFirst({ where: eq(sources.id, svc.sourceId) }) : null;
    return {
      enabled: (await getCommitStatusSetting(app.db, svc.id)).enabled,
      provider: src && reportsCommitStatus(src.type) ? src.type : null,
      unavailable: await unavailable(svc),
    };
  });

  app.put('/:id/commit-status', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    const { enabled } = serviceCommitStatusInput.parse(req.body ?? {});
    const why = await unavailable(svc);
    if (enabled && why) throw badRequest(why, 'commit_status_unavailable');
    await setCommitStatusSetting(app.db, svc.id, { enabled });
    void audit(app.db, req.user!.id, enabled ? 'service.commit_status.enable' : 'service.commit_status.disable', svc.name, { serviceId: svc.id });
    const src = svc.sourceId ? await app.db.query.sources.findFirst({ where: eq(sources.id, svc.sourceId) }) : null;
    return { enabled, provider: src && reportsCommitStatus(src.type) ? src.type : null, unavailable: why };
  });
};
