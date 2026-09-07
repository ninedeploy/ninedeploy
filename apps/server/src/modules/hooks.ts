import { and, desc, eq, inArray } from 'drizzle-orm';
import { buildConfigs, deployments, domains, envVars, services, webhooks, type DB } from '@ninedeploy/db';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { gitBranch, gitRepoUrl, webhookCreate } from '@ninedeploy/schemas';
import { config } from '../config.js';
import { decrypt, encrypt, randomToken } from '../lib/crypto.js';
import { matchesAny, parseWatchPaths } from '../lib/glob.js';
import { parseId, notFound, unauthorized } from '../lib/errors.js';
import { isPing, isPullRequest, isReplayedDelivery, parsePullRequest, parsePush, verifyWebhook } from '../lib/webhooks.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertMayDeployStoredService } from '../lib/hostPrivilege.js';
import { isOperator } from '../lib/resourceAccess.js';

/** GitHub caps the push payload's `commits` array at this size; a list at the
 *  cap may be truncated, so watch-path filtering fails open (see below). */
const COMMIT_LIST_CAP = 20;
import { dockerBuilder } from '../engine/builders/docker.js';
import { pm2Builder } from '../engine/builders/pm2.js';
import { composeBuilder } from '../engine/builders/compose.js';
import { deleteLog } from '../engine/logs.js';
import { removeServiceBridgeIfEmpty } from '../lib/serviceBridge.js';
import { writeDynamicConfig, getAcmeEmail } from '../engine/proxy.js';
import { getSettingString } from '../lib/settings.js';
import { getServiceTags, replaceServiceTags } from './serviceTags.js';

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
function repositoryIdentity(raw: string): string | null {
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
async function assertWebhookMayDeploy(
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
async function destroyPreviewService(
  db: DB,
  log: FastifyBaseLogger,
  preview: { id: number; slug: string; runtimeId: string | null; type: string },
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
}

/** Public webhook receiver — auto-deploys on verified provider push & PR events. */
export const hookReceiveRoutes: FastifyPluginAsync = async (app) => {
  // Public endpoint (auth bypassed, verified by HMAC) — cap flood attempts.
  app.post('/:id', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    // Public receiver: leave non-numeric ids as NaN so they 404 ("Unknown
    // webhook") rather than 400 — don't reveal param validation to probers.
    const id = Number((req.params as { id: string }).id);
    const hook = await app.db.query.webhooks.findFirst({ where: eq(webhooks.id, id) });
    if (!hook?.active) throw notFound('Unknown webhook');

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const secret = decrypt(hook.secretEncrypted);
    const provider = verifyWebhook(req.headers, rawBody, secret);
    if (!provider) throw unauthorized('Invalid webhook signature');

    if (isPing(req.headers, provider)) return { ok: 'pong' };

    // A replayed (captured-then-replayed) delivery must not redeploy an old
    // commit once the SHA dedup has expired. Checked AFTER the HMAC so only
    // authenticated deliveries consume dedup slots. Absent delivery ids fail
    // open (isReplayedDelivery) — the signature remains authoritative.
    if (isReplayedDelivery(req.headers, provider)) {
      return { ok: 'ignored', reason: 'replayed_delivery' };
    }

    // ── Ephemeral PR / MR Preview Deployments ──────────────────────────────────
    if (isPullRequest(req.headers, provider)) {
      const pr = parsePullRequest(req.body, provider);
      if (!pr) return { ok: 'ignored', reason: 'not_a_valid_pr' };

      const parent = await app.db.query.services.findFirst({ where: eq(services.id, hook.serviceId) });
      if (!parent) throw notFound('Parent service not found');
      if (!parent.previewDeploymentsEnabled) {
        return { ok: 'skipped', reason: 'preview_deployments_disabled' };
      }

      const existingPreview = await app.db.query.services.findFirst({
        where: and(
          eq(services.previewParentServiceId, parent.id),
          eq(services.prNumber, pr.prNumber),
        ),
      });

      if (pr.action === 'closed') {
        if (!parent.previewAutoDestroyOnClose || !existingPreview) {
          return { ok: 'skipped', reason: existingPreview ? 'auto_destroy_disabled' : 'no_preview_found' };
        }
        await destroyPreviewService(app.db, req.log, existingPreview);
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
      await assertWebhookMayDeploy(app.db, parent);

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
        const activePreviews = await app.db.query.services.findMany({
          where: and(eq(services.previewParentServiceId, parent.id), eq(services.isEphemeralPreview, true)),
          orderBy: [desc(services.id)],
        });
        if (activePreviews.length >= parent.previewMaxActive && activePreviews.length > 0) {
          const oldest = activePreviews[activePreviews.length - 1]!;
          // Same teardown as a PR close — otherwise every cap eviction leaks
          // the preview's bridge network, log files and Traefik route (r036).
          await destroyPreviewService(app.db, req.log, oldest);
        }

        const previewSlug = `${parent.slug}-pr-${pr.prNumber}`;
        const [created] = await app.db
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
            if (err instanceof Error && /UNIQUE constraint failed.*services\.slug/.test(err.message)) {
              return [] as typeof services.$inferSelect[];
            }
            throw err;
          });
        targetService = created ?? (
          (await app.db.query.services.findFirst({
            where: and(
              eq(services.previewParentServiceId, parent.id),
              eq(services.prNumber, pr.prNumber),
            ),
          })) ?? undefined
        );

        // Copy parent build config
        const parentBuild = await app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, parent.id) });
        if (parentBuild && targetService) {
          await app.db.insert(buildConfigs).values({
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
          const parentTags = await getServiceTags(app.db, parent.id);
          await replaceServiceTags(
            app.db,
            targetService.id,
            parentTags.projects.map((p) => p.id),
            parentTags.workspaces.map((w) => w.id),
            parentTags.labels.map((l) => l.id),
          );
          // Preview code arrives from a PR branch, so production secrets must
          // not ride along into it: inherit non-secret configuration only.
          const parentEnvs = await app.db.query.envVars.findMany({ where: eq(envVars.serviceId, parent.id) });
          for (const env of parentEnvs) {
            if (env.isSecret) {
              secretsNotInherited++;
              continue;
            }
            await app.db.insert(envVars).values({
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
          const baseDomain = config.wildcardDomain || 'localhost';
          const pattern = parent.previewDomainPattern || 'pr-{{pr}}-{{slug}}.{{domain}}';
          const rendered = pattern
            .replace(/\{\{pr\}\}/g, String(pr.prNumber))
            .replace(/\{\{slug\}\}/g, parent.slug)
            .replace(/\{\{domain\}\}/g, baseDomain);
          const lowerHost = rendered.trim().toLowerCase();
          const zone = `.${baseDomain.toLowerCase()}`;
          let skipReason: string | null = null;
          if (!lowerHost.endsWith(zone)) skipReason = 'pattern_outside_wildcard_zone';
          else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(lowerHost))
            skipReason = 'invalid_hostname_shape';

          if (skipReason) {
            previewDomainSkipped = skipReason;
          } else {
            // r065: deduplicate — a concurrent webhook for the same PR number may have
            // already claimed this hostname. Gracefully skip instead of propagating 500.
            try {
              await app.db.insert(domains).values({
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
              if (
                err instanceof Error &&
                /UNIQUE constraint failed.*domains_host_path_idx/.test(err.message)
              ) {
                previewDomainSkipped = 'domain_conflict_duplicate_hostname';
              } else {
                throw err;
              }
            }
          }
        }
      } else {
        await app.db.update(services).set({ branch: branch.data, commitSha: pr.sha }).where(eq(services.id, targetService.id));
      }

      if (!targetService) return { ok: 'error', reason: 'failed_to_create_preview' };

      const [dep] = await app.db
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

    // ── Standard Push Webhook ──────────────────────────────────────────────────
    const push = parsePush(req.body, provider);
    if (!push) return { ok: 'ignored', reason: 'not_a_push' };

    if (push.branch !== hook.branch) return { ok: 'skipped', reason: 'branch', branch: push.branch };

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
    const patterns = parseWatchPaths(hook.watchPaths);
    if (patterns.length > 0 && push.changedFiles.length > 0 && push.commitsListed < COMMIT_LIST_CAP) {
      const hit = push.changedFiles.some((f) => matchesAny(f, patterns));
      if (!hit) return { ok: 'skipped', reason: 'watch_paths', patterns: patterns.length };
    }

    // Same privilege gate as a manual redeploy: a verified push event must not
    // restart host-executing service types for tenants whose owner is not an
    // operator.
    const pushedService = await app.db.query.services.findFirst({ where: eq(services.id, hook.serviceId) });
    if (!pushedService) throw notFound('Parent service not found');
    await assertWebhookMayDeploy(app.db, pushedService);

    // Replay dedup: a captured valid push replays indefinitely (the HMAC covers
    // the body, not freshness). Skip when a deployment for this exact commit is
    // already queued/building/running for the service, so a re-sent payload
    // cannot flood the deploy queue.
    if (push.sha) {
      const existing = await app.db.query.deployments.findFirst({
        where: and(
          eq(deployments.serviceId, hook.serviceId),
          eq(deployments.commitSha, push.sha),
          inArray(deployments.status, ['queued', 'building', 'running']),
        ),
      });
      if (existing) return { ok: 'skipped', reason: 'duplicate', deploymentId: existing.id };
    }

    const [dep] = await app.db
      .insert(deployments)
      .values({
        serviceId: hook.serviceId,
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
      const dups = await app.db.query.deployments.findMany({
        where: and(
          eq(deployments.serviceId, hook.serviceId),
          eq(deployments.commitSha, push.sha),
          inArray(deployments.status, ['queued', 'building', 'running']),
        ),
      });
      const other = dups.filter((d) => d.id !== dep.id).sort((a, b) => a.id - b.id)[0];
      // Keep the lowest id (both racers converge on the same winner).
      if (other && other.id < dep.id) {
        await app.db.delete(deployments).where(eq(deployments.id, dep.id));
        return { ok: 'skipped', reason: 'duplicate', deploymentId: other.id };
      }
    }
    // r070: after a push-triggered deploy, sync the service row so the UI shows
    // the current branch + sha immediately without waiting for the deploy to finish.
    await app.db
      .update(services)
      .set({ branch: push.branch.replace(/^refs\/heads\//, ''), commitSha: push.sha || pushedService.commitSha })
      .where(eq(services.id, hook.serviceId));
    return { ok: true, provider, deploymentId: dep!.id };
  });
};

/** Authed webhook management for a service. Mounted under /services. */
export const webhookMgmtRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/webhooks', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const rows = await app.db.query.webhooks.findMany({ where: eq(webhooks.serviceId, id) });
    const origin = await panelOrigin(app.db);
    return rows.map((w) => ({
      id: w.id,
      branch: w.branch,
      active: w.active,
      watchPaths: w.watchPaths ?? '',
      sourceId: w.sourceId ?? null,
      url: `${origin}/v1/hooks/${w.id}`,
      createdAt: w.createdAt.toISOString(),
    }));
  });

  app.post('/:id/webhooks', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = webhookCreate.parse(req.body ?? {});
    const svc = await loadServiceForUser(app.db, id, req.user!);
    const branch = input.branch?.trim() || svc.branch;
    const secret = randomToken(24);
    // Inherit the parent service's sourceId so the webhook record matches the
    // credential the deploy pipeline will use (a multi-source instance can now
    // disambiguate which credential backs which webhook — useful in admin
    // diagnostics and any future "re-issue secret under a different token" flow).
    const [w] = await app.db
      .insert(webhooks)
      .values({
        serviceId: id,
        sourceId: svc.sourceId,
        branch,
        watchPaths: input.watchPaths?.trim() || null,
        secretEncrypted: encrypt(secret),
        active: true,
      })
      .returning();
    // The raw secret is returned exactly once.
    return { id: w!.id, branch: w!.branch, active: w!.active, sourceId: w!.sourceId, url: await webhookUrl(app.db, w!.id), secret };
  });

  app.delete('/:id/webhooks/:hookId', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const hookId = parseId((req.params as { hookId: string }).hookId);
    await loadServiceForUser(app.db, id, req.user!);
    await app.db.delete(webhooks).where(and(eq(webhooks.id, hookId), eq(webhooks.serviceId, id)));
    return { ok: true };
  });
};

/**
 * Webhook URLs are pasted into GitHub/GitLab by the operator, so they must
 * point at the address the panel is actually reachable on. The
 * Settings→Security "panel domain" (or NINEDEPLOY_DOMAIN) is that runtime
 * truth; NINEDEPLOY_PUBLIC_URL defaults to http://localhost:3000 and would
 * otherwise leak a localhost URL into every copied hook. Scheme mirrors the
 * Traefik panel router: TLS only when an ACME email is configured.
 */
async function panelOrigin(db: DB): Promise<string> {
  let host = '';
  try {
    host = String((await getSettingString(db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? '')
      .replace(/[^A-Za-z0-9.\-*]/g, '')
      .replace(/^\.+|\.+$/g, '');
  } catch {
    host = '';
  }
  if (!host || host === '*' || host.startsWith('.')) return config.publicUrl;
  const tls = await getAcmeEmail(db).catch(() => config.acmeEmail);
  return `${tls ? 'https' : 'http'}://${host}`;
}

async function webhookUrl(db: DB, id: number): Promise<string> {
  return `${await panelOrigin(db)}/v1/hooks/${id}`;
}
