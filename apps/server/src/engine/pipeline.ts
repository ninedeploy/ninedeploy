import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, lt, ne } from 'drizzle-orm';
import { buildConfigs, databaseAttachments, databases, type DB, deployments, domains, envVars, projects, services, serviceProjects, serviceVolumeAttachments, sources, workspaceMembers } from '@ninedeploy/db';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { checkoutCommit, type CloneCreds } from '../lib/git.js';
import { materialiseComposeFile } from '../lib/composeWorkspace.js';
import { remoteDeploySupported, remoteDeployUnsupportedReason } from '../lib/remoteDeploy.js';
import { agentOp } from '../lib/agentClient.js';
import { createRemoteDockerBuilder } from './builders/remoteDocker.js';
import { createRemoteComposeBuilder } from './builders/remoteCompose.js';
import { analyzeRepo, summarizeInsights } from '../lib/frameworks.js';
import { upsertInsights } from './repoInsights.js';
import { connectionString, ENGINES } from './database.js';
import { dockerBuilder } from './builders/docker.js';
import { composeBuilder } from './builders/compose.js';
import { logBus } from './logs.js';
import { pm2Builder } from './builders/pm2.js';
import { getAcmeEmail, writeDynamicConfig } from './proxy.js';
import { run, sleep } from '../lib/exec.js';
import { resolveVaultRefs } from '../lib/vault.js';
import { isOperator, roleAtLeast } from '../lib/resourceAccess.js';
import { getBundledTemplates } from '../templates/registry.js';
import type { BuildContext, Builder, DeployRuntime } from './types.js';
import { reconcileTemplateDependencies } from './templateDependencies.js';
import { applyManifestToService } from '../lib/applyManifestToService.js';
import { audit } from '../lib/audit.js';
import { loadNinedeployManifest } from '../lib/ninedeployManifest.js';
import { applyManifestToBuildConfig, findMissingRequiredEnv } from '../lib/ninedeployApply.js';
import type { NinedeployManifest } from '@ninedeploy/schemas';

const builders: Record<string, Builder> = { docker: dockerBuilder, pm2: pm2Builder, compose: composeBuilder };
const DEPLOY_HEARTBEAT_MS = 20_000;

/**
 * Short stable fingerprint per resolved managed-database env value. Stored on
 * each deployment row (inside `configSnapshot.managedEnv`) so the NEXT deploy
 * can detect value drift — e.g. the database attachment was re-pointed or its
 * password rotated. Drift itself is legitimate, but config-once images
 * (WordPress et al.) keep serving a `wp-config.php` written from the OLD
 * values inside their persistent volume, and only this warning surfaces why
 * they suddenly cannot reach "their" database after an otherwise-green deploy.
 */
export function managedEnvFingerprint(values: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const v = values[key];
    if (v !== undefined) out[key] = createHash('sha256').update(v).digest('hex').slice(0, 16);
  }
  return out;
}

/**
 * History hygiene: exactly ONE deployment per service may read `running` —
 * the build currently serving traffic. Success finalize used to archive
 * nothing, so the Deploys tab listed every past deploy as Running forever;
 * a hard kill mid-chain could strand the same lie. Called at boot: per
 * service keep the newest running row only while the SERVICE is actually
 * running; demote everything else to `superseded`. Returns the count.
 */
export async function reconcileDeploymentHistory(db: DB): Promise<number> {
  const running = await db.select().from(deployments).where(eq(deployments.status, 'running'));
  if (running.length === 0) return 0;

  // Newest running row per service (highest id wins the claim).
  const newestByService = new Map<number, number>();
  for (const r of running) {
    const cur = newestByService.get(r.serviceId);
    if (cur === undefined || r.id > cur) newestByService.set(r.serviceId, r.id);
  }

  const svcRows = await db
    .select({ id: services.id, status: services.status })
    .from(services)
    .where(inArray(services.id, [...newestByService.keys()]));
  const liveServices = new Set(svcRows.filter((s) => s.status === 'running').map((s) => s.id));

  const supersededIds: number[] = [];
  for (const [serviceId, keepId] of newestByService) {
    const live = liveServices.has(serviceId);
    for (const r of running.filter((x) => x.serviceId === serviceId && (!live || x.id !== keepId))) {
      supersededIds.push(r.id);
    }
  }
  if (supersededIds.length > 0) {
    await db.update(deployments).set({ status: 'superseded' }).where(inArray(deployments.id, supersededIds));
  }
  return supersededIds.length;
}

