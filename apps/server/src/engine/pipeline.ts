import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { and, desc, eq, exists, inArray, isNotNull, lt, ne, type SQL } from 'drizzle-orm';
import { buildConfigs, databaseAttachments, databases, type DB, deployments, domains, envVars, previewEnvVars, primaryTransitions, swarmTransitions, projects, services, serviceProjects, serviceTargets, serviceVolumeAttachments, workspaceMembers } from '@ninedeploy/db';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { checkoutCommit, type CloneCreds } from '../lib/git.js';
import { assertCiGateForBuild } from '../lib/ciGate.js';
import { scanBeforeTraffic, scannableOnNode, scannableOnPanel } from '../lib/imageScan.js';
import { archiveDockerArtifact, artifactRuntimeService, assertArtifactAvailable, assertArtifactImage, assertArtifactTarget, cacheNodeDockerArtifact, parseDockerArtifact, prepareArtifactImage, supportsDockerArtifact } from '../lib/dockerArtifact.js';
import { withReleaseImageLock } from '../lib/releaseImageRetention.js';
import { GithubAppError } from '../lib/githubApp.js';
import { githubAppCloneHint, resolveCloneCreds } from '../lib/sourceCreds.js';
import { classifyCloneFailure, redactGitOutput } from '../lib/cloneFailure.js';
import { detectDeployHints } from '../lib/deployHints.js';
import { materialiseComposeFile } from '../lib/composeWorkspace.js';
import { renderComposeRelease } from '../lib/composeRelease.js';
import { assertReleaseTarget, readReleaseRecord, storeReleaseRecord } from '../lib/releaseRecords.js';
import { extractSourceUpload, isUploadSourced, listSourceUploads, UPLOAD_SOURCE_PANEL_BUILD } from '../lib/sourceUpload.js';
import { getInlineDockerfile, inlineDockerfileSha, prepareEmptyContext, writeInlineDockerfile } from '../lib/inlineDockerfile.js';
import { composeRouteEnv } from '../lib/composeRoutes.js';
import { cloneCredentialKind, remoteDatabaseRefusal, remoteDeploySupported, remoteDeployUnsupportedReason, remoteHookRefusal, remoteServiceRefusal } from '../lib/remoteDeploy.js';
import { nodeGitCredentialSource } from '../lib/nodeGitCredential.js';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { recoverCompletedInitialStop } from '../lib/nodeLegacyStopRecovery.js';
import { nodeLabel, parseAgentCapabilities } from '../lib/agentCapabilities.js';
import { createRemoteDockerBuilder, type AgentCall } from './builders/remoteDocker.js';
import { bindNodeAutoscalePreparation } from './builders/nodeAutoscaleBinding.js';
import { deployToTargets, type FanoutContext, pullableReleaseRef, recordFanoutResults, targetsForService } from './fanout.js';
import { createRemoteComposeBuilder } from './builders/remoteCompose.js';
import {
  resolveBuildPlacement,
  assertNoSecretsInPushedImage,
  type BuildPlacement,
  buildElsewhere,
  type PlacedBuild,
  primaryBuildPack,
  primaryImage,
  recordBuildHost,
  retainBuildHostTags,
  shipPlacedBuild,
} from './buildPlacement.js';
import type { BuildSlots } from './buildSlots.js';
import { shipImageByStream } from '../lib/imageTransfer.js';
import { remoteVolumeRefusal } from '../lib/remoteVolumes.js';
import { createSwarmBuilder, isSwarmService, swarmDeployRefusal, withSwarmRetirement } from './swarmDeploy.js';
import { swarmRuntimeOf } from '../lib/swarm.js';
import { fileMountRefusal, fileMountsSupported, loadNodeServiceFiles, prepareFileMounts } from '../lib/serviceFiles.js';
import { fetchLfsObjects, GIT_LFS_PANEL_ONLY } from '../lib/gitLfs.js';

/** 0.16.3: why a service that is not a docker service is not deployed with custom Docker labels (0.16.4: nodes and Swarm included). */
export const DOCKER_LABELS_PANEL_ONLY =
  'Custom Docker labels apply to docker services only; remove them (Service → Settings).';
/** 0.16.3: why a service that is not a docker service is not deployed with the command healthcheck (0.16.4: nodes and Swarm included). */
export const COMMAND_HEALTHCHECK_PANEL_ONLY =
  'The command healthcheck applies to docker services only; choose another healthcheck (Service → Settings).';
import { analyzeRepo, summarizeInsights } from '../lib/frameworks.js';
import { upsertInsights } from './repoInsights.js';
import { connectionString, ENGINES } from './database.js';
import { dockerBuilder, packUnavailableReason, railpackUnavailableReason } from './builders/docker.js';
import { isBuildpackPack } from '../lib/buildPacks.js';
import { composeBuilder } from './builders/compose.js';
import { logBus } from './logs.js';
import { pm2Builder } from './builders/pm2.js';
import { AGENT_CAP_OP_CANCEL, CANCELLABLE_AGENT_OPS, deployAbortSignal, deployAborted, outsideDeployScope, runInDeployScope } from '../lib/deployAbort.js';
import { claimNodeDeploymentAttempt, createNodeDeploymentAuthority, NodeDeploymentOwnershipLost, type NodeDeploymentAuthority } from '../lib/nodeDeploymentOwner.js';
import { getAcmeEmail, writeDynamicConfig } from './proxy.js';
import { ProxyRoutingUnconfirmed } from '../lib/proxyRoutingAck.js';
import { beginPrimaryTransition, primaryRecoveryPending, PrimaryIdentityUnconfirmed, PrimaryRecoveryOwnershipLost, PrimaryRecoveryPending, type PrimaryRecoveryLease } from './primaryRecovery.js';
import { beginSwarmTransition, swarmRecoveryPending, SwarmRecoveryPending, SwarmRecoveryOwnershipLost, type SwarmRecoveryLease } from './swarmRecovery.js';
import { autoscaleConfig, canaryConfig } from '@ninedeploy/schemas';
import { canarySkipReason, runCanary } from './canary.js';
import { ensurePreviewDatabaseCopies } from '../lib/previewDatabases.js';
import { canaryActive, canaryOwnedBy, endCanary } from './canaryState.js';
import { primaryCanaryTraffic } from './primaryCanaryTraffic.js';
import { preflightNodeCanary } from './nodeCanaryPreflight.js';
import { run, sleep } from '../lib/exec.js';
import { hasVaultRef, resolveVaultRefs } from '../lib/vault.js';
import { registryCredentialFor, registryCredentialForSourceBuild } from '../lib/registryBinding.js';
import { databaseRole, isOperator, roleAtLeast } from '../lib/resourceAccess.js';
import { grantsForUser, projectGrantRole } from '../lib/accessGrants.js';
import { getBundledTemplates } from '../templates/registry.js';
import type { BuildContext, Builder, DeployRuntime } from './types.js';
import { reconcileTemplateDependencies } from './templateDependencies.js';
import { applyManifestToService } from '../lib/applyManifestToService.js';
import { audit } from '../lib/audit.js';
import { autoHostFor } from '../lib/autoUrl.js';
import { loadNinedeployManifest } from '../lib/ninedeployManifest.js';
import { applyManifestToBuildConfig, findMissingRequiredEnv } from '../lib/ninedeployApply.js';
import { lfsBuildsOnPanel, type NinedeployManifest, uploadBuildsOnPanel } from '@ninedeploy/schemas';

const builders: Record<string, Builder> = { docker: dockerBuilder, pm2: pm2Builder, compose: composeBuilder };
const DEPLOY_HEARTBEAT_MS = 20_000;
/** The healthcheck deadline a service without its own (`healthTimeoutSeconds`) gets. */
const DEFAULT_HEALTH_TIMEOUT_S = 300;

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
  const recovering = new Set((await db.select({ serviceId: primaryTransitions.serviceId }).from(primaryTransitions)
    .where(inArray(primaryTransitions.serviceId, [...newestByService.keys()]))).map(row => row.serviceId));
  for (const row of await db.select({ serviceId: swarmTransitions.serviceId }).from(swarmTransitions)
    .where(inArray(swarmTransitions.serviceId, [...newestByService.keys()]))) recovering.add(row.serviceId);
  const liveServices = new Set(svcRows.filter(s => s.status === 'running' || (s.status === 'deploying' && recovering.has(s.id))).map(s => s.id));

  const supersededIds: number[] = [];
  for (const r of running) {
    if (!liveServices.has(r.serviceId) || r.id !== newestByService.get(r.serviceId)) {
      supersededIds.push(r.id);
    }
  }
  if (supersededIds.length > 0) {
    await db.update(deployments).set({ status: 'superseded' }).where(inArray(deployments.id, supersededIds));
  }
  return supersededIds.length;
}

/**
 * Tokenize a hook command line. Hooks are documented as ONE argv-style
 * command whose compound form is `sh -c "a && b"` — that only works if
 * quoting is honoured; a plain whitespace split leaves the quote bytes in
 * argv (`sh -c '"a'` → "command not found"). Rules: single quotes are fully
 * literal; inside double quotes `\` escapes `"` and `\`; outside quotes `\`
 * escapes the next char; unterminated quotes run to end of input.
 */
/** Exported for the tokenizer's own unit tests — pure string logic. */
export function splitHookCommand(cmd: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let open = false; // the current token exists — keeps `''`/`""` as empty args
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open) {
        argv.push(cur);
        cur = '';
        open = false;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      open = true;
      continue;
    }
    cur += ch;
    open = true;
  }
  if (open) argv.push(cur);
  return argv;
}

/** Execute a lifecycle hook command in the service workDir with resolved environment. */
async function runHook(cmd: string, cwd: string, env: Record<string, string>, log: (line: string) => void): Promise<void> {
  const [bin, ...args] = splitHookCommand(cmd);
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

/** The service's configured readiness check, as a DeployRuntime carries it (same mapping as the docker builder). */
function healthModeOf(service: { healthCheck?: string | null; healthCommand?: string | null }): Pick<DeployRuntime, 'healthCheck' | 'healthCommand'> {
  const mode = service.healthCheck;
  if (mode === 'http-strict' || mode === 'tcp' || mode === 'running') return { healthCheck: mode };
  if (mode === 'command' && service.healthCommand) return { healthCheck: 'command', healthCommand: service.healthCommand };
  return {};
}

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
  /** Keys of `values` that hold a secret (flagged secret, a database password or URL, a vault reference); names only. */
  secretKeys: string[];
  /** r651: what a PR preview was NOT given (names only, never values). */
  withheldFromPreview: string[];
  // ── 0.16 T6 node databases ──
  /** The running attached databases whose connection strings `values` carries, and where they run (D4, O7). */
  attachedDatabases: Array<{ id: number; slug: string; serverId: number | null; container: string | null; envAlias: string }>;
  // ── end 0.16 T6 ──
};

/**
 * r651: may a PR preview receive this database attachment? A preview runs
 * code from a PR branch, so it never gets the database its production parent
 * uses (earlier releases re-attached it from the manifest on every preview
 * deploy), nor one its owner could not attach through the API (`admin` on the
 * database). A separate database attached to the preview on purpose passes.
 */
async function previewMayUseAttachment(
  db: DB,
  service: typeof services.$inferSelect,
  database: typeof databases.$inferSelect,
): Promise<boolean> {
  if (service.previewParentServiceId != null) {
    const onParent = await db.query.databaseAttachments.findFirst({
      where: and(
        eq(databaseAttachments.serviceId, service.previewParentServiceId),
        eq(databaseAttachments.databaseId, database.id),
      ),
    });
    if (onParent) return false;
  }
  if (service.ownerUserId == null) return false;
  const role = await databaseRole(db, database, {
    id: service.ownerUserId,
    isOperator: await isOperator(db, { id: service.ownerUserId }),
  });
  return role !== null && roleAtLeast(role, 'admin');
}

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
  let grants: Awaited<ReturnType<typeof grantsForUser>> | null = null;
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
    if (seat && roleAtLeast(seat.role, 'member')) {
      kept.push(link);
      continue;
    }
    // 0.15: the owner's project grant counts like a seat of its role
    // (max(seat, grant) ≥ member). Read once, only when a seat fell short.
    grants ??= await grantsForUser(db, ownerId);
    const granted = projectGrantRole(grants, project.id);
    if (granted !== null && roleAtLeast(granted, 'member')) kept.push(link);
  }
  return kept;
}

/**
 * The parent's preview-only env set (`preview_env_vars`) for a PR preview;
 * nothing for any other service. Only an ephemeral preview with a parent
 * reads the table, so a production deploy issues exactly the queries it did
 * before 0.12.
 */
async function loadPreviewOnlyEnv(
  db: DB,
  service: typeof services.$inferSelect,
): Promise<Array<typeof previewEnvVars.$inferSelect>> {
  if (service.isEphemeralPreview !== true || service.previewParentServiceId == null) return [];
  return db.query.previewEnvVars.findMany({ where: eq(previewEnvVars.serviceId, service.previewParentServiceId) });
}

