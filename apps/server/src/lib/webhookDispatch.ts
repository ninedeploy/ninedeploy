import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  buildConfigs,
  deployments,
  domains,
  envVars,
  githubAppInstallations,
  serviceGithubLinks,
  services,
  type DB,
  type Service,
} from '@ninedeploy/db';
import type { FastifyBaseLogger } from 'fastify';
import { gitBranch, gitRepoUrl } from '@ninedeploy/schemas';
import { matchesAny, parseWatchPaths } from './glob.js';
import { isUniqueViolation, notFound } from './errors.js';
import type { Provider, PullRequestEvent, PushEvent } from './webhooks.js';
import { assertMayDeployStoredService } from './hostPrivilege.js';
import { isOperator } from './resourceAccess.js';
import { dockerBuilder } from '../engine/builders/docker.js';
import { pm2Builder } from '../engine/builders/pm2.js';
import { composeBuilder } from '../engine/builders/compose.js';
import { deleteLog } from '../engine/logs.js';
import { removeServiceBridgeIfEmpty } from './serviceBridge.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { getServiceTags, replaceServiceTags } from '../modules/serviceTags.js';
import { DEFAULT_PREVIEW_DOMAIN_PATTERN, previewHostSkipReason, renderPreviewHost } from './previewDomain.js';
import { ownZoneClaimRefusal } from './domainVerification.js';
import { previewDestroyedFeedback } from './githubFeedback.js';

/**
 * Webhook dispatch shared by the per-service receiver (`modules/hooks.ts`,
 * `POST /v1/hooks/:id`) and the GitHub App receiver
 * (`modules/githubAppHooks.ts`, `POST /v1/hooks/github-app/:hookKey`), 0.13.
 *
 * Moved out of `modules/hooks.ts` unchanged: `handlePullRequest` is the
 * ephemeral-preview path and `handlePush` the push path, each answering with
 * exactly the response bodies the per-service receiver always returned. The
 * callers own authentication (HMAC), replay protection and the routing to a
 * service; everything after that — the gates, the preview lifecycle, the SHA
 * dedup and the race guard — is one implementation for both receivers.
 */

/** A receiver's JSON answer. */
export type DispatchResult = Record<string, unknown>;

/** GitHub caps the push payload's `commits` array at this size; a list at the
 *  cap may be truncated, so watch-path filtering fails open (see below). */
const COMMIT_LIST_CAP = 20;

async function stopRuntimeFor(service: { runtimeId: string | null; type: string }) {
  if (!service.runtimeId) return;
  try {
    if (service.type === 'docker') await dockerBuilder.stop(service.runtimeId);
    else if (service.type === 'pm2') await pm2Builder.stop(service.runtimeId);
    else if (service.type === 'compose') await composeBuilder.stop(service.runtimeId);
  } catch {
    /* swallow runtime stop error */
  }
}

