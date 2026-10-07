import { type Dirent, lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { buildConfigs, repoInsights, sources, type DB } from '@ninedeploy/db';
import { analyzeRepoInput } from '@ninedeploy/schemas';
import { analyzeRepo } from '../lib/frameworks.js';
import { checkoutCommit, type CloneCreds } from '../lib/git.js';
import { decrypt } from '../lib/crypto.js';
import { config } from '../config.js';
import { HttpError, badRequest, forbidden, notFound, parseId } from '../lib/errors.js';
import { assertServiceRole, maxRole, roleAtLeast, userWorkspaceMemberships } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { EgressBlockedError } from '../lib/egressGuard.js';
import { serializeInsights, upsertInsights } from '../engine/repoInsights.js';

/** Map an egress-gate refusal onto a client-comprehensible 400. */
function toApiError(err: unknown): unknown {
  if (err instanceof EgressBlockedError) return badRequest(err.message, 'egress_blocked');
  return err;
}

/** A repository URL safe to repeat to the client: userinfo removed. */
function displayRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    url.username = '';
    url.password = '';
    return url.toString().slice(0, 200);
  } catch {
    return repoUrl.replace(/\/\/[^/@]+@/, '//').slice(0, 200);
  }
}

/** git's stderr for the log, with any credential this checkout used removed. */
function redactGitOutput(text: string, creds: CloneCreds | undefined): string {
  let out = text.replace(/\/\/[^/@\s'"]+@/g, '//***@');
  const token = creds?.token;
  if (token) {
    for (const piece of [encodeURIComponent(token), token]) out = out.split(piece).join('[redacted]');
  }
  return out.slice(0, 2000);
}

/**
 * F1006: a failed inspection clone (private repository without a credential,
 * a credential with no access, a missing branch, an unreachable host) used to
 * escape as a bare 500 from POST /insights and a generic 404 from refresh —
 * the wizard could not tell "your token cannot see this repository" from a
 * crash. Classify git's own stderr (simple-git puts it in the error message)
 * into a 400 that says what to do. The message is built from the URL without
 * its userinfo and never repeats git's output. Anything unrecognised is
 * returned as null and keeps its previous handling.
 */
function cloneFailure(err: unknown, repoUrl: string, branch: string, creds: CloneCreds | undefined): HttpError | null {
  if (!(err instanceof Error) || err instanceof HttpError || err instanceof EgressBlockedError) return null;
  const text = err.message;
  const url = displayRepoUrl(repoUrl);
  if (/Remote branch .+ not found in upstream|Could not find remote branch/i.test(text)) {
    return badRequest(`Could not clone ${url}: branch "${branch}" does not exist in the repository. Pick an existing branch.`, 'branch_not_found');
  }
  if (/returned error: 30[1278]\b/i.test(text)) {
    return badRequest(
      `Could not clone ${url}: the Git host answered with a redirect, which NineDeploy does not follow. If the repository was renamed or moved, use its current URL.`,
      'repo_unreachable',
    );
  }
  if (
    /repository '[^']*' not found|Repository not found|Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or (password|token)|HTTP Basic: Access denied|returned error: 40[134]\b|Permission denied \(publickey|Could not read from remote repository|could not be found or you don't have permission/i.test(
      text,
    )
  ) {
    // F1009: a fixed reason class (never git's own text) so the user can tell
    // "the credential was refused" from "the repository is invisible to it".
    const reason = /returned error: 403\b/i.test(text)
      ? 'HTTP 403 (permission denied)'
      : /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or (password|token)|HTTP Basic: Access denied|returned error: 401\b|Permission denied \(publickey/i.test(text)
        ? 'authentication failed'
        : 'repository not found or no access';
    if (!creds?.token && !creds?.deployKey) {
      return badRequest(
        `Could not clone ${url} (reason: ${reason}): the repository was not found, or it is private — select a Git credential that has access to it.`,
        'repo_unreachable',
      );
    }
    const detail =
      reason === 'authentication failed'
        ? 'the Git host refused the selected credential (an expired, revoked or mistyped token, or a deploy key it does not accept).'
        : reason === 'HTTP 403 (permission denied)'
          ? 'the selected credential was accepted but denied access to this repository.'
          : 'the repository was not found or the selected credential has no access to it.';
    const github = !!creds.token && reason !== 'authentication failed' && (creds.type === 'github' || /^https?:\/\/(www\.)?github\.com\//i.test(url));
    return badRequest(
      `Could not clone ${url} (reason: ${reason}): ${detail}${
        github
          ? " For a fine-grained GitHub token, add this repository to the token's repository access; fine-grained tokens also need Contents: Read-only (organization repositories may also need the token approved or SSO-authorized). A classic token needs the repo scope."
          : ''
      }`,
      'repo_unreachable',
    );
  }
  // Not a bare "unable to access": git also says that for an HTTP 5xx, where the host WAS reached.
  if (/Could not resolve host|Failed to connect|Could not connect to server|Connection (timed out|refused|reset)|SSL certificate problem|certificate verif|\bSSL\b.*(connect|handshake)|schannel|Host key verification failed|Could not resolve hostname|Network is unreachable/i.test(text)) {
    const reason = /SSL certificate problem|certificate verif|\bSSL\b.*(connect|handshake)|schannel|Host key verification failed/i.test(text)
      ? 'TLS or host-key verification failed'
      : 'could not resolve/connect';
    return badRequest(`Could not clone ${url} (reason: ${reason}): the Git host could not be reached from the panel (DNS, network or TLS failure).`, 'repo_unreachable');
  }
  return null;
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
async function inspectionCheckout(
  repoUrl: string,
  branch: string,
  dir: string,
  creds: CloneCreds | undefined,
  log: FastifyBaseLogger,
): Promise<string> {
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
    // F1006: a recognised clone failure answers a 400 that says what to do;
    // git's own (redacted) output stays in the server log.
    const mapped = cloneFailure(err, repoUrl, branch, creds);
    if (mapped) {
      log.warn({ git: redactGitOutput((err as Error).message, creds), code: mapped.code }, 'inspection clone failed');
      throw mapped;
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
 *
 * r711: "any authenticated user" was wider than that premise — creating a
 * service needs the `member` role somewhere (services.ts), but this route let
 * a seatless or viewer-only account have the panel clone arbitrary
 * repositories. It now asks for the same floor.
 */
export const insightsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const input = analyzeRepoInput.parse(req.body);
      if (!req.user!.isOperator) {
        const best = maxRole(await userWorkspaceMemberships(app.db, req.user!.id));
        if (best === null || !roleAtLeast(best, 'member')) {
          throw forbidden('Analyzing a repository requires the "member" role in a workspace');
        }
      }
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
        await inspectionCheckout(input.repoUrl, input.branch, dir, creds, req.log);
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
        sha = await inspectionCheckout(svc.repoUrl, svc.branch, workDir, creds, req.log);
      } catch (err) {
        if (err instanceof EgressBlockedError) throw toApiError(err);
        if (err instanceof HttpError) throw err; // r657 / F1006: an inspection limit or a classified clone failure says so
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
