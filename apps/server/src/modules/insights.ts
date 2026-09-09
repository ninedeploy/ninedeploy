import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { buildConfigs, repoInsights, sources, type DB } from '@ninedeploy/db';
import { analyzeRepoInput } from '@ninedeploy/schemas';
import { analyzeRepo } from '../lib/frameworks.js';
import { checkoutCommit, type CloneCreds } from '../lib/git.js';
import { decrypt } from '../lib/crypto.js';
import { config } from '../config.js';
import { badRequest, forbidden, notFound, parseId } from '../lib/errors.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { EgressBlockedError } from '../lib/egressGuard.js';
import { serializeInsights, upsertInsights } from '../engine/repoInsights.js';

/** Map an egress-gate refusal onto a client-comprehensible 400. */
function toApiError(err: unknown): unknown {
  if (err instanceof EgressBlockedError) return badRequest(err.message, 'egress_blocked');
  return err;
}

/** Resolve clone credentials for a source id — same contract as the pipeline. */
async function resolveCreds(db: DB, sourceId: number | null | undefined): Promise<CloneCreds | undefined> {
  if (!sourceId) return undefined;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
  if (!src) return undefined;
  return {
    type: src.type,
    token: src.tokenEncrypted ? decrypt(src.tokenEncrypted) : undefined,
    deployKey: src.deployKeyEncrypted ? decrypt(src.deployKeyEncrypted) : undefined,
  };
}

/**
 * Pre-deploy repository inspection (DeployWizard). Clones the repo into a
 * throwaway directory under the server's repos dir and runs framework
 * detection. Trust model matches a deploy: any authenticated user can already
 * create a repo-backed service and have the pipeline clone it, so this adds
 * no new outbound capability — it is rate-limited to deter scanning.
 */
export const insightsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const input = analyzeRepoInput.parse(req.body);
      // Sources are system-wide operator credentials (sourcesRoutes is
      // requireAdmin). A member attaching a guessed sourceId here would get
      // the operator's decrypted token attached to a clone of ANY repoUrl —
      // a cheap private-repo existence/stack probe, or full exfiltration via
      // a later service create.
      if (input.sourceId != null && !req.user!.isOperator) {
        throw forbidden('Only operators may analyze a repository with a managed source');
      }
      const creds = await resolveCreds(app.db, input.sourceId);
      const dir = path.join(config.paths.reposDir, '_inspections', randomUUID());
      try {
        await checkoutCommit(input.repoUrl, input.branch, undefined, dir, () => undefined, creds);
        return analyzeRepo(dir, input.baseDir);
      } catch (err) {
        throw toApiError(err);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
};

/** Per-service insights for the service-detail Framework tab / overview card. */
export const serviceInsightsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/insights', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const row = await app.db.query.repoInsights.findFirst({ where: eq(repoInsights.serviceId, id) });
    return row ? serializeInsights(row) : null;
  });

  app.post('/:id/insights/refresh', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // Refresh re-clones the repository into the service's canonical checkout
    // dir and rewrites the stored analysis — a write on the service, so the
    // `member` floor applies (a viewer seat stays read-only).
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!svc.repoUrl) throw badRequest('Service has no repository URL to analyze');
    const build = await app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, id) });

    // Reuse the service's canonical checkout dir (the same location the deploy
    // pipeline uses, so a fresh clone here is reused by the next deploy).
    // checkoutCommit fetches+checks out the branch tip when .git exists and
    // re-clones otherwise, so both the "never deployed" and "refresh" cases
    // are one call.
    const workDir = path.join(config.paths.reposDir, String(svc.id));
    const creds = await resolveCreds(app.db, svc.sourceId);
    let sha: string | undefined;
    try {
      sha = await checkoutCommit(svc.repoUrl, svc.branch, undefined, workDir, () => undefined, creds);
    } catch (err) {
      if (!existsSync(path.join(workDir, '.git'))) {
        if (err instanceof EgressBlockedError) throw toApiError(err);
        throw notFound('Repository is not reachable');
      }
      req.log.warn({ err, serviceId: id }, 'insights refresh fell back to the cached checkout');
    }
    if (!sha) throw notFound('Repository is not reachable');

    const insights = analyzeRepo(workDir, build?.baseDir, sha);
    await upsertInsights(app.db, id, insights);
    return insights;
  });
};