/** Compare repository identity independently of HTTPS/SSH transport and .git suffix. */
export function repositoryIdentity(raw: string): string | null {
  const parsed = gitRepoUrl.safeParse(raw);
  if (!parsed.success) return null;
  const url = new URL(parsed.data);
  return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()}`;
}

/**
 * Webhook deliveries carry no panel session — a valid HMAC proves only that
 * the provider sent the event, not who may start a deploy. Authorize the
 * triggered deploy against the service OWNER's privileges, so a webhook
 * managed by a non-operator cannot launch a host-executing deploy (PM2 /
 * compose / lifecycle hooks / docker-socket templates) they could not have
 * started from the UI themselves.
 */
export async function assertWebhookMayDeploy(
  db: DB,
  svc: { id: number; type: string; dockerSocket?: boolean | null; ownerUserId: number | null },
): Promise<void> {
  const ownerId = svc.ownerUserId;
  // Legacy rows created before ownership existed have no owner to authorize
  // against (same convention as assertCanManageService): they predate members
  // entirely, so defer instead of breaking their webhooks.
  if (!ownerId) return;
  const ownerIsOperator = await isOperator(db, { id: ownerId });
  await assertMayDeployStoredService(db, { id: ownerId, isOperator: ownerIsOperator }, svc);
}

/**
 * Full teardown for one ephemeral preview: the service row cascades its
 * deployments/domains, but the log files on disk, the Traefik route and the
 * private bridge network are ours to clean up. Shared by the PR-close path
 * and the preview-cap eviction path (r036: eviction stopped and deleted only,
 * leaking a Docker network + log files + a stale route per eviction).
 */
export async function destroyPreviewService(
  db: DB,
  log: FastifyBaseLogger,
  preview: {
    id: number;
    slug: string;
    runtimeId: string | null;
    type: string;
    previewParentServiceId?: number | null;
    prNumber?: number | null;
  },
): Promise<void> {
  await stopRuntimeFor(preview);
  // The FK cascade takes the deployment ROWS; the log files on disk are
  // ours to remove. Read them before the row goes.
  let previewLogs: Array<{ id: number }> = [];
  try {
    previewLogs = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.serviceId, preview.id));
  } catch (err) {
    log.warn({ err, serviceId: preview.id }, 'could not list preview deploy logs to clean up');
  }
  await db.delete(services).where(eq(services.id, preview.id));
  for (const row of previewLogs) deleteLog(row.id);
  try {
    await writeDynamicConfig(db);
  } catch {
    /* best effort */
  }
  // Every deployed service gets a private bridge network
  // (`ensureServiceBridge`, called by the docker builder). Only the panel's
  // DELETE route reaped it, so this path — the one designed for high churn,
  // one preview per pull request — leaked a Docker network per closed PR.
  try {
    await removeServiceBridgeIfEmpty(preview.slug, (line) => log.info({ bridge: preview.slug }, line));
  } catch (err) {
    log.warn({ err, slug: preview.slug }, 'failed to reap preview bridge');
  }
  // 0.13: an opted-in GitHub link edits its PR comment to say the preview is
  // gone. Observational — it never delays or fails the teardown.
  if (preview.previewParentServiceId != null && preview.prNumber != null) {
    void previewDestroyedFeedback(db, log, preview.previewParentServiceId, preview.prNumber).catch(() => undefined);
  }
}

/**
 * 0.13 coexistence: a service is App-driven when it has an ENABLED GitHub link
 * on an installation that is neither suspended nor removed. Its per-service
 * webhook deliveries are then skipped (the App delivers the same events), so
 * one push never deploys twice. A suspended or removed installation hands the
 * service back to its per-service webhook.
 */
export async function isGithubAppDriven(db: DB, serviceId: number): Promise<boolean> {
  const link = await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, serviceId) });
  if (!link?.enabled) return false;
  const inst = await db.query.githubAppInstallations.findFirst({
    where: and(
      eq(githubAppInstallations.id, link.installationRowId),
      isNull(githubAppInstallations.suspendedAt),
      isNull(githubAppInstallations.removedAt),
    ),
  });
  return !!inst && inst.suspendedAt == null && inst.removedAt == null;
}

/**
 * Ephemeral PR / MR preview deployments for `parent`: create or refresh the
 * preview on opened / synchronize / reopened, tear it down on close.
 */
export async function handlePullRequest(
  db: DB,
  parent: Service,
  pr: PullRequestEvent,
  provider: Provider,
  log: FastifyBaseLogger,
): Promise<DispatchResult> {
  if (!parent.previewDeploymentsEnabled) {
    return { ok: 'skipped', reason: 'preview_deployments_disabled' };
  }

  const existingPreview = await db.query.services.findFirst({
    where: and(
      eq(services.previewParentServiceId, parent.id),
      eq(services.prNumber, pr.prNumber),
    ),
  });

  if (pr.action === 'closed') {
    if (!parent.previewAutoDestroyOnClose || !existingPreview) {
      return { ok: 'skipped', reason: existingPreview ? 'auto_destroy_disabled' : 'no_preview_found' };
    }
    await destroyPreviewService(db, log, existingPreview);
    return { ok: true, action: 'preview_destroyed', prNumber: pr.prNumber, serviceId: existingPreview.id };
  }

  // A verified webhook only proves that the provider sent the event; it
  // does not make a fork's head repository trusted. Preview builds inherit
  // the parent's service-scoped environment, so only same-repository heads
  // may reach the build queue. Validate the ref before persisting it too,
  // because git treats leading-dash refs as command options.
  const branch = gitBranch.safeParse(pr.branch);
  const parentRepository = parent.repoUrl ? repositoryIdentity(parent.repoUrl) : null;
  const previewRepoUrl = pr.repoUrl ?? parent.repoUrl;
  const previewRepository = previewRepoUrl ? repositoryIdentity(previewRepoUrl) : null;
  if (!branch.success || !parentRepository || !previewRepository) {
    return { ok: 'ignored', reason: 'invalid_preview_source' };
  }
  if (previewRepository !== parentRepository) {
    return { ok: 'skipped', reason: 'external_pr_repository' };
  }

  // Previews inherit the parent's build definition, including host-level
  // features (PM2 / compose / hooks) — require the owner's deploy
  // privileges before creating anything or queueing a build.
  await assertWebhookMayDeploy(db, parent);

  // Opened / Synchronize / Reopened
  let targetService = existingPreview;
  // Parent secret env vars deliberately NOT copied into a new preview —
  // PR-supplied code must never receive production credentials.
  let secretsNotInherited = 0;
  // Set when the preview-domain pattern rendered to a host outside the
  // instance's wildcard zone (or an invalid shape): routing is skipped so
  // the preview cannot claim hosts it has no claim to.
  let previewDomainSkipped: string | null = null;
  if (!targetService) {
    // Enforce max active previews cap
    const activePreviews = await db.query.services.findMany({
      where: and(eq(services.previewParentServiceId, parent.id), eq(services.isEphemeralPreview, true)),
      orderBy: [desc(services.id)],
    });
    if (activePreviews.length >= parent.previewMaxActive && activePreviews.length > 0) {
      const oldest = activePreviews[activePreviews.length - 1]!;
      // Same teardown as a PR close — otherwise every cap eviction leaks
      // the preview's bridge network, log files and Traefik route (r036).
      await destroyPreviewService(db, log, oldest);
    }

    const previewSlug = `${parent.slug}-pr-${pr.prNumber}`;
    const [created] = await db
      .insert(services)
      .values({
        ownerUserId: parent.ownerUserId,
        name: `${parent.name} (PR #${pr.prNumber})`,
        slug: previewSlug,
        type: parent.type,
        status: 'idle',
        repoUrl: previewRepoUrl,
        branch: branch.data,
        commitSha: pr.sha,
        sourceId: parent.sourceId,
        image: parent.image,
        volumeMount: null,
        composeService: parent.composeService,
        // A preview of an inline stack deploys the parent's YAML; without
        // this the clone would have `type: 'compose'` and nothing to run.
        composeContent: parent.composeContent,
        port: parent.port,
        healthPath: parent.healthPath,
        cpuShares: parent.cpuShares,
        memLimitMb: parent.memLimitMb,
        isEphemeralPreview: true,
        previewParentServiceId: parent.id,
        prNumber: pr.prNumber,
      })
      .returning()
      // Two concurrent deliveries for the same PR both pass the
      // existingPreview check above; services_slug_unique (migration 0049)
      // lets exactly one insert win. The loser re-loads the winner's row
      // and proceeds idempotently — a 500 here would make the provider
      // redeliver and repeat the race. Other insert failures rethrow.
      .catch((err: unknown) => {
        if (isUniqueViolation(err, /UNIQUE constraint failed.*services\.slug/)) {
          return [] as typeof services.$inferSelect[];
        }
        throw err;
      });
    targetService = created ?? (
      (await db.query.services.findFirst({
        where: and(
          eq(services.previewParentServiceId, parent.id),
          eq(services.prNumber, pr.prNumber),
        ),
      })) ?? undefined
    );

    // Copy parent build config
    const parentBuild = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, parent.id) });
    if (parentBuild && targetService) {
      await db.insert(buildConfigs).values({
        serviceId: targetService.id,
        buildPack: parentBuild.buildPack,
        baseDir: parentBuild.baseDir,
        installCmd: parentBuild.installCmd,
        buildCmd: parentBuild.buildCmd,
        startCmd: parentBuild.startCmd,
        dockerfilePath: parentBuild.dockerfilePath,
        preDeployCmd: parentBuild.preDeployCmd,
        postDeployCmd: parentBuild.postDeployCmd,
        preStopCmd: parentBuild.preStopCmd,
        restartPolicy: parentBuild.restartPolicy,
        stopGraceSeconds: parentBuild.stopGraceSeconds,
      });
    }

    // Copy parent service-scoped env vars
    if (targetService) {
      // Inherit the parent's tag memberships (project + workspace + label)
      // so a preview deploy is visible to the same audiences as the parent.
      const parentTags = await getServiceTags(db, parent.id);
      await replaceServiceTags(
        db,
        targetService.id,
        parentTags.projects.map((p) => p.id),
        parentTags.workspaces.map((w) => w.id),
        parentTags.labels.map((l) => l.id),
      );
      // Preview code arrives from a PR branch, so production secrets must
      // not ride along into it: inherit non-secret configuration only.
      // Values meant for previews live in the parent's preview-only set
      // (`preview_env_vars`), which the pipeline overlays at every
      // preview deploy — they are deliberately not copied here.
      const parentEnvs = await db.query.envVars.findMany({ where: eq(envVars.serviceId, parent.id) });
      for (const env of parentEnvs) {
        if (env.isSecret) {
          secretsNotInherited++;
          continue;
        }
        await db.insert(envVars).values({
          serviceId: targetService.id,
          scope: 'service',
          scopeKey: targetService.id,
          key: env.key,
          valueEncrypted: env.valueEncrypted,
          isSecret: env.isSecret,
        });
      }

      // Provision preview domain. The pattern is member-editable input, so
      // the RENDERED host must be constrained to this instance's own
      // wildcard zone with a strict label shape before it lands in Traefik
      // as an `active` router — an unconstrained pattern like
      // `*.victim.tld` would otherwise claim traffic for hosts nobody
      // verified ownership of (routers match by rendered host/regexp).
      // Rejecting skips ONLY routing; the preview still deploys and serves
      // on its internal port, so a typo'd pattern degrades gracefully.
      // r511: the pattern must also carry {{pr}} and {{slug}} (stored
      // legacy patterns without them skip with
      // `pattern_requires_pr_and_slug`), and the rendered host must not
      // claim another service's automatic domain (r223 own-zone check).
      const pattern = parent.previewDomainPattern || DEFAULT_PREVIEW_DOMAIN_PATTERN;
      const lowerHost = renderPreviewHost(pattern, pr.prNumber, parent.slug);
      let skipReason: string | null = previewHostSkipReason(pattern, lowerHost);
      if (!skipReason && (await ownZoneClaimRefusal(db, targetService.id, lowerHost))) {
        skipReason = 'domain_claims_another_service';
      }

      if (skipReason) {
        previewDomainSkipped = skipReason;
      } else {
        // r065: deduplicate — a concurrent webhook for the same PR number may have
        // already claimed this hostname. Gracefully skip instead of propagating 500.
        try {
          await db.insert(domains).values({
            serviceId: targetService.id,
            hostname: lowerHost,
            path: '/',
            ssl: false,
            // Generated inside the instance's own wildcard zone and held to
            // that zone above, so there is no ownership question — but it
            // must be explicit now that only `active` domains are written
            // into the Traefik config.
            status: 'active',
            verifiedAt: new Date(),
          });
        } catch (err) {
          if (isUniqueViolation(err, /UNIQUE constraint failed.*(domains_host_path_idx|domains\.hostname, domains\.path)/)) {
            previewDomainSkipped = 'domain_conflict_duplicate_hostname';
          } else {
            throw err;
          }
        }
      }
    }
  } else {
    await db.update(services).set({ branch: branch.data, commitSha: pr.sha }).where(eq(services.id, targetService.id));
  }

  if (!targetService) return { ok: 'error', reason: 'failed_to_create_preview' };

  const [dep] = await db
    .insert(deployments)
    .values({
      serviceId: targetService.id,
      status: 'queued',
      trigger: 'webhook',
      commitSha: pr.sha || null,
      message: `PR #${pr.prNumber}: ${pr.title}`,
      author: pr.author || null,
    })
    .returning();

  return {
    ok: true,
    provider,
    action: 'preview_deployment_queued',
    previewServiceId: targetService.id,
    deploymentId: dep?.id,
    prNumber: pr.prNumber,
    // Auditability: an operator diffing the preview env against production
    // should not have to discover the secret-inheritance rule by accident.
    ...(secretsNotInherited > 0 ? { secretsNotInheritedFromParent: secretsNotInherited } : {}),
    ...(previewDomainSkipped ? { previewDomainSkipped } : {}),
  };
}