/** Exported for the 0068 upgrade-compatibility test (test/previewEnvUpgrade.test.ts). */
export async function loadRuntimeEnv(
  db: DB,
  service: typeof services.$inferSelect,
  templateDatabaseId?: number,
  /** Deploy log: the resolver warns there about references it left literal (0.14). */
  log?: (line: string) => void,
): Promise<RuntimeEnvironment> {
  const env: Record<string, string> = {};
  const managedDatabaseKeys = new Set<string>();
  // Which keys of `env` carry a secret: the last writer of a key decides.
  const secretKeys = new Set<string>();
  const track = (key: string, isSecret: boolean | null | undefined) => {
    if (isSecret) secretKeys.add(key);
    else secretKeys.delete(key);
  };
  // r651: a PR preview is built from a branch anyone with push access wrote.
  // The webhook already declines to copy the parent's secret service env;
  // these are the other routes production credentials reached it by.
  const preview = service.isEphemeralPreview === true;
  const withheldFromPreview: string[] = [];

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
    for (const r of shared) {
      // r651: the preview keeps the parent's project tags (visibility), and
      // with them the project's shared env — secrets included.
      if (preview && r.isSecret) {
        withheldFromPreview.push(`project secret ${r.key}`);
        continue;
      }
      env[r.key] = decrypt(r.valueEncrypted);
      track(r.key, r.isSecret);
    }
  }

  // Service-scope env overrides shared values.
  const rows = await db.query.envVars.findMany({ where: eq(envVars.serviceId, service.id) });
  for (const r of rows) {
    env[r.key] = decrypt(r.valueEncrypted);
    track(r.key, r.isSecret);
  }

  // 0.12 preview-only env: the parent's values meant for its previews win
  // over the preview's own rows (the parent's NON-secret values the webhook
  // copied) and over project-shared values. Read at every deploy, so a
  // preview created before the set existed picks it up on its next deploy.
  // Managed-database keys below still win, exactly as over service env.
  for (const r of await loadPreviewOnlyEnv(db, service)) {
    // 0.16.14: a fork's PR is code from outside the repository — it gets
    // the preview-only values that are not secret, and no others.
    if (r.isSecret && service.previewFromFork === true) {
      withheldFromPreview.push(`preview-only secret ${r.key}`);
      continue;
    }
    env[r.key] = decrypt(r.valueEncrypted);
    track(r.key, r.isSecret);
  }

  const allAttaches = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, service.id) });
  const attaches: typeof allAttaches = [];
  for (const a of allAttaches) {
    if (preview) {
      const d = await db.query.databases.findFirst({ where: eq(databases.id, a.databaseId) });
      if (d && !(await previewMayUseAttachment(db, service, d))) {
        withheldFromPreview.push(`database ${d.name} (${a.envAlias})`);
        continue;
      }
    }
    attaches.push(a);
  }
  let readyAttachmentCount = 0;
  const attachedDatabases: RuntimeEnvironment['attachedDatabases'] = [];
  // F860: the template contract describes ONE database — the template's own
  // (the one the reconcile returned; without that, the first ready attachment
  // it fits). Applied to every attachment, a second database (a Redis cache
  // next to WordPress' MySQL) overwrote the mapped keys and lost its alias.
  let mappingApplied = false;
  for (const a of attaches) {
    const d = await db.query.databases.findFirst({ where: eq(databases.id, a.databaseId) });
    if (d && d.status === 'running') {
      readyAttachmentCount++;
      attachedDatabases.push({ id: d.id, slug: d.slug, serverId: d.serverId ?? null, container: d.containerName ?? d.nodeContainerName ?? null, envAlias: a.envAlias });
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
      const isTemplateDatabase = templateDatabaseId != null ? a.databaseId === templateDatabaseId : !mappingApplied;
      if (!mapping || Object.keys(mapping).length === 0 || !isTemplateDatabase) {
        env[a.envAlias] = connectionString(d);
        managedDatabaseKeys.add(a.envAlias);
        track(a.envAlias, true); // the connection string carries the database password
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
        track(key, source === 'url' || source === 'password');
      }
      mappingApplied = true;
    }
  }

  // r651: vault references copied from the parent's (non-secret) env would
  // resolve to the parent's secrets — a preview resolves none. The key is
  // dropped rather than left raw so the app sees "unset", not a reference.
  if (preview) {
    for (const [key, value] of Object.entries(env)) {
      if (!hasVaultRef(value)) continue;
      delete env[key];
      withheldFromPreview.push(`vault reference ${key}`);
    }
  }

  // A key whose value is a vault reference resolves to a secret.
  for (const [key, value] of Object.entries(env)) if (hasVaultRef(value)) secretKeys.add(key);

  // Vault references resolve last, from the fully-merged map — and only for
  // a service the operator allowed (r510).
  return {
    values: await resolveVaultRefs(db, env, { service, projectIds: projectLinks.map((p) => p.projectId) }, log),
    attachmentCount: attaches.length,
    readyAttachmentCount,
    managedDatabaseKeys: [...managedDatabaseKeys].sort(),
    secretKeys: [...secretKeys].filter((key) => key in env).sort(),
    withheldFromPreview,
    attachedDatabases,
  };
}

/**
 * Resolve private-registry credentials for a service: when the service's
 * source is a registry-type source with a token, image pulls authenticate
 * with (registryUsername, token). r512: only toward a registry host the
 * credential is bound to — see lib/registryBinding.ts; a mismatch is logged
 * here and the pull runs anonymously.
 */
async function loadRegistryAuth(
  db: DB,
  service: typeof services.$inferSelect,
  log?: (line: string) => void,
): Promise<{ username: string; password: string; server?: string } | undefined> {
  return registryCredentialFor(db, service, log);
}

/**
 * Mark a deployment failed and the service errored — without throwing. A DB
 * error during failure handling must never propagate (it would leave the worker
 * tick in a broken state and the deployment stuck in `building`).
 */
async function safeFail(db: DB, deploymentId: number, serviceId: number, runtimeId: string | null, fence?: SQL): Promise<void> {
  try {
    await db.update(deployments).set({ status: 'failed', finishedAt: new Date() }).where(and(eq(deployments.id, deploymentId), inArray(deployments.status, ['queued', 'building', 'deploying']), fence));
  } catch (err) {
    logBus.publish(deploymentId, `failed to mark deployment failed: ${msg(err)}`);
  }
  try {
    await db.update(services).set({ status: 'error', runtimeId }).where(and(eq(services.id, serviceId), ne(services.status, 'stopped'), fence));
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
  // 0.12: a preview's diff also names the parent's preview-only keys it
  // received. The field is omitted when there are none, so every production
  // snapshot (and a preview's without a set) is byte-identical to 0.11's.
  const previewRows = await loadPreviewOnlyEnv(db, service);
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
    ...(previewRows.length > 0 ? { previewEnvKeys: previewRows.map((r) => `${r.key}${r.isSecret ? '*' : ''}`).sort() } : {}),
  });
}

type PipelineKernelCtx = {
  useBuildKit: boolean;
  buildCache?: import('../kernel/types.js').IBuildCache;
  onBuildCacheEvent?: (event: import('./builders/buildkit.js').BuildCacheEvent) => void;
  /**
   * r237: the kernel hook pipeline. `deploy:before` / `deploy:after` (and the
   * legacy `deploy.after` the Cloudflare Tunnels plugin taps) were declared,
   * tapped by plugins, and never called by anything.
   */
  hooks?: import('../kernel/types.js').IHookPipeline;
  /**
   * r239: the kernel event bus. `service.deploying` / `service.deployed` were
   * declared and listened for (Sticky IP, Sticky Session, build cache) and
   * emitted by nothing.
   */
  events?: import('../kernel/types.js').IEventBus;
  /**
   * Multi-node (design §6.3, M2): the worker's build slots per build host. A
   * build on the panel or a build server waits for one; absent (direct
   * callers) a module-level default is used.
   */
  buildSlots?: BuildSlots;
};

/** Run the full deploy pipeline for one deployment row. */
export async function runDeployment(db: DB, deploymentId: number, kernelCtx?: PipelineKernelCtx): Promise<void> {
  let primaryRecovery: PrimaryRecoveryLease | SwarmRecoveryLease | undefined;
  let nodeAuthority: NodeDeploymentAuthority | undefined;
  const events = kernelCtx?.events;
  let ownsLog = false, announce = true;
  const beginLog = () => { if (!ownsLog) { logBus.beginRun(deploymentId); ownsLog = true; } };
  // F881: this run writes the deploy log until its final settle below (incl.
  // the proxy swap/revert and F861's failUnsettledDeployment line). Both
  // awaits between here and the end() are .catch()ed, so end() always runs.
  try {
    const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
    if (!dep || !['queued', 'building'].includes(dep.status)) return;
    beginLog();
    if (events) await emitDeploying(db, deploymentId, events).catch(() => undefined);
    // The scope lets the cancel route stop the running step (lib/deployAbort.ts).
    const result = await runInDeployScope(deploymentId, () => runDeploymentCore(db, deploymentId, dep, kernelCtx, lease => { primaryRecovery = lease; }, authority => { nodeAuthority = authority; }));
    if (result === false) announce = false;
  } catch (err) {
    beginLog();
    if (nodeAuthority) {
      try { await nodeAuthority.check(); }
      catch (ownerError) {
        announce = false;
        if (ownerError instanceof NodeDeploymentOwnershipLost) { logBus.publish(deploymentId, ownerError.message); return; }
        throw ownerError;
      }
    }
    if (err instanceof SwarmRecoveryPending || err instanceof SwarmRecoveryOwnershipLost || primaryRecovery && 'managerNodeId' in primaryRecovery.row) {
      const reason = err instanceof SwarmRecoveryPending || err instanceof SwarmRecoveryOwnershipLost ? err.message : 'Swarm transition remains unconfirmed; retained for recovery';
      logBus.publish(deploymentId, reason); await primaryRecovery?.release(reason); return;
    }
    if (err instanceof PrimaryRecoveryOwnershipLost || err instanceof PrimaryRecoveryPending || primaryRecovery?.lost()) {
      logBus.publish(deploymentId, err instanceof Error ? err.message : 'Primary recovery owns this transition');
      return;
    }
    // F861: an error the pipeline did not handle itself (a DB hiccup before
    // its try, or in an unwrapped status write) must not leave the row
    // `building` — that blocks every later deploy of the service and the
    // stale sweep silently re-runs it 45 minutes later.
    await primaryRecovery?.check();
    await failUnsettledDeployment(db, deploymentId, err, and(primaryRecovery?.fence(), nodeAuthority?.fence())).catch(() => undefined);
    throw err;
  } finally {
    if (primaryRecovery) {
      if (!primaryRecovery.lost()) await (async () => { await nodeAuthority?.check(); await primaryRecovery.completeIfSafe(); })().catch(() => {});
      await primaryRecovery.release();
    }
    if (ownsLog) {
      if (announce && !primaryRecovery?.lost() && !nodeAuthority?.lost() && (kernelCtx?.hooks || events)) await announceOutcome(db, deploymentId, kernelCtx).catch(() => undefined);
      logBus.end(deploymentId);
    }
  }
}

/**
 * F861: settle a row runDeploymentCore threw out of — only while it is still
 * `queued`/`building`/`deploying` (a cancel, a finalize or a handled failure wins), and
 * the service only while it is still `deploying` (this run's own mark).
 */
async function failUnsettledDeployment(db: DB, deploymentId: number, err: unknown, fence?: SQL): Promise<void> {
  const settled = await db
    .update(deployments)
    .set({ status: 'failed', finishedAt: new Date() })
    .where(and(eq(deployments.id, deploymentId), inArray(deployments.status, ['queued', 'building', 'deploying']), fence))
    .returning({ id: deployments.id });
  if (settled.length === 0) return;
  logBus.publish(deploymentId, `✗ Deployment failed: ${msg(err)}`);
  const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
  if (!dep) return;
  await db
    .update(services)
    .set({ status: 'error' })
    .where(and(eq(services.id, dep.serviceId), eq(services.status, 'deploying'), fence));
  const service = await db.query.services.findFirst({ where: eq(services.id, dep.serviceId) });
  if (service) await auditOutcome(db, service, deploymentId, 'failed', msg(err));
}

async function linkedProjectIds(db: DB, serviceId: number): Promise<number[]> {
  const links = await db.query.serviceProjects.findMany({ where: eq(serviceProjects.serviceId, serviceId) });
  return links.map((l) => l.projectId).sort((a, b) => a - b);
}

async function emitDeploying(db: DB, deploymentId: number, events: import('../kernel/types.js').IEventBus): Promise<void> {
  const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
  if (!dep) return;
  const projectIds = await linkedProjectIds(db, dep.serviceId);
  events.emit('service.deploying', { serviceId: dep.serviceId, deployId: deploymentId, projectId: projectIds[0], projectIds });
}