/** Execute a lifecycle hook command in the service workDir with resolved environment. */
async function runHook(cmd: string, cwd: string, env: Record<string, string>, log: (line: string) => void): Promise<void> {
  const [bin, ...args] = cmd.trim().split(/\s+/);
  if (!bin) return;
  // Hooks must be usable from EVERY service shape — including pure-image
  // deploys that never run a git checkout. Without this the very first
  // hook died on ENOENT against a not-yet-created repo directory.
  mkdirSync(cwd, { recursive: true });
  await run(
    bin,
    args,
    { cwd, env, heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Running deployment hook (${bin})` },
    log,
  );
}

/** Render any thrown value as a single-line message (handles non-Error rejections). */
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Thrown at pipeline checkpoints when the deployment was cancelled mid-flight. */
class DeploymentCancelled extends Error {
  constructor() {
    super('Deployment cancelled');
  }
}

/** Re-read the deployment row — a cancel route may have flipped it mid-flight. */
async function isCancelled(db: DB, deploymentId: number): Promise<boolean> {
  const row = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
  if (!row) {
    // The remove route only deletes terminal rows, so a row that vanished under
    // a RUNNING pipeline is a cancel-then-remove: the operator cancelled the
    // deploy (flipping the row terminal) and deleted it before this pipeline
    // reached its next checkpoint. Without treating absence as cancelled, the
    // zombie pipeline runs to completion — holding its concurrency slot,
    // stalling every queued deploy behind it, and overwriting the service row
    // on finalize — with no way left to stop it.
    return true;
  }
  return row.status === 'cancelled';
}

/** Collect runtime env vars: shared project env ← service env ← attached-database
 * connection strings (later wins), then resolve `${{provider:KEY}}` vault refs. */
type RuntimeEnvironment = {
  values: Record<string, string>;
  attachmentCount: number;
  readyAttachmentCount: number;
  managedDatabaseKeys: string[];
};

/**
 * Defence-in-depth behind the tag routes: a `service_projects` link only
 * injects a project's shared env into this service when the service's owner
 * is an instance operator or a member of the project's workspace — the same
 * decision `visibleProjectIds` enforces at the route layer. The routes guard
 * every write today, but a link written before that guard existed (or by a
 * future writer that forgets it) would otherwise have the pipeline decrypt
 * another tenant's shared env straight into a container, so the sink verifies
 * the chain itself. NULL-workspace projects are operator-only
 * (see resourceAccess.ts) and resolve to nothing here.
 */
export async function filterTrustworthyProjectLinks(
  db: DB,
  service: Pick<typeof services.$inferSelect, 'ownerUserId'>,
  links: Array<{ projectId: number }>,
): Promise<Array<{ projectId: number }>> {
  const ownerId = service.ownerUserId;
  // No owner at all: there is nobody whose membership could authorize the
  // links, so none of them may inject shared env.
  if (ownerId == null) return [];
  if (await isOperator(db, { id: ownerId })) return links;
  const kept: Array<{ projectId: number }> = [];
  for (const link of links) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, link.projectId) });
    if (!project || project.workspaceId == null) continue;
    const seat = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.userId, ownerId),
        eq(workspaceMembers.workspaceId, project.workspaceId),
      ),
    });
    // A seat alone is not enough (r095): a `viewer` is read-only and the API
    // masks secret values from them, so a link from a viewer-seat owner must
    // not decrypt the project's shared env into a container they control.
    if (seat && roleAtLeast(seat.role, 'member')) kept.push(link);
  }
  return kept;
}

async function loadRuntimeEnv(db: DB, service: typeof services.$inferSelect): Promise<RuntimeEnvironment> {
  const env: Record<string, string> = {};
  const managedDatabaseKeys = new Set<string>();

  // Project-scope shared env (lowest precedence). Services now carry N-N
  // project links via `service_projects`; the env lookup is the union of every
  // linked project's `env_vars` (scope='project').
  const projectLinks = await filterTrustworthyProjectLinks(
    db,
    service,
    await db.query.serviceProjects.findMany({
      where: eq(serviceProjects.serviceId, service.id),
    }),
  );
  if (projectLinks.length > 0) {
    const shared = await db.query.envVars.findMany({
      where: and(
        eq(envVars.scope, 'project'),
        inArray(envVars.scopeKey, projectLinks.map((p) => p.projectId)),
      ),
    });
    for (const r of shared) env[r.key] = decrypt(r.valueEncrypted);
  }

  // Service-scope env overrides shared values.
  const rows = await db.query.envVars.findMany({ where: eq(envVars.serviceId, service.id) });
  for (const r of rows) env[r.key] = decrypt(r.valueEncrypted);

  const attaches = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, service.id) });
  let readyAttachmentCount = 0;
  for (const a of attaches) {
    const d = await db.query.databases.findFirst({ where: eq(databases.id, a.databaseId) });
    if (d && d.status === 'running') {
      readyAttachmentCount++;
      // Services created by an older or interrupted Hub flow may have a valid
      // attachment but a missing persisted mapping. Recover the trusted
      // built-in contract from the exact image/port/volume/database signature
      // instead of silently falling back to a generic URL the app may ignore.
      const bundledMapping = getBundledTemplates().find((template) =>
        template.image === service.image
        && template.port === service.port
        && (template.volumeMount ?? null) === (service.volumeMount ?? null)
        && template.dbEngine === d.engine
      )?.databaseEnv;
      const mapping = bundledMapping ?? service.templateDatabaseEnv;
      if (!mapping || Object.keys(mapping).length === 0) {
        env[a.envAlias] = connectionString(d);
        managedDatabaseKeys.add(a.envAlias);
        continue;
      }
      const cfg = ENGINES[d.engine];
      if (!cfg) continue;
      const host = d.internalHost ?? d.containerName ?? '';
      const port = d.internalPort ?? cfg.port;
      const username = cfg.username() ?? d.username ?? '';
      const password = d.passwordEncrypted ? decrypt(d.passwordEncrypted) : '';
      const database = cfg.dbName() ?? d.dbName ?? '';
      const values: Record<'url' | 'host' | 'hostPort' | 'port' | 'username' | 'password' | 'database', string> = {
        url: connectionString(d),
        host,
        hostPort: `${host}:${port}`,
        port: String(port),
        username,
        password,
        database,
      };
      for (const [key, source] of Object.entries(mapping)) {
        env[key] = values[source];
        managedDatabaseKeys.add(key);
      }
    }
  }

  // Vault references resolve last, from the fully-merged map.
  return {
    values: await resolveVaultRefs(db, env),
    attachmentCount: attaches.length,
    readyAttachmentCount,
    managedDatabaseKeys: [...managedDatabaseKeys].sort(),
  };
}

/**
 * Resolve private-registry credentials for a service: when the service's
 * source is a registry-type source with a token, image pulls authenticate
 * with (registryUsername, token). The registry host defaults to the image's
 * own namespace (e.g. ghcr.io/...) or the Docker Hub default.
 */
async function loadRegistryAuth(
  db: DB,
  service: typeof services.$inferSelect,
): Promise<{ username: string; password: string; server?: string } | undefined> {
  if (!service.sourceId || !service.image) return undefined;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, service.sourceId) });
  if (src?.type !== 'registry') return undefined;
  const username = src.registryUsername ?? '';
  const password = src.tokenEncrypted ? decrypt(src.tokenEncrypted) : '';
  if (!username || !password) return undefined;
  // The first path segment of namespaced images (ghcr.io/org/app) is the
  // registry host; bare names (nginx:latest) use the Docker Hub default.
  const parts = service.image.split('/');
  const first = parts.length > 1 ? parts[0]! : '';
  const isHost = first.includes('.') || first.includes(':');
  const server = first !== '' && isHost ? first : undefined;
  return { username, password, server };
}

/**
 * Mark a deployment failed and the service errored — without throwing. A DB
 * error during failure handling must never propagate (it would leave the worker
 * tick in a broken state and the deployment stuck in `building`).
 */
async function safeFail(db: DB, deploymentId: number, serviceId: number, runtimeId: string | null): Promise<void> {
  try {
    await db.update(deployments).set({ status: 'failed', finishedAt: new Date() }).where(eq(deployments.id, deploymentId));
  } catch (err) {
    logBus.publish(deploymentId, `failed to mark deployment failed: ${msg(err)}`);
  }
  try {
    await db.update(services).set({ status: 'error', runtimeId }).where(eq(services.id, serviceId));
  } catch (err) {
    logBus.publish(deploymentId, `failed to mark service errored: ${msg(err)}`);
  }
}

/**
 * Record the OUTCOME of a deploy on the audit stream.
 *
 * `deploy.trigger` is written by the route when the deployment is queued, and
 * until now that was the ONLY deploy action anything emitted — the pipeline
 * finished, successfully or not, in silence. Three consumers hang off `audit()`
 * and all three were blind to the result an operator actually cares about:
 *
 *   • `lib/notifier.notifyEvent` — every Slack/Telegram/webhook/email channel,
 *     so a failed production deploy notified nobody;
 *   • the `/v1/events` socket behind the panel's live activity feed, which
 *     showed a deploy starting and never finishing;
 *   • `kernel/auditBridge`, whose `deployment.status_changed` could therefore
 *     only ever carry `trigger`/`rollback`/`cancel`. The built-in plugins that
 *     ship enabled listen for a deploy RESULT and never saw one.
 *
 * The actor is the service OWNER rather than `null` on purpose: `canReceiveEvent`
 * treats a null actor as a system event and delivers it to operators only, which
 * would hide a member's own deploy result from them.
 *
 * Best-effort by construction — `audit()` swallows its own failures, and this is
 * awaited only so the notification dispatch is started before the worker moves
 * on to the next tick.
 */
async function auditOutcome(
  db: DB,
  service: typeof services.$inferSelect,
  deploymentId: number,
  outcome: 'success' | 'failed' | 'cancelled',
  reason?: string,
): Promise<void> {
  // `name #id` is the entity shape `kernel/auditBridge` parses back into
  // { serviceName, deploymentId }.
  await audit(
    db,
    service.ownerUserId ?? null,
    `deploy.${outcome}`,
    `${service.name} #${deploymentId}`,
    // serviceId powers the per-service notification subscriptions (the
    // manifest's `notifications` rules) — the deploy outcome is exactly the
    // event class those rules exist for.
    { ...(reason ? { reason: reason.slice(0, 500) } : {}), serviceId: service.id },
  );
}

/**
 * Snapshot the effective build config + env key fingerprint for this deploy —
 * stored on the deployment row and diffed against the previous deployment to
 * answer "what changed between these two deploys?". Values are never included
 * (secrets); only key names + flags.
 */
async function snapshotConfig(
  db: DB,
  service: typeof services.$inferSelect,
  buildConfig: typeof buildConfigs.$inferSelect | undefined,
): Promise<string> {
  const envRows = await db.query.envVars.findMany({ where: eq(envVars.serviceId, service.id) });
  return JSON.stringify({
    buildPack: buildConfig?.buildPack ?? 'auto',
    baseDir: buildConfig?.baseDir ?? '/',
    installCmd: buildConfig?.installCmd ?? null,
    buildCmd: buildConfig?.buildCmd ?? null,
    startCmd: buildConfig?.startCmd ?? null,
    dockerfilePath: buildConfig?.dockerfilePath ?? null,
    preDeployCmd: buildConfig?.preDeployCmd ?? null,
    postDeployCmd: buildConfig?.postDeployCmd ?? null,
    preStopCmd: buildConfig?.preStopCmd ?? null,
    restartPolicy: buildConfig?.restartPolicy ?? 'unless-stopped',
    stopGraceSeconds: buildConfig?.stopGraceSeconds ?? 5,
    image: service.image ?? null,
    port: service.port ?? null,
    envKeys: envRows.map((r) => `${r.key}${r.isSecret ? '*' : ''}`).sort(),
  });
}

/** Run the full deploy pipeline for one deployment row. */
export async function runDeployment(
  db: DB,
  deploymentId: number,
  kernelCtx?: {
    useBuildKit: boolean;
    buildCache?: import('../kernel/types.js').IBuildCache;
    onBuildCacheEvent?: (event: import('./builders/buildkit.js').BuildCacheEvent) => void;
  },
): Promise<void> {
  const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
  if (!dep) return;
  const service = await db.query.services.findFirst({ where: eq(services.id, dep.serviceId) });
  if (!service) return;
  const buildConfig = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, service.id) });
  const configSnapshot = await snapshotConfig(db, service, buildConfig);

  const log = (line: string) => logBus.publish(deploymentId, line);
  await db
    .update(deployments)
    .set({ status: 'building', startedAt: new Date(), configSnapshot })
    .where(eq(deployments.id, deploymentId));
  await db.update(services).set({ status: 'deploying' }).where(eq(services.id, service.id));
  log(`▶ Deployment #${deploymentId} for "${service.name}" (${service.type})`);

  // Remote-server deploys route through the node's agent (r037). Everything
  // this builder cannot honestly do on a node — PM2, Compose, and Nixpacks
  // source builds — is refused here with a reason naming the limit, because a
  // deploy that lands on the panel host while the panel reports the node is
  // strictly worse than a failed deployment you can read.
  //
  // This is the choke point every deployment passes through — webhooks,
  // previews, rollbacks, scheduled jobs and the panel button all end up here —
  // so the decision lives here rather than in each queue path (the routes add a
  // friendlier upfront 400 on top).
  let builder = builders[service.type];
  if (service.serverId != null) {
    const serverId = service.serverId;
    if (!remoteDeploySupported(service.type)) {
      const reason = remoteDeployUnsupportedReason(service.type);
      log(`✗ ${reason}`);
      await safeFail(db, deploymentId, service.id, service.runtimeId);
      await auditOutcome(db, service, deploymentId, 'failed', reason);
      return;
    }
    const call = (op: string, params: Record<string, unknown>, sink: (line: string) => void) =>
      agentOp(db, serverId, op, params, sink);
    builder = service.type === 'compose' ? createRemoteComposeBuilder(call) : createRemoteDockerBuilder(call);
  }
  if (!builder) {
    log(`✗ Unknown service type: ${service.type}`);
    await safeFail(db, deploymentId, service.id, service.runtimeId);
    await auditOutcome(db, service, deploymentId, 'failed', `Unknown service type: ${service.type}`);
    return;
  }

  const workDir = path.join(config.paths.reposDir, String(service.id));

  // The currently-running runtime, if any. For Docker blue-green it keeps
  // serving traffic until the new container is healthy; for PM2 it is stopped
  // inside buildAndRun before the new one starts.
  const previous: DeployRuntime | undefined = service.runtimeId
    ? { runtimeId: service.runtimeId, port: service.port ?? null, healthPath: service.healthPath ?? '/' }
    : undefined;

  let runtime: DeployRuntime | undefined;
  // Resolved commit SHA (empty for image deploys). Lifted out of the try so the
  // success path (which persists it onto the service row) can read it.
  let sha = '';
  // The repo's `.ninedeploy`, when it ships one. Loaded during PREPARE and
  // consumed by the BUILD stage (see `applyManifestToBuildConfig` below).
  let manifest: NinedeployManifest | undefined;
  // Fingerprint of the resolved managed-database env values — filled once the
  // runtime env is built inside the try; consumed by the success finalize.
  let managedFp: Record<string, string> = {};
  try {
    // Cancel checkpoint: the route may have flipped the row between claim and here.
    if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();

    log('##[stage:PREPARE:running] Resolving repository, sources and workspace');
    // Image-based deploys and inline compose stacks skip git entirely;
    // repo-based deploys resolve creds + checkout.
    if (service.composeContent) {
      // `services.composeContent` is the source of truth for an inline stack,
      // so the workspace file is rewritten from it on EVERY deploy: a rollback,
      // a manually edited file or a wiped workspace all repair themselves here
      // instead of deploying something the panel never showed.
      materialiseComposeFile(service.id, service.composeContent);
      log(`Inline compose stack (${service.composeContent.length} bytes) written to the workspace`);
    } else if (service.image) {
      log(`Image deploy from ${service.image}`);
    } else {
      let creds: CloneCreds | undefined;
      if (service.sourceId) {
        const src = await db.query.sources.findFirst({ where: eq(sources.id, service.sourceId) });
        if (src) {
          creds = {
            type: src.type,
            token: src.tokenEncrypted ? decrypt(src.tokenEncrypted) : undefined,
            deployKey: src.deployKeyEncrypted ? decrypt(src.deployKeyEncrypted) : undefined,
          };
        }
      }
      try {
        sha = await checkoutCommit(service.repoUrl ?? '', service.branch, dep.commitSha ?? undefined, workDir, log, creds);
      } catch (err) {
        // The clone error itself is often a bare "repository not found" —
        // git says that for BOTH a nonexistent repo and a private one read
        // anonymously. Say which fix applies to THIS service's setup.
        log(`✗ Clone failed: ${msg(err)}`);
        if (!creds) {
          log('hint: no Git credential is attached to this service. If the repository is PRIVATE, attach one: System → Sources (PAT or generate a deploy key), then select it under Service → Settings → Git credential and redeploy. Public repos need no credential.');
        } else if (creds.deployKey && !creds.token) {
          log('hint: cloning used this source\u2019s SSH deploy key. Confirm the PUBLIC key is registered as a deploy key on the provider (repo → Settings → Deploy keys, read access is enough) and that the repo URL is reachable over SSH.');
        } else if (creds.token) {
          log('hint: cloning used the source\u2019s access token. Check that the token is still valid and has read access to this repository (System → Sources → Test).');
        }
        throw err;
      }
      await db.update(deployments).set({ commitSha: sha }).where(eq(deployments.id, deploymentId));

      // Framework analysis powers the service-detail cards and gives the deploy
      // log a human-readable "what is this repo" line. Best-effort by design —
      // a detection hiccup must never fail the deploy itself.
      try {
        const insights = analyzeRepo(workDir, buildConfig?.baseDir, sha);
        await upsertInsights(db, service.id, insights);
        log(summarizeInsights(insights));
      } catch (err) {
        log(`warning: repository analysis failed: ${msg(err)}`);
      }

      // `.ninedeploy` operational side: after a successful checkout, push the
      // manifest's routes/database/alerts into the service config so the panel
      // reflects what the repo declares. Idempotent — re-running an unchanged
      // manifest is a no-op. Best-effort: a stale manifest must never fail
      // the deploy itself.
      //
      // The manifest itself is kept in `manifest` so the BUILD stage below can
      // fold in `build`/`resources`/`run` and hand `runtime`/`phases` to the
      // Nixpacks generator. Before 0.3.5 only the operational sections were
      // applied and every build-shaping section was parsed, validated, offered
      // in the Manifest Creator — and then silently ignored.
      try {
        const loaded = loadNinedeployManifest(workDir);
        if (loaded) {
          manifest = loaded.manifest;
          log(
            `📋 .ninedeploy loaded (${loaded.relativePath}) — applying operational sections`,
          );
          const applyResult = await applyManifestToService(db, service.id, loaded.manifest, service.ownerUserId);
          log(
            `📋 .ninedeploy applied: routes=${applyResult.routesUpserted}, alerts=${applyResult.alertsUpserted}, dbAttached=${applyResult.databaseAttached}, previews=${applyResult.previewsApplied ? 'configured' : 'unchanged'}, notifications=${applyResult.notificationsSynced}, volumeBackups=${applyResult.volumeBackupSchedule ?? 'unchanged'}`,
          );
          for (const w of applyResult.warnings) {
            log(`📋 .ninedeploy note: ${w}`);
          }
        }
      } catch (err) {
        log(`warning: .ninedeploy apply failed: ${msg(err)}`);
      }
    }
    log('##[stage:PREPARE:success]');

    // Cancel checkpoint: checkout can take minutes on big repos.
    if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();

    if (service.templateId) {
      log('##[stage:DEPENDENCIES:running] Reconciling managed template dependencies');
      const dependency = await reconcileTemplateDependencies(db, service, log);
      if (dependency) {
        log(`Managed database ${dependency.database.slug} is running and attached`);
      }
      log('##[stage:DEPENDENCIES:success]');
    }

    const runtimeEnvironment = await loadRuntimeEnv(db, service);
    if (runtimeEnvironment.readyAttachmentCount !== runtimeEnvironment.attachmentCount) {
      throw new Error(
        `Managed database dependency is not ready (${runtimeEnvironment.readyAttachmentCount}/${runtimeEnvironment.attachmentCount} attachments running)`,
      );
    }
    if (runtimeEnvironment.managedDatabaseKeys.length > 0) {
      log(`Managed database environment ready: ${runtimeEnvironment.managedDatabaseKeys.join(', ')}`);
      managedFp = managedEnvFingerprint(runtimeEnvironment.values, runtimeEnvironment.managedDatabaseKeys);
    }

    // ── `.ninedeploy` build-shaping sections ────────────────────────────
    //
    // Merge rule (docs/NINEDEPLOY_MANIFEST.md §3): panel/DB > manifest >
    // auto-detect. `applyManifestToBuildConfig` only fills fields the operator
    // left empty, so a value set in the panel is never overwritten by the repo.
    //
    // The overlay is per-deploy and deliberately NOT persisted: the manifest
    // travels with the commit, so the next deploy of a different commit must
    // re-derive it rather than inherit a stale copy in `build_configs`.
    let effectiveBuildConfig = buildConfig;
    if (manifest && buildConfig) {
      const merged = applyManifestToBuildConfig(manifest, buildConfig);
      const changed: string[] = [];
      for (const key of ['installCmd', 'buildCmd', 'startCmd', 'baseDir', 'dockerfilePath', 'restartPolicy'] as const) {
        if (merged[key] !== buildConfig[key]) changed.push(`${key}=${String(merged[key])}`);
      }
      if (changed.length > 0) {
        log(`📋 .ninedeploy build config: ${changed.join(', ')} (panel values win; these fields were empty)`);
      }
      effectiveBuildConfig = merged;
    }

    // `env.required` is a contract the repo declares, not something the panel
    // can know. A missing key is the classic "container boots, then crashes"
    // failure, so it is surfaced loudly here — as a warning rather than a hard
    // failure, because the value may legitimately arrive from the image itself.
    if (manifest) {
      const missing = findMissingRequiredEnv(manifest, runtimeEnvironment.values);
      for (const key of missing) {
        log(`⚠ .ninedeploy declares required env "${key}", which is not set for this service`);
      }
      // Lifecycle hooks run on the HOST, so accepting them from a repository
      // would hand anyone with push access the host-execution capability that
      // lib/hostPrivilege.ts gates behind the operator flag. Say so instead of
      // ignoring the section silently.
      if (manifest.hooks) {
        log(
          '⚠ .ninedeploy hooks are ignored: deploy hooks execute on the host, so they can only be set by an operator in Service → Settings',
        );
      }
    }

    // `resources` and `run.port`/`run.healthcheck` fill in only where the panel
    // left the field unset — 0 means "unlimited/unset" for the two limits, and
    // null means "unset" for the port. Same precedence rule as the build fields.
    let serviceForBuild = service;
    if (manifest) {
      const patch: Partial<typeof service> = {};
      const notes: string[] = [];
      const cpu = manifest.resources?.cpuShares;
      const mem = manifest.resources?.memMb;
      if (service.cpuShares === 0 && cpu) {
        patch.cpuShares = cpu;
        notes.push(`cpuShares=${cpu}`);
      }
      if (service.memLimitMb === 0 && mem) {
        patch.memLimitMb = mem;
        notes.push(`memLimitMb=${mem}`);
      }
      if (service.port == null && manifest.run?.port) {
        patch.port = manifest.run.port;
        notes.push(`port=${manifest.run.port}`);
      }
      // healthPath is NOT NULL with default '/', so '/' is the "unset" marker.
      if ((service.healthPath ?? '/') === '/' && manifest.run?.healthcheck) {
        patch.healthPath = manifest.run.healthcheck;
        notes.push(`healthPath=${manifest.run.healthcheck}`);
      }
      if (notes.length > 0) {
        serviceForBuild = { ...service, ...patch };
        log(`📋 .ninedeploy runtime config: ${notes.join(', ')} (panel values win)`);
      }
    }

    const ctx: BuildContext = {
      deploymentId,
      service: serviceForBuild,
      buildConfig: effectiveBuildConfig ?? undefined,
      manifest,
      workDir,
      commitSha: sha,
      // For image rollback, pin the exact image by its stored digest.
      imageDigest: dep.imageDigest ?? undefined,
      env: runtimeEnvironment.values,
      // Registry-type sources provide private-image credentials.
      registryAuth: await loadRegistryAuth(db, service),
      // No serverId / agentCall: a service pinned to a remote node never
      // reaches this point (the refusal above), and binding a caller no
      // builder reads is what made remote deploys look implemented in the
      // first place. Wire them back in the same change that teaches a builder
      // to use them — see lib/remoteDeploy.ts.
      // Additional named-volume attachments. Loaded fresh on every deploy so
      // a mid-flight attach (before this deployment claims its slot) is
      // reflected in the next run, but NOT in any already-queued deployment
      // (the deployment row pins the configuration snapshot).
      volumeAttachments: await db
        .select()
        .from(serviceVolumeAttachments)
        .where(eq(serviceVolumeAttachments.serviceId, service.id)),
      log,
      // Sprint 4 G-01 PR-B: the worker pipeline supplies these when the
      // operator has flipped the `engine.use_buildkit` flag and the
      // kernel has at least one `IBuildCache` registered. Absent =
      // legacy `docker build` path.
      useBuildKit: kernelCtx?.useBuildKit,
      buildCache: kernelCtx?.buildCache,
      onBuildCacheEvent: kernelCtx?.onBuildCacheEvent,
    };

    if (buildConfig?.preDeployCmd) {
      log(`▶ Running Pre-Deploy Hook: ${buildConfig.preDeployCmd} …`);
      await runHook(buildConfig.preDeployCmd, workDir, ctx.env, log);
    }

    log('##[stage:BUILD:running] Building image and compiling dependencies');
    runtime = await builder.buildAndRun(ctx, previous);
    log('##[stage:BUILD:success]');
    log('##[stage:BOOT:success] Container runtime launched in isolated sandbox');

    // Cancel checkpoint: the build finished, but the healthcheck (up to 5 min)
    // is the most likely place for a user-initiated cancel to land.
    if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();

    log('##[stage:HEALTHCHECK:running] Probing container HTTP healthcheck');
    log('Running healthcheck …');
    const healthy = await builder.isHealthy(runtime, 300_000, 10_000, log);
    if (!healthy) throw new Error('Healthcheck failed — service did not become ready in time');
    log('##[stage:HEALTHCHECK:success]');

    if (buildConfig?.postDeployCmd) {
      log(`▶ Running Post-Deploy Hook: ${buildConfig.postDeployCmd} …`);
      try {
        await runHook(buildConfig.postDeployCmd, workDir, ctx.env, log);
      } catch (err) {
        log(`warning: post-deploy hook failed: ${msg(err)}`);
      }
    }

    // Cancel checkpoint: last one before the success writes.
    if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();
  } catch (err) {
    const cancelled = err instanceof DeploymentCancelled;
    log(cancelled ? '⏹ Deployment cancelled' : `✗ Deployment failed: ${msg(err)}`);
    log('##[stage:ERROR:failed]');

    // Clean up the failed/cancelled NEW runtime (if one was created).
    if (runtime) await builder.stop(runtime.runtimeId).catch(() => undefined);

    // Rollback: if the PREVIOUS runtime is still alive, the service keeps
    // serving the old version (Docker blue-green — the old container was never
    // stopped). For PM2 the previous process was already stopped, so the
    // service is down. Probe the previous with a short timeout to decide.
    let restored = false;
    if (previous) {
      try {
        restored = await builder.isHealthy(previous, 3000, 0, log);
      } catch {
        restored = false;
      }
    }

    if (restored) {
      log('↩ Previous runtime is still healthy — rolled back to it.');
      // The service keeps serving the old version (status: running); the
      // deployment itself still failed and is recorded as such.
      await db.update(services).set({ status: 'running' }).where(eq(services.id, service.id));
      await db.update(deployments).set({ status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date() }).where(eq(deployments.id, deploymentId));
    } else if (cancelled) {
      // No previous runtime to fall back on — the service simply never came up.
      await db.update(services).set({ status: 'idle' }).where(eq(services.id, service.id));
      await db.update(deployments).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(deployments.id, deploymentId));
    } else {
      await safeFail(db, deploymentId, service.id, null);
    }
    await auditOutcome(
      db,
      service,
      deploymentId,
      cancelled ? 'cancelled' : 'failed',
      cancelled ? undefined : msg(err),
    );
    return;
  }

  // ── SUCCESS PATH (outside the try, so a post-success hiccup can never kill
  // the healthy new container). The status writes are not wrapped: a failure
  // here propagates to the worker tick, which is correct — but the container is
  // already running. Only the post-success side-effects are best-effort. ──────
  const newRuntimeId = runtime!.runtimeId;
  // In-place redeploys (compose) recreate the runtime under the SAME
  // deterministic id: once buildAndRun returns, "previous" and "new" are the
  // same live instance. Retiring that id afterwards would tear down the
  // deployment that just went live (`docker compose down --remove-orphans`).
  const inPlaceRedeploy = previous !== undefined && previous.runtimeId === newRuntimeId;
  // Conditional on still being `building`: a cancel that landed between the
  // last checkpoint and the finalize must not be overwritten with `running`.
  // This runs FIRST — otherwise the service row below could end up pointing
  // at a container that a late cancel then retires.
  // Persist THIS deploy's managed-env fingerprint onto its row so the NEXT
  // one can compare, then warn loudly when a value drifted from the previous
  // successful deployment (config-once images break silently in that case).
  let finalizeSnapshot: string | undefined;
  if (Object.keys(managedFp).length > 0) {
    // `dep` was loaded BEFORE this run wrote its own snapshot, and deployment
    // rows are created without one — dep.configSnapshot is always null here.
    // The comparison target is the previous deployment that CARRIES a
    // snapshot (same resolution rule the /diff endpoint uses).
    const prevRow = await db.query.deployments.findFirst({
      where: and(eq(deployments.serviceId, service.id), lt(deployments.id, deploymentId), isNotNull(deployments.configSnapshot)),
      orderBy: [desc(deployments.id)],
    });
    let prev: { managedEnv?: Record<string, string> } | null = null;
    try {
      prev = JSON.parse(prevRow?.configSnapshot ?? 'null') as { managedEnv?: Record<string, string> } | null;
    } catch {
      prev = null;
    }
    const prevFp = prev?.managedEnv;
    if (prevFp) {
      for (const key of Object.keys(managedFp)) {
        if (prevFp[key] !== undefined && prevFp[key] !== managedFp[key]) {
          log(`⚠ Managed database value "${key}" differs from the previous deployment.`);
          log(
            `⚠ Config-once apps (WordPress et al.) write these values INTO their persistent volume on first boot — ` +
              `if "${key}" feeds such an app and it now cannot reach its database, delete the generated config file ` +
              `(e.g. wp-config.php) from the volume — or edit it — and redeploy.`,
          );
        }
      }
    }
    // Merge the fingerprint ON TOP of THIS deployment's own snapshot. Starting
    // from an empty base would clobber buildPack/envKeys and blind the /diff
    // endpoint for every template- or database-attached service.
    let base: Record<string, unknown> = {};
    try {
      base = JSON.parse(configSnapshot) as Record<string, unknown>;
    } catch {
      /* no snapshot available — fingerprint-only */
    }
    base['managedEnv'] = managedFp;
    finalizeSnapshot = JSON.stringify(base);
  }

  const finalized = await db
    .update(deployments)
    .set({
      status: 'running',
      finishedAt: new Date(),
      imageDigest: runtime!.imageDigest ?? null,
      ...(finalizeSnapshot !== undefined ? { configSnapshot: finalizeSnapshot } : {}),
    })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.status, 'building')))
    .returning({ id: deployments.id });
  if (finalized.length === 0) {
    if (!inPlaceRedeploy) {
      log('⏹ Cancelled just before finalizing — retiring the new container, the previous stays live');
      await builder.stop(newRuntimeId).catch(() => undefined);
      if (previous) {
        await db.update(services).set({ status: 'running', runtimeId: previous.runtimeId }).where(eq(services.id, service.id));
      } else {
        // First-ever deploy cancelled at the wire: nothing is running.
        await db.update(services).set({ status: 'idle' }).where(eq(services.id, service.id));
      }
    } else {
      // The swap already happened under a shared runtime id and cannot be
      // unwound — record reality instead of stopping the live instance.
      log('⏹ Cancelled just before finalizing — in-place redeploy already applied, live runtime stays up');
      await db.update(services).set({ status: 'running', runtimeId: newRuntimeId }).where(eq(services.id, service.id));
    }
    await auditOutcome(db, service, deploymentId, 'cancelled');
    return;
  }
  const persisted = await db
    .update(services)
    .set({ status: 'running', runtimeId: newRuntimeId, port: runtime!.port ?? null, commitSha: sha })
    .where(eq(services.id, service.id))
    .returning({ id: services.id });
  if (persisted.length === 0) {
    // The service was deleted while this deploy was building. Nothing tracks
    // the candidate any more — retire it so it cannot hold its port forever.
    log('Service row disappeared mid-deploy (deleted) — retiring the orphaned runtime');
    await builder.stop(newRuntimeId).catch(() => undefined);
    return;
  }

  // This build is now THE live one: demote every OLDER row still marked
  // `running` for this service. Without this, the Deploys tab listed every
  // past successful deploy as Running forever.
  await db
    .update(deployments)
    .set({ status: 'superseded' })
    .where(and(eq(deployments.serviceId, service.id), eq(deployments.status, 'running'), ne(deployments.id, deploymentId)));

  // Auto-provision wildcard domain if configured and not already present.
  // Isolated: a failure here must not affect the already-running container.
  if (config.wildcardDomain) {
    try {
      const wildcardHost = `${service.slug}.${config.wildcardDomain}`;
      const existing = await db.query.domains.findFirst({ where: and(eq(domains.serviceId, service.id), eq(domains.hostname, wildcardHost)) });
      if (!existing) {
        const ssl = !!(await getAcmeEmail(db));
        await db.insert(domains).values({ serviceId: service.id, hostname: wildcardHost, path: '/', ssl, status: 'active' });
        log(`🌐 Auto-assigned URL: ${ssl ? 'https' : 'http'}://${wildcardHost}`);
      }
    } catch (err) {
      log(`warning: could not auto-assign wildcard domain: ${msg(err)}`);
    }
  }

  // Flip routing to the NEW container first, then stop the old one (blue-green
  // finalize). For PM2 the previous was already stopped inside buildAndRun, so
  // this stop is a harmless no-op.
  // IMPORTANT: only stop the previous container when routing actually flipped —
  // otherwise we'd kill the still-serving old version and cause an outage.
  let routingFlipped = false;
  try {
    log('##[stage:PROXY_SWAP:running] Updating Traefik dynamic router & shifting live traffic');
    await writeDynamicConfig(db);
    routingFlipped = true;
    log('##[stage:PROXY_SWAP:success]');
  } catch (err) {
    log(`proxy warning: ${msg(err)}`);
  }
  if (previous && !inPlaceRedeploy) {
    // Only retire the previous container once routing has actually flipped to
    // the new one — otherwise we'd stop the still-serving version and cause an
    // outage. If the config write failed, leave the previous container live.
    // In-place redeploys are excluded above: their "previous" id IS the new
    // live runtime, and stopping it would delete the fresh deployment.
    if (routingFlipped) {
      log('##[stage:CLEANUP:running] Graceful shutdown of old container instance');
      if (buildConfig?.preStopCmd) {
        log(`▶ Running Pre-Stop Hook: ${buildConfig.preStopCmd} …`);
        // Isolated on purpose: a post-success hiccup (corrupt ciphertext, DB
        // hiccup) must not abort the finalize — the old container would leak
        // forever with the service row already pointing at the new one.
        let currentEnvironment: Awaited<ReturnType<typeof loadRuntimeEnv>> | null = null;
        try {
          currentEnvironment = await loadRuntimeEnv(db, service);
        } catch (err) {
          log(`pre-stop warning: could not load the runtime environment (${msg(err)}) — running the hook without it`);
        }
        await runHook(buildConfig.preStopCmd, workDir, currentEnvironment?.values ?? {}, log).catch((err) =>
          log(`pre-stop warning: ${msg(err)}`),
        );
      }
      // Give Traefik's file watcher a moment to apply the new config before
      // retiring the old container — otherwise its reload latency could 502
      // requests still routed to the previous version.
      await sleep(2000);
      await builder
        .stop(previous.runtimeId, { graceSeconds: buildConfig?.stopGraceSeconds })
        .catch((err) => log(`finalize warning (previous stop): ${msg(err)}`));
      log('##[stage:CLEANUP:success]');
    } else {
      log('↩ finalize skipped: routing did not flip, the previous container stays live');
    }
  } else {
    if (inPlaceRedeploy) {
      log('In-place redeploy: the live instance carries the new version — nothing to retire');
    }
    log('##[stage:CLEANUP:success]');
  }
  log('##[stage:COMPLETE:success] Service is live and healthy on production');
  log('✓ Deployment successful');
  await auditOutcome(db, service, deploymentId, 'success');
}