/**
 * A push to `serviceId`: branch, skip marker, watch paths, the owner's deploy
 * privilege, SHA dedup, then a queued deployment (with the race guard).
 */
export async function handlePush(
  db: DB,
  serviceId: number,
  push: PushEvent,
  opts: { branch: string; watchPaths: string | null; provider: Provider },
): Promise<DispatchResult> {
  if (push.branch !== opts.branch) return { ok: 'skipped', reason: 'branch', branch: push.branch };

  // Skip markers: `[skip ci]` / `[skip cd]` in the head commit message opts
  // this push out of an automatic deploy (matches CI convention).
  if (push.message && /\[skip[ -](ci|cd)\]/i.test(push.message)) {
    return { ok: 'skipped', reason: 'skip_marker' };
  }

  // Watch paths (monorepos): when the webhook defines globs, deploy only if
  // at least one changed file matches. Payloads without file lists (rare)
  // still deploy — never silently block an unverifiable push.
  // GitHub caps the `commits` array at ~20 entries for big pushes, so a list
  // AT the cap may simply not SHOW the watched change (it happened in a
  // commit the payload omitted). A redundant deploy costs minutes; a
  // silently skipped one strands a monorepo team — fail open at the cap.
  const patterns = parseWatchPaths(opts.watchPaths);
  if (patterns.length > 0 && push.changedFiles.length > 0 && push.commitsListed < COMMIT_LIST_CAP) {
    const hit = push.changedFiles.some((f) => matchesAny(f, patterns));
    if (!hit) return { ok: 'skipped', reason: 'watch_paths', patterns: patterns.length };
  }

  // Same privilege gate as a manual redeploy: a verified push event must not
  // restart host-executing service types for tenants whose owner is not an
  // operator.
  const pushedService = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!pushedService) throw notFound('Parent service not found');
  await assertWebhookMayDeploy(db, pushedService);

  // Replay dedup: a captured valid push replays indefinitely (the HMAC covers
  // the body, not freshness). Skip when a deployment for this exact commit is
  // already queued/building/running for the service, so a re-sent payload
  // cannot flood the deploy queue.
  if (push.sha) {
    const existing = await db.query.deployments.findFirst({
      where: and(
        eq(deployments.serviceId, serviceId),
        eq(deployments.commitSha, push.sha),
        inArray(deployments.status, ['queued', 'building', 'running']),
      ),
    });
    if (existing) return { ok: 'skipped', reason: 'duplicate', deploymentId: existing.id };
  }

  const [dep] = await db
    .insert(deployments)
    .values({
      serviceId: serviceId,
      status: 'queued',
      trigger: 'webhook',
      commitSha: push.sha || null,
      message: push.message || null,
      author: push.author || null,
    })
    .returning();
  // The check-then-insert above races under concurrent duplicate deliveries
  // (no unique index covers service+sha+status). Post-hoc guard: if another
  // active deployment for the same commit won, drop ours.
  if (dep && push.sha) {
    const dups = await db.query.deployments.findMany({
      where: and(
        eq(deployments.serviceId, serviceId),
        eq(deployments.commitSha, push.sha),
        inArray(deployments.status, ['queued', 'building', 'running']),
      ),
    });
    const other = dups.filter((d) => d.id !== dep.id).sort((a, b) => a.id - b.id)[0];
    // Keep the lowest id (both racers converge on the same winner).
    if (other && other.id < dep.id) {
      await db.delete(deployments).where(eq(deployments.id, dep.id));
      return { ok: 'skipped', reason: 'duplicate', deploymentId: other.id };
    }
  }
  // r070: after a push-triggered deploy, sync the service row so the UI shows
  // the current branch immediately without waiting for the deploy to finish.
  // commitSha deliberately stays UNTOUCHED here: it is the SHA of the code
  // actually running, and the pipeline stamps it on SUCCESS
  // (engine/pipeline.ts success finalize). Writing it up-front would make a
  // failed build report a "current" commit that was never deployed.
  await db
    .update(services)
    .set({ branch: push.branch.replace(/^refs\/heads\//, '') })
    .where(eq(services.id, serviceId));
  return { ok: true, provider: opts.provider, deploymentId: dep!.id };
}