/** Observational: a plugin must never be able to fail or stall the outcome. */
async function announceOutcome(db: DB, deploymentId: number, kernelCtx: PipelineKernelCtx | undefined): Promise<void> {
  const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
  if (!dep) return;
  if (!['running', 'failed', 'cancelled'].includes(dep.status)) return;
  const service = await db.query.services.findFirst({ where: eq(services.id, dep.serviceId) });
  if (!service) return;
  const success = dep.status === 'running';
  const events = kernelCtx?.events;
  // A cancelled deploy is neither outcome: the previous release keeps serving.
  if (events && (success || dep.status === 'failed')) {
    const projectIds = await linkedProjectIds(db, service.id);
    events.emit('service.deployed', {
      serviceId: service.id,
      deployId: deploymentId,
      status: success ? 'success' : 'failed',
      projectId: projectIds[0],
      projectIds,
    });
  }
  const hooks = kernelCtx?.hooks;
  if (!hooks) return;
  await hooks.call('deploy:after', { service, deployId: deploymentId, success });
  if (success) {
    const domain = await db.query.domains.findFirst({ where: eq(domains.serviceId, service.id) });
    await hooks.call('deploy.after', { serviceId: service.id, domain: domain?.hostname });
  }
}

async function runDeploymentCore(db: DB, deploymentId: number, dep: typeof deployments.$inferSelect, kernelCtx?: PipelineKernelCtx, trackPrimary?: (lease: PrimaryRecoveryLease | SwarmRecoveryLease) => void, trackNodeAuthority?: (authority: NodeDeploymentAuthority) => void): Promise<void | false> {
  const service = await db.query.services.findFirst({ where: eq(services.id, dep.serviceId) });
  if (!service) return;
  if (await primaryRecoveryPending(db, service.id)) throw new PrimaryRecoveryPending();
  if (await swarmRecoveryPending(db, service.id)) throw new SwarmRecoveryPending();
  const restore = dep.restoredFromDeploymentId != null ? await readReleaseRecord(db, deploymentId).catch(() => null) : null;
  await assertCiGateForBuild(db, dep, service);
  const artifact = dep.promotionSourceDeploymentId != null ? parseDockerArtifact(dep.artifact) : null;
  if (artifact) {
    if (artifact.commitSha !== dep.commitSha) throw new Error('Artifact commit does not match the queued candidate');
    await assertArtifactTarget(db, artifact, service);
    await assertArtifactAvailable(db, artifact);
    // Build placement and Git LFS concern source builds, never artifact runs.
    Object.assign(service, { buildOn: 'target', buildServerId: null, gitLfs: false });
  }
  if (dep.restoredFromDeploymentId != null) {
    if (!restore) throw new Error('Recorded Compose release is missing or cannot be decrypted; no runtime was changed.');
    assertReleaseTarget(restore, service);
    // Runtime inputs only. Keep current ownership, lane/approval and host authority.
    Object.assign(service, {
      composeContent: renderComposeRelease(restore), composeService: restore.composeService,
      port: restore.port, healthPath: restore.healthPath, templateId: null,
      buildOn: 'target', buildServerId: null,
    });
  }
  if (kernelCtx?.hooks && !restore && !artifact) {
    // HookPipeline.call already isolates handler errors and timeouts.
    await kernelCtx.hooks.call('deploy:before', { service, targetCommit: dep.commitSha ?? undefined }).catch(() => undefined);
  }
  const buildConfig = restore ? undefined : await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, service.id) });
  const configSnapshot = restore
    ? JSON.stringify({ restoredFromDeploymentId: dep.restoredFromDeploymentId, port: restore.port, composeServices: Object.keys(restore.model.services as object) })
    : await snapshotConfig(db, service, buildConfig);

  const log = (line: string) => logBus.publish(deploymentId, line);
  // The worker's claim flipped queued→building; a cancel in the milliseconds
  // before THIS write flipped building→cancelled — and an unconditional write
  // here used to erase it, running the cancelled deploy to a green finish.
  // Conditional on a live status (like the finalize write). `queued` is
  // accepted too: callers that invoke the pipeline directly (the integration
  // harness) never pass through the worker's claim. When the row was taken
  // away, the first checkpoint inside the try below resolves the cancellation
  // with the full cleanup semantics (r404).
  const orderedNode = service.type === 'docker' && service.serverId != null && service.orchestrator !== 'swarm';
  const admission = orderedNode ? await claimNodeDeploymentAttempt(db, deploymentId, service, configSnapshot) : null;
  if (admission && !admission.claimed) {
    const reasons = { placement_changed: 'service node placement changed', owner_changed: 'a newer operation owns the runtime',
      not_claimable: 'the deployment is no longer eligible or this service already has active work' };
    log(`⏹ Node deployment skipped: ${reasons[admission.reason]}`);
    return false;
  }
  const nodeAuthority = admission?.claimed ? createNodeDeploymentAuthority(db, admission.owner) : undefined;
  if (nodeAuthority) trackNodeAuthority?.(nodeAuthority);
  if (nodeAuthority) await recoverCompletedInitialStop(db, service, {
    check: () => nodeAuthority.check(),
    sealed: serverId => agentTransportSealed(db, serverId, deployAbortSignal()),
    agent: (serverId, op, params) => agentOp(db, serverId, op, params, () => undefined, { timeoutMs: 35_000, signal: deployAbortSignal() }),
  });
  const claimed = admission?.claimed ? [{ id: deploymentId }] : await db
    .update(deployments)
    .set({ status: 'building', startedAt: new Date(), configSnapshot })
    .where(and(eq(deployments.id, deploymentId), inArray(deployments.status, ['queued', 'building'])))
    .returning({ id: deployments.id });
  if (claimed.length === 0 && !await isCancelled(db, deploymentId)) {
    log('⏹ Deployment no longer claimable; stale attempt ignored');
    return false;
  }
  if (claimed.length > 0) {
    if (!orderedNode) await db.update(services).set({ status: 'deploying' }).where(and(eq(services.id, service.id),
      exists(db.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.id, deploymentId), eq(deployments.status, 'building'))))));
    log(`▶ Deployment #${deploymentId} for "${service.name}" (${service.type})`);
  }

  // Remote-server deploys route through the node's agent (r037). Everything
  // a node cannot honestly do — PM2, the static pack built on the node, deploy
  // hooks, panel-host databases, and what its agent is too old for — is
  // refused here (D8: this used to name Compose and Nixpacks, which nodes now
  // run) with a reason naming the limit, because a
  // deploy that lands on the panel host while the panel reports the node is
  // strictly worse than a failed deployment you can read.
  //
  // This is the choke point every deployment passes through — webhooks,
  // previews, rollbacks, scheduled jobs and the panel button all end up here —
  // so the decision lives here rather than in each queue path (the routes add a
  // friendlier upfront 400 on top).
  // ── 0.16 T7 swarm (M5) ──
  // A service on the Swarm orchestrator (`orchestrator = 'swarm'`, opt-in per
  // service) deploys through engine/swarmDeploy.ts (design §7.4): what Swarm
  // cannot run (§7.1) or a cluster that is not ready is refused here, before
  // anything is built; the Swarm builder chosen below then builds on the
  // panel, distributes the image and runs `docker stack deploy`. A NULL
  // orchestrator — every service until an operator opts one in — skips this.
  const onSwarm = isSwarmService(service);
  if (onSwarm) {
    const reason = await swarmDeployRefusal(db, service);
    if (reason) {
      log(`✗ ${reason}`);
      await nodeAuthority?.check();
      await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
      await auditOutcome(db, service, deploymentId, 'failed', reason);
      return;
    }
  }
  // ── end 0.16 T7 ──
  // 0.16.3: file mounts are written and mounted for docker services (the
  // panel host; 0.16.5 a node too, whose agent is checked by
  // remoteVolumeRefusal); a Swarm, compose or PM2 service that has them is
  // refused before anything is built, never started without its files.
  // The command healthcheck and custom labels belong to docker services: on
  // the panel host (`docker exec`, `docker run --label`), on a node (0.16.4,
  // `docker.runSpec` with `healthCmd` / `userLabels`, refused for an older
  // agent) and on Swarm (0.16.4, the stack file). Any other type is refused
  // rather than deployed with a probe it never chose.
  const notDocker = service.type !== 'docker';
  const fileRefusal =
    (notDocker && (service.healthCheck === 'http-strict' || service.healthCheck === 'tcp') ? 'HTTP/TCP readiness probes apply to docker services only.' : null) ??
    (await fileMountRefusal(db, service)) ??
    (notDocker && service.healthCheck === 'command' ? COMMAND_HEALTHCHECK_PANEL_ONLY : null) ??
    (notDocker && Object.keys(service.dockerLabels ?? {}).length > 0 ? DOCKER_LABELS_PANEL_ONLY : null);
  if (fileRefusal) {
    log(`✗ ${fileRefusal}`);
    await nodeAuthority?.check();
    await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
    await auditOutcome(db, service, deploymentId, 'failed', fileRefusal);
    return;
  }

  // ── 0.16 T4 build placement (M5) ──
  // Where the image is built (design §6.2, §6.3), decided before the builder
  // and its refusals. A NULL `build_on` (every pre-0072 row) answers `target`
  // without a read, and the deploy builds where it runs exactly as before. A
  // placement that cannot be honoured (its build server was removed) fails
  // the deploy; it never falls back to another host.
  let placement: BuildPlacement;
  try {
    placement = await resolveBuildPlacement(db, service);
  } catch (err) {
    const reason = msg(err);
    log(`✗ ${reason}`);
    await nodeAuthority?.check();
    await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
    await auditOutcome(db, service, deploymentId, 'failed', reason);
    return;
  }
  if (placement.kind !== 'target' && service.type !== 'docker') {
    const reason = `Building on ${placement.kind === 'panel' ? 'the panel host' : 'a build server'} applies to docker services; a ${service.type} service builds where it runs. Set Build on: target.`;
    log(`✗ ${reason}`);
    await nodeAuthority?.check();
    await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
    await auditOutcome(db, service, deploymentId, 'failed', reason);
    return;
  }
  if (placement.kind !== 'target' && (service.image || (!service.repoUrl && !isUploadSourced(service)))) {
    log('Build placement: this service runs a prebuilt image, so there is nothing to build — it is pulled where it runs.');
    placement = { kind: 'target' };
  }
  // 0.16.5: Git LFS on a node with no placement chosen (serviceBuildOn).
  if (placement.kind === 'panel' && lfsBuildsOnPanel(service)) {
    log('Git LFS: the LFS files are fetched on the panel host, so the image is built there and shipped to the node (no build placement is set).');
  }
  // 0.16.7: uploaded source on a node with no placement chosen (serviceBuildOn).
  if (placement.kind === 'panel' && uploadBuildsOnPanel(service)) {
    log('Uploaded source: the archive is kept on the panel host, so the image is built there and shipped to the node (no build placement is set).');
  }
  /** The placement of a build that runs away from where the service runs. */
  const buildAway = placement.kind === 'target' ? null : placement;
  // 0.16.3: LFS files are fetched into the panel's checkout; a build that
  // clones again on a node or a build server would get bare pointer files.
  const buildsOnPanel = buildAway ? buildAway.kind === 'panel' : service.serverId == null;
  if (service.gitLfs && service.repoUrl && !service.image && !buildsOnPanel) {
    log(`✗ ${GIT_LFS_PANEL_ONLY}`);
    await nodeAuthority?.check();
    await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
    await auditOutcome(db, service, deploymentId, 'failed', GIT_LFS_PANEL_ONLY);
    return;
  }
  // 0.16.7: no node or build server can fetch an uploaded archive.
  if (service.serverId != null && isUploadSourced(service) && !buildsOnPanel) {
    log(`✗ ${UPLOAD_SOURCE_PANEL_BUILD}`);
    await nodeAuthority?.check();
    await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
    await auditOutcome(db, service, deploymentId, 'failed', UPLOAD_SOURCE_PANEL_BUILD);
    return;
  }
  // ── end 0.16 T4 ──

  let builder = builders[service.type];
  // 0.16 T4: lifted so a build placed elsewhere can rebind the node builder
  // with the shipped image.
  let remoteBuilderFor: ((prebuiltImage?: BuildContext['prebuiltImage'], orderedCapacity?: boolean) => Builder) | null = null;
  let currentRemoteImage: BuildContext['prebuiltImage'];
  let remoteNodeCall: AgentCall | undefined;
  let orderedDatabaseCheck: (() => Promise<void>) | undefined;
  let orderedDatabaseNetworks: string[] = [];
  let orderedDatabaseIdentities: string[] = [];
  if (service.serverId != null) {
    const serverId = service.serverId;
    if (!remoteDeploySupported(service.type)) {
      const reason = remoteDeployUnsupportedReason(service.type);
      log(`✗ ${reason}`);
      await nodeAuthority?.check();
      await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
      await auditOutcome(db, service, deploymentId, 'failed', reason);
      return;
    }
    // The static build pack executes npm on the host that runs the panel —
    // there is no remote operation for it. Refuse loudly rather than letting
    // the remote builder fail on the missing Dockerfile. (0.16 T4: built on
    // the panel and shipped, it is fine; a build server refuses it itself.)
    if (!artifact && (buildConfig?.buildPack ?? 'auto') === 'static' && buildAway === null) {
      const reason =
        'the static build pack runs its build commands on the panel host and has no remote implementation';
      log(`✗ ${reason}`);
      await nodeAuthority?.check();
      await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
      await auditOutcome(db, service, deploymentId, 'failed', reason);
      return;
    }
    // r522: deploy hooks run through the panel's own `run()` — on the panel
    // host, never on the node. Refused before anything is built, so a hook
    // that used to "work" on the wrong machine now fails with the fix named.
    const hookRefusal = remoteHookRefusal(buildConfig);
    if (hookRefusal) {
      log(`✗ ${hookRefusal}`);
      await nodeAuthority?.check();
      await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
      await auditOutcome(db, service, deploymentId, 'failed', hookRefusal);
      return;
    }
    const dbRefusal = await remoteDatabaseRefusal(db, service);
    if (dbRefusal) {
      log(`✗ ${dbRefusal}`);
      await nodeAuthority?.check();
      await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
      await auditOutcome(db, service, deploymentId, 'failed', dbRefusal);
      return;
    }
    // r266: container shapes the agent has no slot for (command, docker
    // socket, extra volumes) — refused rather than silently dropped; r268: and
    // a repository the node would have to clone with the panel's credential.
    const serviceRefusal = await remoteServiceRefusal(db, artifact ? artifactRuntimeService(service) : service);
    if (serviceRefusal) {
      log(`✗ ${serviceRefusal}`);
      await nodeAuthority?.check();
      await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
      await auditOutcome(db, service, deploymentId, 'failed', serviceRefusal);
      return;
    }
    // A cancel cuts a build/pull/fetch on the node only when its agent kills
    // the op with the dropped request; an older agent would build on in the
    // workspace the next deploy is about to use, so it keeps the old wait.
    let opCancel: Promise<boolean> | undefined;
    const invoke = async (op: string, params: Record<string, unknown>, sink: (line: string) => void, options?: { timeoutMs?: number; signal?: AbortSignal }) => {
      await nodeAuthority?.check();
      try { return await agentOp(db, serverId, op, params, sink, options); }
      finally { await nodeAuthority?.check(); }
    };
    const call = async (op: string, params: Record<string, unknown>, sink: (line: string) => void, options?: { timeoutMs?: number; signal?: AbortSignal }) => {
      const abort = CANCELLABLE_AGENT_OPS.has(op) && !options?.signal ? deployAbortSignal() : undefined;
      if (abort) {
        opCancel ??= invoke('agent.ping', {}, () => undefined)
          .then((r) => parseAgentCapabilities(r.lines).caps.has(AGENT_CAP_OP_CANCEL), () => false);
        if (await opCancel) return invoke(op, params, sink, { ...options, signal: abort });
      }
      return invoke(op, params, sink, options);
    };
    remoteNodeCall = call;
    // r660: the node's name goes into the "update this agent" refusal.
    const label = await nodeLabel(db, serverId);
    // 0.13 (T5): a GitHub App repository is checked out on the node with a
    // per-job token (minted, sent sealed, revoked by the builder).
    const gitCredential = nodeGitCredentialSource(db, service);
    remoteBuilderFor = (prebuiltImage, orderedCapacity = false) => {
      currentRemoteImage = prebuiltImage;
      return service.type === 'compose'
        ? createRemoteComposeBuilder(call, { nodeLabel: label, gitCredential })
        : createRemoteDockerBuilder(call, { nodeLabel: label, gitCredential, isSealed: async () => {
          await nodeAuthority?.check();
          try { return await agentTransportSealed(db, serverId, deployAbortSignal()); } finally { await nodeAuthority?.check(); }
        }, ...(prebuiltImage ? { prebuiltImage } : {}), ...(orderedCapacity && admission?.claimed && nodeAuthority ? {
          prepareCapacity: bindNodeAutoscalePreparation({ db, owner: admission.owner, agent: call, signal: deployAbortSignal(), log,
            extraNetworks: orderedDatabaseNetworks, databaseNetworkIdentities: orderedDatabaseIdentities,
            sealed: () => agentTransportSealed(db, serverId, deployAbortSignal()), checkpoint: candidateCheckpoint }),
        } : {}) });
    };
    builder = remoteBuilderFor();
  }
  // ── 0.16 T7 swarm: the builder (design §7.4, §7.5) ──
  // The Swarm builder for a Swarm service. A service that left Swarm keeps its
  // stack as the previous runtime until the new container is live and routed;
  // the wrapper routes that one retirement to the stack. A runtime id that is
  // not a Swarm service (every non-Swarm row) leaves the builder untouched.
  if (onSwarm) builder = createSwarmBuilder(db, service.slug);
  else if (builder && swarmRuntimeOf(service)) builder = withSwarmRetirement(db, builder, service.slug);
  // ── end 0.16 T7 ──
  if (!builder) {
    log(`✗ Unknown service type: ${service.type}`);
    await nodeAuthority?.check();
    await safeFail(db, deploymentId, service.id, service.runtimeId, nodeAuthority?.fence());
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
  let primaryRecovery: PrimaryRecoveryLease | undefined;
  let swarmRecovery: SwarmRecoveryLease | undefined;
  const candidateCheckpoint = async () => { await nodeAuthority?.check(); if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled(); await orderedDatabaseCheck?.(); };
  const runtimeFence = () => and(primaryRecovery?.fence(), swarmRecovery?.fence(), nodeAuthority?.fence());
  const ensurePrimaryRecovery = async () => {
    if (primaryRecovery || !builder || service.type !== 'docker' || service.orchestrator === 'swarm' || !runtime || runtime.port == null || runtime.runtimeId === previous?.runtimeId) return;
    const active = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.serviceId, service.id), eq(domains.status, 'active')));
    if (!active.length) return;
    primaryRecovery = await beginPrimaryTransition(db, service, deploymentId, runtime, previous, sha);
    trackPrimary?.(primaryRecovery);
    const nativeBuilder = builder;
    builder = primaryRecovery.wrap(builder);
    await primaryRecovery.verifyCandidate(nativeBuilder, runtime, (service.healthTimeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT_S) * 1000, log, candidateCheckpoint);
  };
  /** 0.16.9: a canary ran to the end and still holds its share of the traffic. */
  let canaryHeld = false;
  let canaryOwner: symbol | undefined;
  let canaryStarted = false;
  // The resolved runtime env (lifted so the fan-out hook can push the same
  // secrets to every target node).
  let fanoutEnv: Record<string, string> = {};
  // Resolved commit SHA (empty for image deploys). Lifted out of the try so the
  // success path (which persists it onto the service row) can read it.
  let sha = '';
  // The repo's `.ninedeploy`, when it ships one. Loaded during PREPARE and
  // consumed by the BUILD stage (see `applyManifestToBuildConfig` below).
  let manifest: NinedeployManifest | undefined;
  // Fingerprint of the resolved managed-database env values — filled once the
  // runtime env is built inside the try; consumed by the success finalize.
  let managedFp: Record<string, string> = {};
  // F860: the template's own database (from the reconcile) — the only
  // attachment the template's env contract applies to.
  let templateDatabaseId: number | undefined;
  // 0.16 T4: lifted for the fan-out — the image built away from the hosts
  // (when placed), the effective build config and the volume attachments.
  let placed: PlacedBuild | undefined;
  let fanoutBuildConfig: typeof buildConfig = buildConfig;
  // G1.1: a Dockerfile pasted in the panel, for a docker service that builds from source.
  let inlineDockerfile: string | null = null;
  // Its path in the checkout, once written (repository-root relative).
  let inlineDockerfilePath: string | null = null;
  let fanoutAttachments: Array<{ volumeName: string; containerPath: string; readOnly?: boolean | null }> = [];
  try {
    // Cancel checkpoint: the route may have flipped the row between claim and here.
    if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();
    await preflightNodeCanary(db, service, /^Rollback to #/.test(dep.message ?? ''), async () => {
      if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();
    });

    // r520/r582: a railpack build that cannot run here (no Railpack CLI, or
    // no BuildKit daemon via BUILDKIT_HOST) is refused before the checkout,
    // not after it — and on the panel host only: a node builds through its
    // agent, never railpack. (0.16 T4: a build placed elsewhere checks the
    // host that builds it, in buildElsewhere.)
    if (!artifact && service.serverId == null && buildAway === null && service.type === 'docker' && !service.image && buildConfig?.buildPack === 'railpack') {
      const railpackRefusal = await railpackUnavailableReason();
      if (railpackRefusal) throw new Error(railpackRefusal);
    }
    // G4.4: the same before-the-checkout refusal for the pack CLI.
    if (!artifact && service.serverId == null && buildAway === null && service.type === 'docker' && !service.image && isBuildpackPack(buildConfig?.buildPack)) {
      const packRefusal = await packUnavailableReason(undefined, buildConfig?.buildPack);
      if (packRefusal) throw new Error(packRefusal);
    }

    log('##[stage:PREPARE:running] Resolving repository, sources and workspace');
    // Image-based deploys and inline compose stacks skip git entirely;
    // repo-based deploys resolve creds + checkout.
    if (artifact) {
      sha = artifact.commitSha;
      log(`Recorded artifact ${artifact.imageId} from deployment #${dep.promotionSourceDeploymentId}; skipping checkout, manifest application and compilation`);
    } else if (service.composeContent) {
      // `services.composeContent` is the source of truth for an inline stack,
      // so the workspace file is rewritten from it on EVERY deploy: a rollback,
      // a manually edited file or a wiped workspace all repair themselves here
      // instead of deploying something the panel never showed.
      materialiseComposeFile(service.id, service.composeContent);
      log(`Inline compose stack (${service.composeContent.length} bytes) written to the workspace`);
    } else if (service.image) {
      log(`Image deploy from ${service.image}`);
    } else {
      // 0.16.3: the checkout's credential, reused for the Git LFS API below.
      let lfsCreds: CloneCreds | undefined;
      inlineDockerfile = service.type === 'docker' && !restore ? await getInlineDockerfile(db, service.id) : null;
      if (isUploadSourced(service) && inlineDockerfile && listSourceUploads(service.id).length === 0) {
        // G1.1 "Dockerfile only": no repository and nothing uploaded, so the
        // build context is empty and the Dockerfile is all there is.
        prepareEmptyContext(workDir);
        sha = inlineDockerfileSha(inlineDockerfile);
        log(`Inline Dockerfile ${sha.slice(0, 7)} (no repository): building from an empty context`);
      } else if (isUploadSourced(service)) {
        // 0.16.1: no repository — the code is the archive uploaded for this
        // service (POST /v1/services/:id/source, `ninedeploy deploy`). A
        // redeploy of an older deployment extracts that upload again.
        const uploaded = await extractSourceUpload(service.id, dep.commitSha ?? null, workDir);
        sha = uploaded.sha;
        log(
          `Uploaded source ${sha.slice(0, 7)}: ${uploaded.files} entries` +
            (uploaded.strippedFolder ? ` (built from inside the folder "${uploaded.strippedFolder}")` : ''),
        );
      } else {
        // 0.13: one resolver for the pipeline and the insights routes — a
        // GitHub App link/source mints a repo-scoped installation token; every
        // other source resolves exactly as before.
        let creds: CloneCreds | undefined;
        try {
          // 0.16.14: a fork's PR is cloned with no credential at all — the
          // fork's own build would otherwise run next to the parent's token.
          if (service.previewFromFork === true) log("Cloning a pull request from a fork without a credential: the parent's Git credential stays with the parent");
          else creds = await resolveCloneCreds(db, service);
          lfsCreds = creds;
        } catch (err) {
          if (err instanceof GithubAppError) log(githubAppCloneHint());
          throw err;
        }
        try {
          sha = await checkoutCommit(service.repoUrl ?? '', service.branch, dep.commitSha ?? undefined, workDir, log, creds);
        } catch (err) {
          // The clone error itself is often a bare "repository not found" —
          // git says that for BOTH a nonexistent repo and a private one read
          // anonymously. Say which fix applies to THIS service's setup.
          //
          // F1012: name the reason class (the analysis route's classifier) in
          // the log AND in the failure message (audit → notifications, feed).
          // F1013: git's text never leaves here unredacted — a failed submodule
          // clone prints its URL resolved against the tokenized origin.
          const gitText = redactGitOutput(msg(err), creds);
          const failure = classifyCloneFailure(err, service.branch, creds, service.repoUrl ?? '');
          const failMessage = failure
            ? `Clone failed (reason: ${failure.reason}): ${failure.advice}${
                failure.submodule ? ' The failing clone was a submodule of this repository; the credential needs access to that repository too.' : ''
              }`
            : null;
          if (failMessage) {
            log(`✗ ${failMessage}`);
            log(`git output (credentials removed): ${gitText}`);
          } else {
            log(`✗ Clone failed: ${gitText}`);
          }
          if (!creds && service.previewFromFork === true) {
            log('hint: a fork is cloned without a credential, so only a public fork can be built.');
          } else if (!creds) {
            log('hint: no Git credential is attached to this service. If the repository is PRIVATE, attach one: System → Sources (PAT or generate a deploy key), then select it under Service → Settings → Git credential and redeploy. Public repos need no credential.');
          } else if (creds.type === 'github_app') {
            log(githubAppCloneHint());
          } else if (creds.deployKey && !creds.token) {
            log('hint: cloning used this source\u2019s SSH deploy key. Confirm the PUBLIC key is registered as a deploy key on the provider (repo → Settings → Deploy keys, read access is enough) and that the repo URL is reachable over SSH.');
          } else if (creds.token) {
            log('hint: cloning used the source\u2019s access token. Check that the token is still valid and has read access to this repository (System → Sources → Test).');
          }
          if (failMessage) throw new Error(failMessage);
          throw gitText === msg(err) ? err : new Error(gitText);
        }
      }
      if (dep.ciGate && sha.toLowerCase() !== dep.ciGate.headSha?.toLowerCase()) {
        throw new Error('Checkout returned a different commit from the required CI candidate; no build was started');
      }
      await db.update(deployments).set({ commitSha: sha }).where(eq(deployments.id, deploymentId));

      // 0.16.3: Git LFS pointers → content, from the repository's own LFS API
      // only, before anything reads the checkout (analysis, the build).
      if (service.gitLfs && !isUploadSourced(service)) {
        const auth = lfsCreds?.token ? { username: lfsCreds.type === 'gitlab' ? 'oauth2' : 'x-access-token', password: lfsCreds.token } : null;
        await fetchLfsObjects(workDir, service.repoUrl ?? '', auth, log);
      }

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
      // G1.1: the pasted Dockerfile goes into the build context last, so it
      // is what builds even when the repository ships one of its own.
      if (inlineDockerfile) {
        inlineDockerfilePath = writeInlineDockerfile(workDir, buildConfig?.baseDir, inlineDockerfile);
        log(`Inline Dockerfile (${Buffer.byteLength(inlineDockerfile)} bytes) written to ${inlineDockerfilePath}; building with it`);
      }
    }
    log('##[stage:PREPARE:success]');

    // Cancel checkpoint: checkout can take minutes on big repos.
    if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();

    if (service.templateId) {
      log('##[stage:DEPENDENCIES:running] Reconciling managed template dependencies');
      const dependency = await reconcileTemplateDependencies(db, service, log);
      if (dependency) {
        templateDatabaseId = dependency.database.id;
        log(`Managed database ${dependency.database.slug} is running and attached`);
      }
      log('##[stage:DEPENDENCIES:success]');
    }

    // r269: backstop for the up-front database refusal. A `.ninedeploy`
    // `database:` section (PREPARE) or a template reconcile for a row that
    // predates `templateDatabaseEnv` attaches a panel-host database AFTER that
    // check ran — and the node deploy then went green against a hostname it
    // cannot resolve.
    if (service.serverId != null) {
      const lateDbRefusal = await remoteDatabaseRefusal(db, service);
      if (lateDbRefusal) throw new Error(lateDbRefusal);
    }

    // 0.16.12: a PR preview of a parent with previewDatabaseCopy gets its own
    // copies of the parent's databases before its environment is assembled.
    if (service.isEphemeralPreview && !restore) await ensurePreviewDatabaseCopies(db, service, log);
    const runtimeEnvironment: RuntimeEnvironment = restore
      ? { values: {}, attachmentCount: 0, readyAttachmentCount: 0, managedDatabaseKeys: [], secretKeys: [], withheldFromPreview: [], attachedDatabases: [] }
      : await loadRuntimeEnv(db, service, templateDatabaseId, log);
    // G2.1: a compose domain routed to another service of the stack names it in the environment.
    // Best-effort: the variables are a convenience, never a reason to fail the deploy.
    if (service.type === 'compose' && !restore) {
      try {
        const routed = await composeRouteEnv(db, service.id, runtimeEnvironment.values);
        if (Object.keys(routed).length > 0) {
          Object.assign(runtimeEnvironment.values, routed);
          log(`Per-service domain variables: ${Object.keys(routed).join(', ')}`);
        }
      } catch (err) {
        log(`warning: per-service domain variables were not set: ${msg(err)}`);
      }
    }
    fanoutEnv = runtimeEnvironment.values;
    if (runtimeEnvironment.withheldFromPreview.length > 0) {
      log(
        `🔒 PR preview: withheld from this preview's environment — ${runtimeEnvironment.withheldFromPreview.join(', ')}. A preview runs code from a pull-request branch, so it never receives project-shared secrets, vault references or the production service's databases. To give previews their own values, add them to the parent service's preview-only set (Service → Environment → Preview deployments) or attach a separate, non-production database to it (Service → Databases).`,
      );
    }
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
    // G1.1: for this deployment only, the dockerfile pack with the pasted file.
    if (inlineDockerfilePath) {
      effectiveBuildConfig = { ...(effectiveBuildConfig ?? ({ serviceId: service.id } as NonNullable<typeof buildConfig>)), buildPack: 'dockerfile', dockerfilePath: inlineDockerfilePath };
    }
    fanoutBuildConfig = effectiveBuildConfig;

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
      const cpuCap = manifest.resources?.cpuLimitMilli;
      const mem = manifest.resources?.memMb;
      if (service.cpuShares === 0 && cpu) {
        patch.cpuShares = cpu;
        notes.push(`cpuShares=${cpu}`);
      }
      if (service.cpuLimitMilli === 0 && cpuCap) {
        patch.cpuLimitMilli = cpuCap;
        notes.push(`cpuLimitMilli=${cpuCap}`);
      }
      if (service.memLimitMb === 0 && mem) {
        patch.memLimitMb = mem;
        notes.push(`memLimitMb=${mem}`);
      }
      const replicas = manifest.resources?.replicas;
      if (service.replicas === 1 && replicas && replicas > 1) {
        patch.replicas = replicas;
        notes.push(`replicas=${replicas}`);
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

    let swarmArtifactRecorded = false;
    const recordBuiltArtifact = async (image: { imageId: string; builtWithNixpacks: boolean; builtStatic: boolean }) => {
      const originServerId = placed ? placed.buildHost : service.serverId;
      let captured = parseDockerArtifact({ version: 1, imageId: image.imageId, repoUrl: service.repoUrl,
        commitSha: sha, originDeploymentId: deploymentId, ...(originServerId != null ? { originServerId } : {}),
        builtWithNixpacks: image.builtWithNixpacks, builtStatic: image.builtStatic });
      await withReleaseImageLock(async () => {
        await cacheNodeDockerArtifact(db, captured, service, deploymentId, log);
        if (onSwarm) await assertArtifactImage(captured);
        captured = await archiveDockerArtifact(db, captured, service, log);
        await db.update(deployments).set({ artifact: captured }).where(eq(deployments.id, deploymentId));
      });
    };
    const ctx: BuildContext = {
      ...(onSwarm ? { prepareSwarmTransition: async (stack: Parameters<NonNullable<BuildContext['prepareSwarmTransition']>>[0], candidate: DeployRuntime, auth?: { username: string; password: string; server?: string }) => {
        const initialSnapshot = JSON.stringify({ ...JSON.parse(configSnapshot), port: candidate.port });
        try { swarmRecovery = await beginSwarmTransition(db, service, deploymentId, stack, candidate, sha, auth, initialSnapshot); }
        catch (error) {
          if (await swarmRecoveryPending(db, service.id)) throw new SwarmRecoveryPending();
          throw new Error(error instanceof SwarmRecoveryPending ? error.message : 'Swarm preparation failed before native submission');
        }
        trackPrimary?.(swarmRecovery);
        builder = swarmRecovery.wrap(builder!);
        return { submit: () => swarmRecovery!.submit() };
      } } : {}),
      ...(!artifact && supportsDockerArtifact(service) && /^[a-f0-9]{40}$/i.test(sha) ? { recordDockerArtifact: true } : {}),
      ...(!artifact && onSwarm ? { captureSwarmArtifact: async (image: { imageId: string; builtWithNixpacks: boolean; builtStatic: boolean }) => {
        await recordBuiltArtifact(image);
        swarmArtifactRecorded = true;
        if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();
      } } : {}),
      ...(artifact ? { prebuiltImage: { tag: artifact.imageId, imageId: artifact.imageId, builtWithNixpacks: artifact.builtWithNixpacks, builtStatic: artifact.builtStatic } } : {}),
      ...(artifact && onSwarm ? { requireSwarmMembers: true } : {}),
      ...(restore ? { restoreComposeRelease: restore } : {}),
      deploymentId,
      service: serviceForBuild,
      buildConfig: effectiveBuildConfig ?? undefined,
      manifest,
      workDir,
      commitSha: sha,
      // For image rollback, pin the exact image by its stored digest.
      imageDigest: dep.imageDigest ?? undefined,
      env: runtimeEnvironment.values,
      buildSecretKeys: runtimeEnvironment.secretKeys,
      // Registry-type sources provide private-image credentials.
      registryAuth: artifact ? undefined : await loadRegistryAuth(db, service, log),
      // No serverId / agentCall: a node-pinned service gets the remote
      // builders above, which bind their own agent caller (D8: this used to
      // say a node service never reached this point).
      // Additional named-volume attachments. Loaded fresh on every deploy so
      // a mid-flight attach (before this deployment claims its slot) is
      // reflected in the next run, but NOT in any already-queued deployment
      // (the deployment row pins the configuration snapshot).
      volumeAttachments: restore ? [] : await db
        .select()
        .from(serviceVolumeAttachments)
        .where(eq(serviceVolumeAttachments.serviceId, service.id)),
      // 0.16.3: this deployment's copy of the service's files (none: []).
      // A Swarm service mounts them as Swarm secrets instead (engine/swarmDeploy.ts).
      fileMounts: service.type === 'docker' && service.serverId == null && service.orchestrator !== 'swarm' ? await prepareFileMounts(db, service, deploymentId, log) : [],
      // 0.16.5: a node service's files travel to its node (remoteDocker → remoteRun).
      nodeFiles: service.serverId != null && fileMountsSupported(service) ? await loadNodeServiceFiles(db, service.id) : [],
      log,
      // Sprint 4 G-01 PR-B: the worker pipeline supplies these when the
      // operator has flipped the `engine.use_buildkit` flag and the
      // kernel has at least one `IBuildCache` registered. Absent =
      // legacy `docker build` path.
      useBuildKit: kernelCtx?.useBuildKit,
      buildCache: kernelCtx?.buildCache,
      onBuildCacheEvent: kernelCtx?.onBuildCacheEvent,
      // ── 0.16 T6 node databases (D4) ── panel-host databases the docker builder puts on the service's bridge
      databaseContainers:
        service.serverId == null
          ? runtimeEnvironment.attachedDatabases.filter((a) => a.serverId == null && a.container).map((a) => a.container as string)
          : [],
      // ── end 0.16 T6 ──
    };

    await preflightNodeCanary(db, ctx.service, /^Rollback to #/.test(dep.message ?? ''), async () => {
      if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();
    });

    if (buildConfig?.preDeployCmd) {
      log(`▶ Running Pre-Deploy Hook: ${buildConfig.preDeployCmd} …`);
      await runHook(buildConfig.preDeployCmd, workDir, ctx.env, log);
    }

    fanoutAttachments = ctx.volumeAttachments ?? [];
    if (artifact) {
      await withReleaseImageLock(() => prepareArtifactImage(db, artifact, service, deploymentId, log));
      if (service.serverId != null && remoteBuilderFor) builder = remoteBuilderFor(ctx.prebuiltImage);
    } else if (supportsDockerArtifact(service) && (service.pushRegistrySourceId != null || service.pushRepository)) {
      await assertNoSecretsInPushedImage(ctx);
    }
    log('##[stage:BUILD:running] Building image and compiling dependencies');
    // ── 0.16 T4 build placement: build away, ship, then run (design §6.3) ──
    // A build failure fails the deploy before any host that runs the service
    // is touched; a transfer failure (retried once) fails it before the
    // primary is switched — the previous runtime keeps serving.
    if (buildAway !== null) {
      placed = await buildElsewhere(db, buildAway, ctx, { slots: kernelCtx?.buildSlots });
      await recordBuildHost(db, deploymentId, placed);
      if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();
      const shipped = await shipPlacedBuild(db, placed, service.serverId ?? null, { deploymentId, serviceId: service.id }, log);
      if (service.serverId != null && remoteBuilderFor) {
        // The run phase's port conventions of the pack that built it (the
        // node builder applies them only to builds it ran itself).
        const port = ctx.service.port ?? (placed.builtWithNixpacks ? 3000 : placed.builtStatic ? 80 : null);
        if (port !== ctx.service.port) {
          log(`No container port configured; using the ${placed.builtStatic ? 'static image' : 'Nixpacks'} default ${port}/tcp for runtime and Traefik`);
          ctx.service = { ...ctx.service, port };
        }
        if (placed.builtWithNixpacks && ctx.env['PORT'] === undefined && port != null) ctx.env['PORT'] = String(port);
        builder = remoteBuilderFor({ ...shipped, builtWithNixpacks: placed.builtWithNixpacks, builtStatic: placed.builtStatic });
      } else {
        ctx.prebuiltImage = { ...shipped, builtWithNixpacks: placed.builtWithNixpacks, builtStatic: placed.builtStatic };
      }
    }
    // ── end 0.16 T4 ──
    const scale = autoscaleConfig.safeParse(ctx.service.autoscale);
    if (remoteBuilderFor && remoteNodeCall && admission?.claimed && nodeAuthority && service.serverId != null &&
      service.type === 'docker' && service.orchestrator !== 'swarm' && !swarmRuntimeOf(service) &&
      scale.success && scale.data.metric !== 'rps' && service.canary == null &&
      service.publishedPort == null && !(service.portMappings?.length)) {
      const [activeRoutes, targets] = await Promise.all([
        db.select({ id: domains.id }).from(domains).where(and(eq(domains.serviceId, service.id), eq(domains.status, 'active'))).limit(1),
        db.select({ id: serviceTargets.id }).from(serviceTargets).where(eq(serviceTargets.serviceId, service.id)).limit(1),
      ]);
      if (activeRoutes.length && !targets.length) {
        const readTopology = async () => (await db.select({ attachmentId: databaseAttachments.id, id: databases.id, slug: databases.slug, serverId: databases.serverId, status: databases.status, envAlias: databaseAttachments.envAlias })
          .from(databaseAttachments).innerJoin(databases, eq(databases.id, databaseAttachments.databaseId))
          .where(eq(databaseAttachments.serviceId, service.id))).sort((a, b) => a.id - b.id);
        const topology = await readTopology();
        const expected = runtimeEnvironment.attachedDatabases.map(item => ({ id: item.id, slug: item.slug, serverId: item.serverId, status: 'running', envAlias: item.envAlias }))
          .sort((a, b) => a.id - b.id);
        const networksSupported = JSON.stringify(topology.map(({ attachmentId: _attachmentId, ...database }) => database)) === JSON.stringify(expected) &&
          topology.length <= 8 && topology.every(item => item.serverId === service.serverId);
        let ready = false;
        try {
          await candidateCheckpoint();
          const sealed = await agentTransportSealed(db, service.serverId, deployAbortSignal());
          const ping = await remoteNodeCall('agent.ping', {}, () => undefined);
          await candidateCheckpoint();
          const caps = parseAgentCapabilities(ping.lines).caps;
          ready = sealed && ping.exitCode === 0 && ['docker.mutations', 'docker.prepareAttemptEnv', 'docker.retireHandoff',
            'docker.startSet', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'image.manage',
            'docker.runSpec', 'docker.recovery'].every(cap => caps.has(cap));
        } catch {
          await candidateCheckpoint();
        }
        if (ready && networksSupported) {
          const { nodeDatabaseNetwork } = await import('../lib/nodeDatabase.js');
          orderedDatabaseNetworks = topology.map(item => nodeDatabaseNetwork(item.slug));
          orderedDatabaseIdentities = topology.map(item => `${item.attachmentId}:${item.id}:${nodeDatabaseNetwork(item.slug)}`).sort();
          orderedDatabaseCheck = async () => { if (JSON.stringify(await readTopology()) !== JSON.stringify(topology)) throw new Error('Node database attachments changed during deployment'); };
          await candidateCheckpoint();
          builder = remoteBuilderFor(currentRemoteImage, true);
        }
        else log(networksSupported
          ? 'Node autoscaling capacity requires a sealed, up-to-date agent; continuing with the existing deployment path.'
          : 'Node autoscaling capacity does not support these database attachments; continuing with the existing deployment path.');
      }
    }
    runtime = await builder.buildAndRun(ctx, previous);
    if (!runtime.nodeDeploymentOwner) orderedDatabaseCheck = undefined;
    if (artifact && runtime.imageDigest !== artifact.imageId) throw new Error('Runtime image identity does not match the recorded artifact');
    if (ctx.recordDockerArtifact && (service.pushRegistrySourceId != null || service.pushRepository) && (!runtime.artifactBuild || !runtime.imageDigest)) {
      throw new Error('Registry archival is required but the source image could not be recorded; the candidate will not receive traffic');
    }
    if (onSwarm && ctx.recordDockerArtifact && !swarmArtifactRecorded) throw new Error('Swarm artifact was not retained before the update');
    if (!artifact && !swarmArtifactRecorded && supportsDockerArtifact(service) && runtime.artifactBuild && runtime.imageDigest && /^[a-f0-9]{40}$/i.test(sha)) {
      try {
        await recordBuiltArtifact({ imageId: runtime.imageDigest, ...runtime.artifactBuild });
      } catch (err) {
        if (service.pushRegistrySourceId != null || service.pushRepository) throw err;
        log('Docker artifact record unavailable; this deployment cannot be promoted without rebuilding');
      }
    }
    if (runtime.composeRelease && !restore) {
      try {
        await storeReleaseRecord(db, deploymentId, runtime.composeRelease);
      } catch {
        // Recording is observational; a storage/key failure must not tear down a live stack.
        log('Release record unavailable: the resolved Compose model could not be encrypted and stored');
      }
    }
    // ── 0.16 T6 node databases (O7) ──
    // A node database sits on its own `nd-dbnet-<slug>` bridge on the node;
    // the service reaches it once its new container joins that bridge —
    // before the healthcheck, so an app that connects at boot finds it. A
    // failure fails the deploy; the previous runtime keeps serving.
    if (service.serverId != null && runtime) {
      const onNode = runtimeEnvironment.attachedDatabases.filter((a) => a.serverId === service.serverId);
      if (onNode.length > 0 && !runtime.nodeDeploymentOwner) {
        const { connectServiceToNodeDatabases } = await import('../lib/nodeDatabase.js');
        await connectServiceToNodeDatabases(db, service.serverId, runtime.nodeTargets ?? runtime.runtimeId, onNode, log, { checkpoint: candidateCheckpoint });
      }
    }
    // ── end 0.16 T6 ──
    // G5.1: scan the new image before it gets traffic; the gate (if set)
    // fails the deploy here and the previous release keeps serving. On a
    // node the agent scans its candidate container.
    if (runtime && (scannableOnPanel(service, onSwarm) || scannableOnNode(service, onSwarm))) {
      const serverId = scannableOnNode(service, onSwarm) ? service.serverId : null;
      // A scan can take minutes: a cancel during it lands here.
      if (await scanBeforeTraffic(db, { serviceId: service.id, deploymentId, container: runtime.runtimeId, serverId }, log)) await candidateCheckpoint();
    }
    log('##[stage:BUILD:success]');
    log('##[stage:BOOT:success] Container runtime launched in isolated sandbox');

    // Cancel checkpoint: the build finished, but the healthcheck (up to 5 min)
    // is the most likely place for a user-initiated cancel to land.
    if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();

    log('##[stage:HEALTHCHECK:running] Probing container HTTP healthcheck');
    log('Running healthcheck …');
    // 0.16.1: the deadline is per service (Settings → Healthcheck timeout);
    // unset keeps the 5 minutes every deploy had before.
    const healthTimeoutS = service.healthTimeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT_S;
    if (service.healthTimeoutSeconds != null) log(`Healthcheck timeout: ${healthTimeoutS}s`);
    const healthy = service.serverId == null ? await builder.isHealthy(runtime, healthTimeoutS * 1000, 10_000, log)
      : await builder.isHealthy(runtime, healthTimeoutS * 1000, 10_000, log, { checkpoint: candidateCheckpoint });
    await candidateCheckpoint();
    if (!healthy) {
      throw new Error(
        `Healthcheck failed — service did not become ready within ${healthTimeoutS}s. ` +
          'A slow first boot (migrations, model downloads) can raise the limit under Service → Settings → Healthcheck timeout.',
      );
    }
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

    // ── 0.16.9 canary releases ──
    // Auto-provision the service's automatic URL if one is configured and not
    // already present: the env wildcard, or Settings → Automatic URLs (a base
    // domain or a free sslip.io name — lib/autoUrl.ts).
    // Isolated: a failure here must not affect the already-running container.
    try {
      const auto = await autoHostFor(db, service);
      if (auto) {
        const existing = await db.query.domains.findFirst({ where: and(eq(domains.serviceId, service.id), eq(domains.hostname, auto.hostname)) });
        if (!existing) {
          const ssl = auto.ssl === 'acme' ? !!(await getAcmeEmail(db)) : false;
          await db.insert(domains).values({ serviceId: service.id, hostname: auto.hostname, path: '/', ssl, status: 'active' });
          log(`🌐 Auto-assigned URL: ${ssl ? 'https' : 'http'}://${auto.hostname}`);
        }
      }
    } catch (err) {
      log(`warning: could not auto-assign the automatic URL: ${msg(err)}`);
    }


    await ensurePrimaryRecovery();
    // With a canary configuration the new release takes a growing share of
    // the traffic, step by step, before the switch below. A failed step
    // routes everything back and throws, so the catch below stops the new
    // container as for any failed deploy. A deploy that cannot be split
    // (see canarySkipReason) switches all traffic at once, as before.
    if (service.canary != null && runtime) {
      const parsed = canaryConfig.safeParse(service.canary);
      const routedDomains = (
        await db.select({ id: domains.id }).from(domains).where(and(eq(domains.serviceId, service.id), eq(domains.status, 'active')))
      ).length;
      const skip = parsed.success
        ? canarySkipReason({
            config: parsed.data,
            type: service.type,
            serverId: service.serverId ?? null,
            orchestrator: service.orchestrator ?? null,
            previous,
            previousServing: service.status !== 'stopped' && (service.runtimeReplicas ?? 1) > 0,
            runtime,
            rollback: /^Rollback to #/.test(dep.message ?? ''),
            // As the docker builder decides: a direct port or a mapping without an allow list (those the port proxy holds).
            hostPorts: service.publishedPort != null || (service.portMappings ?? []).some((m) => !m.allowFrom?.length),
            routedDomains,
          })
        : 'the stored canary settings are not valid; save them again under Service → Settings';
      if (skip) {
        log(`Canary release skipped: ${skip}. All traffic switches at once.`);
      } else if (parsed.success) {
        if (service.serverId != null) canaryOwner = Symbol('unstarted node canary');
        const live = runtime;
        const liveBuilder = builder;
        const probeTimeoutMs = Math.min(10_000, (service.healthTimeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT_S) * 1000);
        const checkpoint = async () => {
          await nodeAuthority?.check(); await primaryRecovery?.check(); await swarmRecovery?.check();
          if (await isCancelled(db, deploymentId)) throw new DeploymentCancelled();
          if (canaryStarted && canaryOwner !== undefined && !canaryOwnedBy(service.id, deploymentId, canaryOwner)) throw new ProxyRoutingUnconfirmed('Canary ownership changed; traffic observation refused');
        };
        const traffic = await primaryCanaryTraffic(db, {
          id: service.id, slug: service.slug, runtimeId: previous?.runtimeId ?? null,
          serverId: service.serverId ?? null, orchestrator: service.orchestrator ?? null,
        }, deploymentId, primaryRecovery, checkpoint);
        await runCanary({
          ...traffic,
          serviceId: service.id,
          slug: service.slug,
          deploymentId,
          serverId: service.serverId ?? null,
          stableRuntimeId: previous?.runtimeId ?? null,
          onOwner: owner => { canaryOwner = owner; canaryStarted = true; },
          config: parsed.data,
          runtime: live,
          log,
          probe: () => primaryRecovery
            ? primaryRecovery.verifyCandidate(liveBuilder, live, probeTimeoutMs, log, checkpoint).then(() => true, err => { if (err instanceof PrimaryRecoveryOwnershipLost || err instanceof DeploymentCancelled || err instanceof ProxyRoutingUnconfirmed) throw err; return false; })
            : liveBuilder.isHealthy(live, probeTimeoutMs, 0),
          checkpoint,
        });
        if (canaryOwner !== undefined && !canaryOwnedBy(service.id, deploymentId, canaryOwner)) throw new ProxyRoutingUnconfirmed('Canary ownership changed; runtime generations retained');
        canaryHeld = true;
        if (primaryRecovery) await primaryRecovery.verifyCandidate(builder, live, (service.healthTimeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT_S) * 1000, log, checkpoint);
      }
    }
    // ── end 0.16.9 ──
  } catch (err) {
    await nodeAuthority?.check();
    if (swarmRecovery) {
      if (err instanceof SwarmRecoveryPending || err instanceof SwarmRecoveryOwnershipLost) throw err;
      try { await swarmRecovery.fail(err instanceof DeploymentCancelled); }
      catch { throw new SwarmRecoveryPending('Swarm failure or cancellation recovery is unconfirmed; service retained'); }
      return;
    }
    await primaryRecovery?.check();
    // A cancel kills the running step (lib/deployAbort.ts), so the error that
    // lands here is that step's "killed by signal", not DeploymentCancelled.
    const cancelled = err instanceof DeploymentCancelled || deployAborted() || await isCancelled(db, deploymentId);
    log(cancelled ? '⏹ Deployment cancelled' : `✗ Deployment failed: ${msg(err)}`);
    log('##[stage:ERROR:failed]');

    // Scan the log for known error patterns and surface actionable hints.
    const hints = detectDeployHints(logBus.read(deploymentId));
    for (const h of hints) log(`💡 ${h.label}: ${h.hint}`);

    // Clean up the failed/cancelled NEW runtime (if one was created). r167: an
    // in-place redeploy (compose) reuses the previous runtime id — "the new
    // runtime" IS the service's only stack, and stopping it tore down the
    // running app on a cancel or a slow healthcheck.
    // 0.16.9: a canary still holding a share of the traffic is routed back
    // first (runCanary does this itself when a step fails).
    let retainCandidate = err instanceof ProxyRoutingUnconfirmed || err instanceof PrimaryIdentityUnconfirmed;
    if (canaryActive(service.id)) {
      if (!canaryOwnedBy(service.id, deploymentId, canaryOwner)) throw new ProxyRoutingUnconfirmed('A newer canary owns routing; old pipeline cleanup is refused');
      endCanary(service.id, deploymentId, canaryOwner);
      try { if (primaryRecovery) await primaryRecovery.confirm(); else await writeDynamicConfig(db, { confirmServiceId: service.id }); }
      catch { retainCandidate = true; }
    }
    if (retainCandidate) log(`⚠ Routing rollback was not confirmed; both runtime generations are kept running (candidate ${runtime?.runtimeId ?? 'unknown'})`);
    if (!retainCandidate && runtime && runtime.runtimeId !== previous?.runtimeId) {
      await builder.stop(runtime.runtimeId).catch(() => undefined);
    }

    // Rollback: if the PREVIOUS runtime is still alive, the service keeps
    // serving the old version (Docker blue-green — the old container was never
    // stopped). For PM2 the previous process was already stopped, so the
    // service is down. Probe the previous with a short timeout to decide.
    let restored = false;
    if (previous) {
      try {
        // A host-port deploy stopped the previous generation before starting
        // the candidate (the candidate is gone now, so is its port): start it
        // again, and give it the service's own readiness check — a freshly
        // started SIP/TCP/worker container cannot pass a 3-second HTTP probe.
        const revived = !retainCandidate && runtime?.runtimeId !== previous.runtimeId && builder.revive
          ? await outsideDeployScope(() => builder!.revive!(previous.runtimeId)).catch(() => false)
          : false;
        if (revived) log(`↻ Started the previous runtime ${previous.runtimeId} again`);
        restored = revived
          ? await outsideDeployScope(() => builder!.isHealthy({ ...previous, ...healthModeOf(service) },
            Math.min(60, service.healthTimeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT_S) * 1000, 10_000, log))
          : await outsideDeployScope(() => builder!.isHealthy(previous, 3000, 0, log));
      } catch {
        restored = false;
      }
    }

    if (restored) {
      log('↩ Previous runtime is still healthy — rolled back to it.');
      // The service keeps serving the old version (status: running); the
      // deployment itself still failed and is recorded as such.
      await db.update(services).set({ status: 'running' }).where(and(eq(services.id, service.id), ne(services.status, 'stopped'), runtimeFence()));
      await db.update(deployments).set({ status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date() }).where(and(eq(deployments.id, deploymentId), inArray(deployments.status, ['building', 'deploying']), runtimeFence()));
    } else if (cancelled) {
      // No previous runtime to fall back on — the service simply never came up.
      await db.update(services).set({ status: 'idle' }).where(and(eq(services.id, service.id), ne(services.status, 'stopped'), runtimeFence()));
      await db.update(deployments).set({ status: 'cancelled', finishedAt: new Date() }).where(and(eq(deployments.id, deploymentId), inArray(deployments.status, ['building', 'deploying']), runtimeFence()));
    } else {
      // r167: keep pointing at the previous runtime. A failed 3s probe does
      // not mean it is gone — `--restart unless-stopped` keeps it running and
      // Traefik keeps routing to it — and clearing the id orphaned it for good
      // (no later deploy or stop could ever find it again).
      await primaryRecovery?.check();
      await safeFail(db, deploymentId, service.id, previous?.runtimeId ?? null, runtimeFence());
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

  // ── ROUTING TRANSITION (outside the try, so a later hiccup cannot kill
  // the healthy new container blindly). The status writes are not wrapped: a failure
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
    // The comparison target is the previous deployment carrying a FINGERPRINT
    // (`configSnapshot.managedEnv`), not merely the newest snapshot: every row
    // gets a snapshot the moment the pipeline starts, so a failed/cancelled
    // deploy in between carries one WITHOUT a fingerprint and would silently
    // disable the warning. Scan a bounded window of recent rows.
    const prevRows = await db.query.deployments.findMany({
      where: and(eq(deployments.serviceId, service.id), lt(deployments.id, deploymentId), isNotNull(deployments.configSnapshot)),
      orderBy: [desc(deployments.id)],
      limit: 20,
    });
    let prevFp: Record<string, string> | undefined;
    for (const row of prevRows) {
      try {
        const snap = JSON.parse(row.configSnapshot ?? 'null') as { managedEnv?: Record<string, string> } | null;
        if (snap?.managedEnv) {
          prevFp = snap.managedEnv;
          break;
        }
      } catch {
        /* unparsable snapshot — keep scanning older rows */
      }
    }
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

  await nodeAuthority?.check();
  await primaryRecovery?.intentCandidate(finalizeSnapshot); await swarmRecovery?.intentCandidate(finalizeSnapshot);
  const finalized = await db
    .update(deployments)
    .set({
      status: 'deploying',
      finishedAt: null,
      imageDigest: runtime!.imageDigest ?? null,
    })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.status, 'building'), runtimeFence()))
    .returning({ id: deployments.id });
  // 0.16.9: the canary is over either way. On success the routing flip below
  // goes from the split straight to the new release; on a late cancel the
  // split is written away before the new container stops.
  if (canaryHeld) {
    if (canaryOwner !== undefined && !canaryOwnedBy(service.id, deploymentId, canaryOwner)) throw new ProxyRoutingUnconfirmed('Canary ownership changed before final routing; runtime generations retained');
    endCanary(service.id, deploymentId, canaryOwner);
  }
  if (finalized.length === 0) {
    await nodeAuthority?.check(); await primaryRecovery?.check(); await swarmRecovery?.check();
    if (!inPlaceRedeploy) {
      log('⏹ Cancelled just before finalizing — restoring the previous routing before retiring the candidate');
      let canRetire = true;
      if (canaryHeld) {
        try { await writeDynamicConfig(db, { confirmServiceId: service.id }); }
        catch { canRetire = false; log(`⚠ Canary rollback was not confirmed; both runtime generations are kept running (candidate ${newRuntimeId})`); }
      }
      if (canRetire) await builder.stop(newRuntimeId).catch(() => undefined);
      // A host-port deploy stopped the previous generation; with the candidate
      // gone it can take its ports back.
      if (canRetire && previous && builder.revive && await outsideDeployScope(() => builder!.revive!(previous.runtimeId)).catch(() => false)) {
        log(`↻ Started the previous runtime ${previous.runtimeId} again`);
      }
      if (previous) {
        await db.update(services).set({ status: 'running', runtimeId: previous.runtimeId }).where(and(eq(services.id, service.id), ne(services.status, 'stopped'), runtimeFence()));
      } else {
        // First-ever deploy cancelled at the wire: nothing is running.
        await db.update(services).set({ status: 'idle' }).where(and(eq(services.id, service.id), ne(services.status, 'stopped'), runtimeFence()));
      }
    } else {
      // The swap already happened under a shared runtime id and cannot be
      // unwound — record reality instead of stopping the live instance.
      log('⏹ Cancelled just before finalizing — in-place redeploy already applied, live runtime stays up');
      await db.update(services).set({ status: 'running', runtimeId: newRuntimeId }).where(and(eq(services.id, service.id), ne(services.status, 'stopped'), runtimeFence()));
    }
    await auditOutcome(db, service, deploymentId, 'cancelled');
    return;
  }
  const persisted = await db
    .update(services)
    .set({
      status: 'running',
      runtimeId: newRuntimeId,
      port: runtime!.port ?? null,
      commitSha: sha,
      // What actually runs, not what was asked for: the proxy renders this
      // count, so a replica that failed to start must not stay a dead backend.
      runtimeReplicas: runtime!.replicas ?? 1,
      // 0.16.11: a deploy ends a sleep; the new release is awake and routed.
      asleepAt: null,
    })
    .where(and(eq(services.id, service.id), ne(services.status, 'stopped'), runtimeFence()))
    .returning({ id: services.id });
  if (persisted.length === 0) {
    await nodeAuthority?.check(); await primaryRecovery?.check(); await swarmRecovery?.check();
    // The service was deleted while this deploy was building. Nothing tracks
    // the candidate any more — retire it so it cannot hold its port forever.
    log('Service row disappeared mid-deploy (deleted) — retiring the orphaned runtime');
    await builder.stop(newRuntimeId).catch(() => undefined);
    return;
  }

  // Flip routing to the NEW container first, then stop the old one (blue-green
  // finalize). For PM2 the previous was already stopped inside buildAndRun, so
  // this stop is a harmless no-op.
  // IMPORTANT: only stop the previous container when routing actually flipped —
  // otherwise we'd kill the still-serving old version and cause an outage.
  // r398: a config write that cannot be completed fails the deploy HONESTLY.
  // Swallowing it used to finalize green while Traefik kept routing to the
  // previous generation — the service row pointed at an unrouted container,
  // and only a single warning line in the build log hinted at it.
  let routingFlipped = false;
  // r521: a node-pinned service's routing lives in the NODE's proxy. Its
  // refresh used to be swallowed inside writeDynamicConfig, so the flip below
  // always "succeeded" and CLEANUP stopped the previous container on the node
  // while the node still routed to it. Requiring the node makes that failure
  // take the same honest revert path as a panel-host write failure.
  const flipRouting = async (): Promise<void> => {
    await nodeAuthority?.check();
    try {
      if (swarmRecovery) await swarmRecovery.confirm();
      else if (primaryRecovery) await primaryRecovery.confirm();
      else await writeDynamicConfig(db, { ...(service.serverId != null ? { requireNode: service.serverId } : {}), confirmServiceId: service.id });
    } finally { await nodeAuthority?.check(); }
  };
  log('##[stage:PROXY_SWAP:running] Updating Traefik dynamic router & shifting live traffic');
  try {
    await flipRouting();
    routingFlipped = true;
    log('##[stage:PROXY_SWAP:success]');
  } catch (firstErr) {
    await nodeAuthority?.check();
    if (swarmRecovery) throw new SwarmRecoveryPending('Swarm routing acknowledgement is unconfirmed; retained for recovery');
    await primaryRecovery?.check();
    log(`proxy warning: ${msg(firstErr)} — retrying once in 2s`);
    await sleep(2000);
    try {
      await flipRouting();
      routingFlipped = true;
      log('##[stage:PROXY_SWAP:success] (second attempt)');
    } catch (err) {
      await primaryRecovery?.check();
      log(`##[stage:PROXY_SWAP:failed] ${msg(err)}`);
      const uncertain = firstErr instanceof ProxyRoutingUnconfirmed || err instanceof ProxyRoutingUnconfirmed;
      log('✗ The requested routing could not be confirmed. Reverting to the previous runtime.');
      // The service row points at the candidate, but the deployment is still
      // in progress. A missing load
      // acknowledgement means either generation may still receive traffic.
      const outcome = await isCancelled(db, deploymentId) ? 'cancelled' : 'failed';
      await db.update(deployments).set({ status: outcome, finishedAt: new Date() }).where(and(eq(deployments.id, deploymentId), eq(deployments.status, 'deploying'), runtimeFence()));
      if (inPlaceRedeploy || service.type === 'pm2') {
        // Compose re-created the runtime under the SAME id, and a PM2 deploy
        // stops the previous process inside buildAndRun — in both the swap
        // already happened and cannot be unwound (PM2 routes target the host
        // port, which the new process already owns). Record that the new
        // version IS live while the routing file could not be updated (new
        // domains/labels apply on the next successful write).
        log('↩ The live runtime already carries the new version; only the routing write failed.');
        await db.update(services).set({ status: 'running' })
          .where(and(eq(services.id, service.id), eq(services.runtimeId, newRuntimeId), eq(services.status, 'running'), runtimeFence()));
      } else if (previous) {
        const restored = await db
          .update(services)
          .set({
            status: 'running',
            runtimeId: previous.runtimeId,
            port: previous.port ?? null,
            // `service` is the pre-deploy row: its fields ARE the previous
            // generation's values.
            commitSha: service.commitSha,
            runtimeReplicas: service.runtimeReplicas ?? 1,
          })
          .where(and(eq(services.id, service.id), eq(services.runtimeId, newRuntimeId), eq(services.status, 'running'), runtimeFence()))
          .returning({ id: services.id });
        if (restored.length === 0) {
          log('⏹ Service ownership changed during routing failure; leaving its current routing and runtime untouched');
          await auditOutcome(db, service, deploymentId, outcome, `proxy config write failed: ${msg(err)}`);
          return;
        }
        let canRetire = !uncertain;
        if (uncertain) {
          try { await flipRouting(); canRetire = true; }
          catch { log(`⚠ Routing rollback was not confirmed; both runtime generations are kept running (candidate ${newRuntimeId})`); }
        }
        if (canRetire) await builder.stop(newRuntimeId).catch((stopErr) => log(`revert warning (new container stop): ${msg(stopErr)}`));
        if (service.serverId != null && !uncertain) {
          // r521: a partial node sync may have pushed a route at the container
          // just stopped — re-render from the reverted row, best-effort (the
          // next routing write retries it anyway).
          await writeDynamicConfig(db).catch(() => undefined);
        }
      } else if (uncertain) {
        log(`⚠ Routing was not confirmed; the healthy first runtime is kept running (${newRuntimeId})`);
      } else {
        // First-ever deploy: nothing is serving, and the unrouted new
        // container must not leak.
        const cleared = await db.update(services).set({ status: 'error', runtimeId: null })
          .where(and(eq(services.id, service.id), eq(services.runtimeId, newRuntimeId), eq(services.status, 'running'), runtimeFence()))
          .returning({ id: services.id });
        if (cleared.length > 0) await builder.stop(newRuntimeId).catch(() => undefined);
      }
      await auditOutcome(db, service, deploymentId, outcome, `proxy config write failed: ${msg(err)}`);
      return;
    }
  }
  // Commit terminal success only after the requested routing was loaded.
  // Cancellation races this CAS instead of being overwritten by a late success.
  const promoted = await db.update(deployments).set({ status: 'running', finishedAt: new Date(),
    ...(finalizeSnapshot !== undefined ? { configSnapshot: finalizeSnapshot } : {}),
  })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.status, 'deploying'), runtimeFence(),
      exists(db.select({ id: services.id }).from(services).where(and(
        eq(services.id, service.id), eq(services.runtimeId, newRuntimeId), eq(services.status, 'running'),
      )))))
    .returning({ id: deployments.id });
  if (promoted.length === 0) {
    await nodeAuthority?.check(); await primaryRecovery?.check(); await swarmRecovery?.check();
    await db.update(deployments).set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(deployments.id, deploymentId), eq(deployments.status, 'deploying'), runtimeFence()));
    log('⏹ Cancelled during routing transition — restoring a healthy previous release before candidate retirement');
    const canRestore = previous && !inPlaceRedeploy && service.type !== 'pm2'
      && await outsideDeployScope(() => builder!.isHealthy(previous!, 5_000, 0)).catch(() => false);
    if (canRestore) {
      const restored = await db.update(services).set({ status: 'running', runtimeId: previous!.runtimeId,
        port: previous!.port ?? null, commitSha: service.commitSha, runtimeReplicas: service.runtimeReplicas ?? 1,
      }).where(and(eq(services.id, service.id), eq(services.runtimeId, newRuntimeId), eq(services.status, 'running'), runtimeFence()))
        .returning({ id: services.id });
      if (restored.length === 0) {
        log('⏹ The service changed or was stopped during cancellation; its current owner controls routing and cleanup');
        await auditOutcome(db, service, deploymentId, 'cancelled');
        return;
      }
      try {
        await flipRouting();
        await builder.stop(newRuntimeId).catch(err => log(`cancel cleanup warning: ${msg(err)}`));
      } catch {
        log(`⚠ Cancellation rollback was not confirmed; both runtime generations are kept running (candidate ${newRuntimeId})`);
      }
    } else {
      // A first or in-place runtime may already serve; never stop the only
      // healthy app to honour a cancellation that landed after the route write.
      log(`⚠ No healthy previous runtime can be reinstated; the live candidate is kept running (${newRuntimeId})`);
    }
    await auditOutcome(db, service, deploymentId, 'cancelled');
    return;
  }
  await db.update(deployments).set({ status: 'superseded' })
    .where(and(eq(deployments.serviceId, service.id), eq(deployments.status, 'running'), ne(deployments.id, deploymentId), runtimeFence()));

  // 0.16.1 allow-listed port mappings: the port proxy follows the routing
  // flip to the new containers (and is removed once no mapping needs it).
  // Only on the panel host, and only for a service that has or had one, so
  // every other deploy runs exactly as before.
  if (routingFlipped && service.type === 'docker' && service.serverId == null) {
    const { portProxyDir, restrictedMappings, syncPortProxy } = await import('../lib/portProxy.js');
    if (restrictedMappings(service.portMappings).length > 0 || existsSync(portProxyDir(service.slug))) {
      const { replicaNames } = await import('./dockerNames.js');
      try {
        await syncPortProxy(service, replicaNames(newRuntimeId, runtime!.replicas ?? 1), log);
      } catch (err) {
        log(`⚠ Port proxy: ${msg(err)} — the allow-listed ports are not reachable until the next deploy.`);
      }
    }
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
          currentEnvironment = await loadRuntimeEnv(db, service, templateDatabaseId);
        } catch (err) {
          log(`pre-stop warning: could not load the runtime environment (${msg(err)}) — running the hook without it`);
        }
        await runHook(buildConfig.preStopCmd, workDir, currentEnvironment?.values ?? {}, log).catch((err) =>
          log(`pre-stop warning: ${msg(err)}`),
        );
      }
      // Routed HTTP/TLS handlers were acknowledged above. Allow a short drain
      // for in-flight requests before retiring the previous generation.
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

  // ── Multi-server fan-out ──────────────────────────────────────────────────
  await nodeAuthority?.check(); await primaryRecovery?.check(); await swarmRecovery?.check();
  // Docker releases are pushed to every extra target node AFTER the primary
  // is live — additive, best-effort, never blocking the success. An image
  // release is pulled on each node. A source build whose primary built a
  // Dockerfile is REBUILT on each node from the same pinned commit through
  // git.* + docker.build (see engine/fanout.ts). Every other source build —
  // placed on the panel or a build server (design §6), or a pack a target
  // cannot reproduce (Nixpacks, Railpack, static; D2) — is SHIPPED: the very
  // image the primary runs, never a different build.
  //
  // r353: a Dockerfile rebuild of a repository behind a static Git credential
  // is skipped with a deploy-log line (the target would clone it); a shipped
  // image needs no clone, so the credential never matters there.
  // ── 0.16 T4 fan-out (design §6.5; D1, D2, D8) ──
  // 0.16.7: uploaded source fans out too, always as the shipped image (no
  // target can fetch the archive).
  const uploadSourced = isUploadSourced(service);
  const sourceBuild = service.type === 'docker' && !service.image && (!!service.repoUrl || uploadSourced) && !!sha;
  const extra = service.type === 'docker' && (service.image || sourceBuild) ? await targetsForService(db, service.id) : [];
  let buildableSource: FanoutContext['source'];
  let prebuilt: FanoutContext['prebuilt'];
  if (artifact && extra.length > 0) {
    // A promotion must never re-enter source discovery or rebuild on a target.
    // Use the retained panel copy or the record's bound registry digest, even
    // when the current service's build placement or repository contents changed.
    prebuilt = { ship: async (target, l) => {
      await withReleaseImageLock(() => prepareArtifactImage(db, artifact, { ...service, serverId: target.serverId }, deploymentId, l));
      return { tag: artifact.imageId, imageId: artifact.imageId };
    } };
    if (artifact.builtWithNixpacks && fanoutEnv.PORT === undefined && runtime!.port != null) {
      fanoutEnv = { ...fanoutEnv, PORT: String(runtime!.port) };
    }
  } else if (sourceBuild && extra.length > 0) {
    const ids = { deploymentId, serviceId: service.id };
    if (placed) {
      const build = placed;
      prebuilt = { ship: (target, l) => shipPlacedBuild(db, build, target.serverId, ids, l) };
    } else {
      const primary = await primaryBuildPack(workDir, fanoutBuildConfig ?? undefined);
      // A target node's `docker.build` takes neither build arguments nor a
      // stage, so a Dockerfile build that uses them ships the primary's image
      // like the other packs (D2) instead of building something different.
      const shapedDockerfile = !!fanoutBuildConfig?.buildTarget || (fanoutBuildConfig?.buildArgs ?? []).length > 0 || service.gitLfs === true;
      if (primary.pack === 'dockerfile' && !shapedDockerfile && !uploadSourced) {
        // 0.13 (T5): only a STATIC credential (PAT / deploy key) stays on the
        // panel; a GitHub App repository fans out with a per-job token per target.
        if ((await cloneCredentialKind(db, service)) === 'static') {
          log(
            'Fan-out skipped: this repository is cloned with a Git credential, and target nodes clone anonymously — ' +
              'the credential never leaves the panel. Detach the credential if the repository is public, or deploy an image ' +
              'release to fan it out. The panel-hosted release is live.',
          );
        } else {
          buildableSource = {
            repoUrl: service.repoUrl!,
            branch: service.branch,
            commitSha: sha,
            dockerfilePath: primary.dockerfile,
            baseDir: primary.context,
          };
        }
      } else {
        // D2: the primary built with Nixpacks, Railpack or the static pack; a
        // target rebuilding the repository's Dockerfile would run a different
        // artifact (or fail). Ship the primary's own image instead.
        const primaryHost = service.serverId ?? null;
        let source: Promise<{ tag: string; imageId: string; sizeBytes: number }> | null = null;
        prebuilt = {
          ship: async (target, l) => {
            source ??= primaryImage(db, primaryHost, service.slug, sha);
            const img = await source.catch((err: unknown) => {
              throw new Error(`the primary's ${primary.pack} build cannot be sent to other nodes: ${msg(err)}`);
            });
            await shipImageByStream(db, { ...ids, source: primaryHost, target: target.serverId, tag: img.tag, imageId: img.imageId, sizeBytes: img.sizeBytes || undefined }, l);
            return { tag: img.tag, imageId: img.imageId };
          },
        };
      }
    }
  }
  if (extra.length > 0 && (service.image || buildableSource || prebuilt)) {
    log(`Fanning out to ${extra.length} additional node${extra.length === 1 ? '' : 's'} …`);
    const results = await deployToTargets(
      db,
      {
        service: {
          id: service.id,
          slug: service.slug,
          type: service.type,
          image: service.image,
          port: runtime!.port ?? service.port,
          healthPath: service.healthPath,
          cpuShares: service.cpuShares,
          cpuLimitMilli: service.cpuLimitMilli,
          memLimitMb: service.memLimitMb,
          volumeMount: service.volumeMount,
          publishedPort: service.publishedPort,
          cmd: service.cmd,
          dockerSocket: service.dockerSocket,
          ownerUserId: service.ownerUserId,
          dockerLabels: service.dockerLabels,
          healthCheck: service.healthCheck,
          healthCommand: service.healthCommand,
          healthTimeoutSeconds: service.healthTimeoutSeconds,
          runtimeOptions: service.runtimeOptions,
        },
        deploymentId,
        image: service.image ? await pullableReleaseRef(service.image, runtime!.imageDigest) : undefined,
        env: fanoutEnv,
        // r592: a source build logs each node in too — to the credential's
        // single bound host (r512) — so private base images pull there.
        registryAuth: service.image
          ? await loadRegistryAuth(db, service, log)
          : buildableSource
            ? await registryCredentialForSourceBuild(db, service, log)
            : undefined,
        primaryServerId: service.serverId ?? null,
        primaryRuntimeId: newRuntimeId,
        source: buildableSource,
        gitCredential: buildableSource ? nodeGitCredentialSource(db, service) : undefined,
        prebuilt,
        volumeAttachments: fanoutAttachments,
        // 0.16.5: each target writes and mounts the service's files (docker.fileMounts).
        files: fileMountsSupported(service) ? await loadNodeServiceFiles(db, service.id) : [],
        // ── 0.16 T4 per-target refusal (M5, D1) ──
        // The checks a remote primary passes, per target, before anything is
        // sent to it: the database host rule, and volume attachments / a
        // command / the socket (host and capability) — a target used to start
        // without them. A refused target is recorded failed with the reason;
        // the primary and the other targets are unaffected.
        //
        // Deploy hooks are NOT a refusal here (upgrade safety): they run once,
        // on the panel, for the primary, as in 0.15, and a target still
        // deploys — the log says it ran without them.
        targetRefusal: async (target) => {
          const onTarget = { ...service, serverId: target.serverId };
          const dbRefusal = await remoteDatabaseRefusal(db, onTarget);
          if (dbRefusal) return dbRefusal;
          const volume = await remoteVolumeRefusal(db, onTarget);
          if (volume) return volume.message;
          // 0.16.3: a target would start without the service's files (0.16.5:
          // a docker target mounts them; remoteVolumeRefusal checks its agent).
          const files = await fileMountRefusal(db, onTarget);
          if (files) return files;
          if (remoteHookRefusal(buildConfig)) {
            log(`⚠ deploy hooks run on the primary only; target ${await nodeLabel(db, target.serverId)} was deployed without them`);
          }
          return null;
        },
        // ── end 0.16 T4 ──
      },
      log,
    );
    await recordFanoutResults(db, service.id, results);
    const failed = results.filter((r) => !r.ok).length;
    log(
      failed === 0
        ? `Fan-out complete: ${results.length}/${results.length} target nodes healthy`
        : `Fan-out partially applied: ${results.length - failed}/${results.length} target nodes healthy`,
    );
  }
  // Retention on a build node, once every host has the image (design §6.3 step 6).
  if (placed) await retainBuildHostTags(db, placed, service, deploymentId, log);
  // ── end 0.16 T4 ──

  log('✓ Deployment successful');
  await auditOutcome(db, service, deploymentId, 'success');
}
