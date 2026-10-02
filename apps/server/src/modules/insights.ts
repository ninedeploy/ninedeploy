import { type Dirent, lstatSync, readdirSync, rmSync } from 'node:fs';
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
import { HttpError, badRequest, forbidden, notFound, parseId } from '../lib/errors.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { EgressBlockedError } from '../lib/egressGuard.js';
import { serializeInsights, upsertInsights } from '../engine/repoInsights.js';

/** Map an egress-gate refusal onto a client-comprehensible 400. */
function toApiError(err: unknown): unknown {
  if (err instanceof EgressBlockedError) return badRequest(err.message, 'egress_blocked');
  return err;
}

/**
 * r657: limits for an inspection clone. Both routes clone on the request path
 * for any signed-in user (10/min each), and the clone used to be a full one —
 * every branch, all history, every submodule, no time limit — so one request
 * against a huge repository pinned panel disk, network and CPU. Mutable so a
 * test can shrink them.
 */
export const INSPECTION_LIMITS = {
  timeoutMs: 60_000,
  maxBytes: 300 * 1024 * 1024,
  pollMs: 1_000,
};

/** Bytes under `dir`, stopping as soon as `cap` is exceeded. Symlinks are not followed. */
function sizeExceeds(dir: string, cap: number): boolean {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // not created yet, or removed mid-walk
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += lstatSync(full).size;
      } catch {
        /* vanished mid-walk */
      }
      if (total > cap) return true;
    }
  }
  return false;
}

/**
 * Shallow, time- and size-bounded checkout for analysis. A watcher aborts the
 * git process once the checkout outgrows the cap; either limit answers a 400
 * that says what to do instead.
 */
async function inspectionCheckout(repoUrl: string, branch: string, dir: string, creds: CloneCreds | undefined): Promise<string> {
  const controller = new AbortController();
  // A holder, not a `let`: the callbacks below set it, which flow analysis cannot see.
  const stop: { reason: 'timeout' | 'size' | null } = { reason: null };
  const timer = setTimeout(() => {
    stop.reason = 'timeout';
    controller.abort();
  }, INSPECTION_LIMITS.timeoutMs);
  const watcher = setInterval(() => {
    if (sizeExceeds(dir, INSPECTION_LIMITS.maxBytes)) {
      stop.reason = 'size';
      controller.abort();
    }
  }, INSPECTION_LIMITS.pollMs);
  try {
    const sha = await checkoutCommit(repoUrl, branch, undefined, dir, () => undefined, creds, {
      shallow: true,
      signal: controller.signal,
    });
    // A checkout that finished between two polls is still held to the cap.
    if (stop.reason === null && sizeExceeds(dir, INSPECTION_LIMITS.maxBytes)) stop.reason = 'size';
    if (stop.reason) throw new Error('inspection limit');
    return sha;
  } catch (err) {
    if (stop.reason === 'timeout') {
      throw badRequest(
        `Repository analysis stopped after ${Math.round(INSPECTION_LIMITS.timeoutMs / 1000)}s — the repository is too slow to fetch for a preview analysis. Create the service; the deploy analyses it.`,
        'inspection_limit',
      );
    }
    if (stop.reason === 'size') {
      throw badRequest(
        `Repository analysis stopped: the checkout is larger than ${Math.round(INSPECTION_LIMITS.maxBytes / (1024 * 1024))} MB. Create the service; the deploy analyses it.`,
        'inspection_limit',
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    clearInterval(watcher);
  }
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
        await inspectionCheckout(input.repoUrl, input.branch, dir, creds);
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

  // Refresh synchronously clones the full repository on the request path —
  // same rate limit as the analysis route, or a member can loop it against a
  // large repo and pin panel disk/network/CPU.
  app.post(
    '/:id/insights/refresh',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // Refresh re-clones the repository and rewrites the stored analysis — a
    // write on the service, so the
    // `member` floor applies (a viewer seat stays read-only).
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (!svc.repoUrl) throw badRequest('Service has no repository URL to analyze');
    const build = await app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, id) });

    // r224: analysed in a THROWAWAY checkout. This used to reuse the service's
    // canonical dir (reposDir/<id>) — the one the deploy pipeline builds
    // from — with no lock: a refresh during a rollback or webhook deploy of
    // commit X checked the branch tip out underneath the running build, and
    // the deployment recorded X while building different code.
    const workDir = path.join(config.paths.reposDir, '_inspections', randomUUID());
    const creds = await resolveCreds(app.db, svc.sourceId);
    try {
      let sha: string;
      try {
        sha = await inspectionCheckout(svc.repoUrl, svc.branch, workDir, creds);
      } catch (err) {
        if (err instanceof EgressBlockedError) throw toApiError(err);
        if (err instanceof HttpError) throw err; // r657: an inspection limit says so
        req.log.warn({ err, serviceId: id }, 'insights refresh could not fetch the repository');
        throw notFound('Repository is not reachable');
      }
      const insights = analyzeRepo(workDir, build?.baseDir, sha);
      await upsertInsights(app.db, id, insights);
      return insights;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
};
