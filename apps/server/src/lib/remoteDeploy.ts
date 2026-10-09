import { eq } from 'drizzle-orm';
import {
  buildConfigs,
  type DB,
  githubAppInstallations,
  serviceGithubLinks,
  sources,
} from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { type AgentCaller, capabilityRefusal, gitCredentialRefusal, nodeLabel } from './agentCapabilities.js';
import { badRequest, HttpError } from './errors.js';
import { remoteDatabaseRefusal } from './remoteDatabaseRefusal.js';
import { remoteVolumeRefusal } from './remoteVolumes.js';

// r229/r269: moved to its own file (multi-node T1, a pure move) so node
// databases relax it there; re-exported so every caller keeps this path.
export { remoteDatabaseRefusal } from './remoteDatabaseRefusal.js';

/**
 * What a remote node can and cannot run.
 *
 * Remote deployments used to be refused outright: `server_id` existed on the
 * services table, on the Servers page and in the BuildContext, and no builder
 * read it, so a service pinned to a node would have been built and started on
 * the PANEL host while the panel reported the node. Refusing was the honest
 * behaviour — a failed deployment is recoverable, a container on the wrong
 * machine is not.
 *
 * `engine/builders/remoteDocker.ts` now routes docker services through the
 * node's agent, so the blanket refusal is gone. What remains is a narrower and
 * still-honest one: the shapes the agent has no operation for.
 *
 *   - PM2 has no agent operation at all, and it is host-privileged.
 *   - A docker service whose container needs a command, the Docker socket or
 *     extra volume attachments (r266, {@link remoteServiceRefusal}).
 *   - A repository cloned with a Git credential: the node clones anonymously
 *     (r268, same function). 0.13 (T5): except a GitHub App repository, which
 *     reaches an agent advertising `git.credential` over the sealed transport
 *     as a per-job, repository-scoped token (lib/nodeGitCredential.ts).
 *   - Deploy hooks: they run on the panel host (r522, {@link remoteHookRefusal}).
 *
 * Compose stacks DO run on a node now (`engine/builders/remoteCompose.ts`):
 * the panel ships an inline stack's YAML, or the node checks the repository
 * out, and the same preflight-then-up ordering the local builder uses is
 * driven through typed operations.
 *
 * Nixpacks source builds are refused too, but only the builder can see that
 * (it depends on the build config, not the service type) — see
 * `RemoteDeployUnsupportedError` there.
 */

/** Service types a node's agent can run today. */
const REMOTE_CAPABLE_TYPES = new Set(['docker', 'compose']);

/** True when a service of this type can be deployed to a node. */
export function remoteDeploySupported(type: string): boolean {
  return REMOTE_CAPABLE_TYPES.has(type);
}

/** Operator-facing reason a service of this type cannot go to a node. */
export function remoteDeployUnsupportedReason(type: string): string {
  const why =
    type === 'pm2'
      ? 'PM2 services run as host processes and the node agent has no operation for them'
      : `service type "${type}" has no remote implementation`;
  return `Deployments to a remote server are not available for this service: ${why}. Clear the target server to deploy it on the panel host.`;
}

/**
 * Whether a service's repository is cloned with a Git credential (the attached
 * source carries a token or deploy key). A node agent's `git.ensure` has no
 * credential operand — any clone it runs is anonymous — so a credentialed
 * repository cannot be checked out on a node (r268, r353).
 */
export async function sourceHasGitCredential(db: DB, sourceId: number | null | undefined): Promise<boolean> {
  if (sourceId == null) return false;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
  if (!src) return false;
  // 0.13: a GitHub App source stores no token — it mints one per clone — so a
  // node must never be left to clone its (typically private) repo anonymously.
  if (src.type === 'github_app') return true;
  return Boolean(src.type !== 'registry' && (src.tokenEncrypted || src.deployKeyEncrypted));
}

/**
 * 0.13 (T5): which credential the panel would clone this service's repository
 * with — the decision `resolveCloneCreds` (lib/sourceCreds.ts) makes, read
 * without minting or decrypting anything:
 *
 *   - `github_app`: an enabled GitHub link on a live installation (the
 *     service's own, else a preview's parent's), or a `github_app` source;
 *   - `static`: the attached source's token or deploy key (never `registry`,
 *     which is image-pull auth — the r268 rule);
 *   - `none`: an anonymous clone.
 *
 * Only `github_app` can reach a node (as a per-job token); `static` stays on
 * the panel. The builders re-resolve at job time and refuse a `static`
 * answer again, so a link changed in between cannot leak a PAT.
 */
export type CloneCredentialKind = 'none' | 'github_app' | 'static';

export async function cloneCredentialKind(
  db: DB,
  service: { id?: number | null; sourceId?: number | null; previewParentServiceId?: number | null },
): Promise<CloneCredentialKind> {
  for (const serviceId of [service.id, service.previewParentServiceId]) {
    if (typeof serviceId !== 'number') continue;
    const link = await db.query.serviceGithubLinks.findFirst({ where: eq(serviceGithubLinks.serviceId, serviceId) });
    if (!link?.enabled) continue;
    const inst = await db.query.githubAppInstallations.findFirst({ where: eq(githubAppInstallations.id, link.installationRowId) });
    if (inst && !inst.suspendedAt && !inst.removedAt) return 'github_app';
  }
  if (service.sourceId == null) return 'none';
  const src = await db.query.sources.findFirst({ where: eq(sources.id, service.sourceId) });
  if (!src) return 'none';
  if (src.type === 'github_app') return 'github_app';
  return src.type !== 'registry' && (src.tokenEncrypted || src.deployKeyEncrypted) ? 'static' : 'none';
}

/**
 * The r268 refusal: a static credential (PAT / deploy key) never leaves the
 * panel — unless its source allows it on nodes (multi-node, design §3.2), and
 * the message now names both ways forward, the recommended one first.
 */
export const STATIC_CREDENTIAL_REFUSAL =
  'Deployments to a remote server are not available for this service: its repository is cloned with a Git credential, and the node clones anonymously — the credential never leaves the panel. Detach the credential if the repository is public, or clear the target server to deploy it on the panel host. ' +
  'To deploy it on the node, build it on the panel (Service → Settings → Build → Build on; recommended: the credential stays on the panel and only the image travels), ' +
  'or allow this credential on nodes (System → Sources → Allow on nodes) so the node receives it for one clone at a time.';

// ── static credentials on nodes (multi-node, design §3.2, owner decision O5) ──

/** The host a source's credential belongs to (`baseUrl` first), or null when nothing names one (custom, Gitea without a base URL). */
const PROVIDER_HOSTS: Readonly<Record<string, string>> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };

function isSshUrl(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://') || url.startsWith('ssh+git://');
}

/** lib/git.ts `toSshUrl`: the SSH form a deploy-key clone uses for an https URL (an SSH URL is unchanged). */
export function deployKeyCloneUrl(url: string): string {
  const m = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `git@${m[1]}:${m[2]}.git` : url;
}

/** The host a clone URL reaches (https, `ssh://`, or scp-like `git@host:path`), lower-cased; null when unparsable. */
export function cloneUrlHost(url: string): string | null {
  const scp = /^[^@/:]+@([A-Za-z0-9.-]+):(?!\/\/)/.exec(url);
  if (scp) return (scp[1] as string).toLowerCase();
  try {
    return new URL(url.replace(/^ssh\+git:/, 'ssh:')).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** How a node clones with a static credential: the panel's own choice (lib/git.ts `useKey`), and the URL it uses. */
export type StaticClonePlan = { mode: 'token' | 'key'; url: string } | { refusal: string };

/**
 * The node twin of `checkoutCommit`'s credential choice, read without
 * decrypting anything: a deploy key wins for an SSH URL or when there is no
 * token (and clones the SSH form of the URL); otherwise the token, over
 * https only. Host check, like `resolveCloneCreds` does for a GitHub App: a
 * source that names its provider (github/gitlab/bitbucket, or a base URL) is
 * never sent to a repository on another host.
 */
export function staticClonePlan(
  src: { name?: string | null; type: string; tokenEncrypted?: string | null; deployKeyEncrypted?: string | null; baseUrl?: string | null },
  repoUrl: string,
): StaticClonePlan {
  const useKey = !!src.deployKeyEncrypted && (isSshUrl(repoUrl) || !src.tokenEncrypted);
  const mode: 'token' | 'key' = useKey ? 'key' : 'token';
  const url = useKey ? deployKeyCloneUrl(repoUrl) : repoUrl;
  if (mode === 'token' && !/^https?:\/\//.test(url)) {
    return { refusal: 'Deployments to a remote server are not available for this service: its access token clones over http(s), and the repository URL is not an http(s) URL.' };
  }
  if (mode === 'key' && !/^(?:ssh:\/\/|git@[A-Za-z0-9.-]+:)/.test(url)) {
    return { refusal: 'Deployments to a remote server are not available for this service: its deploy key clones over SSH, and the repository URL has no ssh:// or git@host:path form the node can use.' };
  }
  let expected: string | null = PROVIDER_HOSTS[src.type] ?? null;
  if (src.baseUrl) {
    try {
      expected = new URL(src.baseUrl).hostname.toLowerCase();
    } catch {
      /* an unparsable base URL names no host */
    }
  }
  const host = cloneUrlHost(url);
  if (expected !== null && host !== expected) {
    return {
      refusal:
        `Deployments to a remote server are not available for this service: refusing to send the ${src.type} credential${src.name ? ` "${src.name}"` : ''} ` +
        `to ${host ?? 'that URL'} — it belongs to ${expected}. Use a source for the repository's own host.`,
    };
  }
  return { mode, url };
}

/** What a static credential is called in a refusal ("cannot clone with …"). */
export const staticCredentialFeature = (mode: 'token' | 'key'): string =>
  mode === 'key' ? 'clone with a deploy key' : 'clone with a personal access token';

/** How {@link remoteServiceRefusal} reaches the node to ask about a per-job token (tests inject it). */
export interface RemoteAgentProbe {
  agent: AgentCaller;
  nodeLabel: string;
  sealed: boolean;
}

async function defaultAgentProbe(db: DB, serverId: number): Promise<RemoteAgentProbe> {
  return {
    agent: (op, params, sink) => agentOp(db, serverId, op, params, sink),
    nodeLabel: await nodeLabel(db, serverId),
    sealed: await agentTransportSealed(db, serverId),
  };
}

/** A refusal with the HTTP status and code the queue-time check answers. */
export interface RemoteServiceRefusal {
  status: number;
  code: string;
  message: string;
}

/** The service fields the refusals read. */
export type RemoteServiceShape = {
  id: number;
  serverId?: number | null;
  type?: string | null;
  cmd?: string[] | null;
  dockerSocket?: boolean | null;
  sourceId?: number | null;
  repoUrl?: string | null;
  image?: string | null;
  composeContent?: string | null;
  previewParentServiceId?: number | null;
  volumeMount?: string | null;
  // 0.16 T4: where the image is built (NULL = where it runs, as before).
  buildOn?: string | null;
  buildServerId?: number | null;
};

const unsupported = (message: string): RemoteServiceRefusal => ({ status: 400, code: 'remote_deploy_unsupported', message });

/**
 * {@link remoteServiceRefusal} with the status and code: the r266/r268/0.13
 * refusals stay 400 `remote_deploy_unsupported`; a node feature the agent
 * lacks is the multi-node 422 `node_agent_outdated` (or 403
 * `node_feature_disabled`, 422 `node_transport_unsealed`, 502
 * `node_unreachable`). The node is asked nothing but `agent.ping`.
 */
export async function remoteServiceRefusalDetail(
  db: DB,
  service: RemoteServiceShape,
  opts: { probe?: (serverId: number) => Promise<RemoteAgentProbe> } = {},
): Promise<RemoteServiceRefusal | null> {
  if (service.serverId == null) return null;
  const serverId = service.serverId;
  const type = service.type ?? 'docker';
  const probes = new Map<number, Promise<RemoteAgentProbe>>();
  const probeOf = (id: number): Promise<RemoteAgentProbe> => {
    let p = probes.get(id);
    if (!p) {
      p = (opts.probe ?? ((n: number) => defaultAgentProbe(db, n)))(id);
      probes.set(id, p);
    }
    return p;
  };
  const probe = (): Promise<RemoteAgentProbe> => probeOf(serverId);
  // ── 0.16 T4 build placement (design §6.3) ──
  // The node that CLONES and BUILDS: the target itself (NULL `build_on`, as
  // before), the build server (`server`: the §2/§3 rules apply to it), or
  // none (`panel` — the credential stays on the panel, only the image
  // travels). A docker service only; compose stacks build where they run.
  const buildOn = type === 'docker' ? (service.buildOn ?? 'target') : 'target';
  const buildNode = buildOn === 'panel' ? null : buildOn === 'server' ? (service.buildServerId ?? null) : serverId;
  const cloneProbe = (): Promise<RemoteAgentProbe> => probeOf(buildNode as number);
  // ── end 0.16 T4 ──
  // Only a service the NODE clones: an image deploy never clones, and an
  // inline compose stack is shipped from the panel.
  if (buildNode != null && service.repoUrl && !service.image && !service.composeContent) {
    const kind = await cloneCredentialKind(db, service);
    if (kind === 'static') {
      // Multi-node (design §3.2): a PAT or deploy key reaches a node only
      // when its source allows it (off for every existing source, which keeps
      // the r268 refusal), and only to an agent that takes it over the sealed
      // transport — whose owner can still refuse static credentials.
      const src = service.sourceId == null ? undefined : await db.query.sources.findFirst({ where: eq(sources.id, service.sourceId) });
      if (!src?.allowOnNodes) return unsupported(STATIC_CREDENTIAL_REFUSAL);
      const plan = staticClonePlan(src, service.repoUrl);
      if ('refusal' in plan) return unsupported(plan.refusal);
      const p = await cloneProbe();
      const why = await capabilityRefusal(p.agent, p.nodeLabel, p.sealed, {
        cap: 'git.sshkey',
        feature: staticCredentialFeature(plan.mode),
        sealedRequired: true,
      });
      if (why) return { ...why, message: `Deployments to a remote server are not available for this service yet: ${why.message}` };
    }
    // 0.13 (T5): a GitHub App repository reaches the node as a short-lived,
    // repository-scoped token per job — only for an agent that advertises
    // `git.credential` over the sealed transport. Anything else keeps the
    // r268 refusal, with the fix named.
    if (kind === 'github_app') {
      const p = await cloneProbe();
      const why = await gitCredentialRefusal(p.agent, p.nodeLabel, p.sealed);
      if (why) return unsupported(`Deployments to a remote server are not available for this service yet: ${why}`);
    }
    // Multi-node (design §2.2): an explicit Nixpacks build needs an agent
    // with `build.nixpacks`. Railpack never refuses here (an older agent keeps
    // the r520 Dockerfile substitution), and `auto` is resolved at job time
    // from the panel's own checkout.
    if (type === 'docker') {
      const build = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, service.id) });
      if ((build?.buildPack ?? 'auto') === 'nixpacks') {
        const p = await cloneProbe();
        const why = await capabilityRefusal(p.agent, p.nodeLabel, p.sealed, { cap: 'build.nixpacks', feature: 'build with Nixpacks', sealedRequired: false });
        if (why) return { ...why, message: `Deployments to a remote server are not available for this service yet: ${why.message}` };
      }
    }
  }
  // ── 0.16 T5 integration (node volumes, design §4.2) ──
  // The r266 clause (a command, the Docker socket, volume attachments) is
  // now lib/remoteVolumes.ts: null when the agent can run them
  // (`docker.runSpec`, `volume.manage`, sealed) and no attachment crosses
  // hosts; otherwise the capability refusal or 409 attachment_host_mismatch.
  // Same probe, so the node is asked at most once.
  return remoteVolumeRefusal(db, service, { probe });
  // ── end 0.16 T5 integration ──
}

/**
 * r266: why the node cannot run this service the way the panel would, or null.
 *
 * The agent's `docker.runEnv` has no slot for a container command, a Docker
 * socket mount or extra volume attachments, and the remote builder used to
 * drop all three silently: minio (`server /data`) printed its help and exited,
 * portainer/dozzle came up with no Docker to talk to, and an attached volume
 * (which lives on the PANEL host anyway) simply was not there. Refused up
 * front rather than taught to the protocol in a patch release — a node may
 * run an older agent than the panel.
 *
 * r268: the same goes for a repository behind a Git credential. The panel
 * clones with the attached source's token / deploy key, but the node's
 * `git.ensure` used to have no credential operand and cloned anonymously — a
 * private repository failed on the node with git's ambiguous "repository not
 * found" after the panel-side checkout had succeeded. Multi-node: unless the
 * source allows its credential on nodes ({@link remoteServiceRefusalDetail}).
 */
export async function remoteServiceRefusal(
  db: DB,
  service: RemoteServiceShape,
  opts: { probe?: (serverId: number) => Promise<RemoteAgentProbe> } = {},
): Promise<string | null> {
  return (await remoteServiceRefusalDetail(db, service, opts))?.message ?? null;
}

/** The three lifecycle hooks a build config can carry. */
type HookFields = {
  preDeployCmd?: string | null;
  postDeployCmd?: string | null;
  preStopCmd?: string | null;
};

/**
 * r522: why a node-pinned service's deploy hooks cannot run, or null.
 *
 * `runHook` executes pre-deploy / post-deploy / pre-stop commands with the
 * panel's own `run()` — on the PANEL host, in the panel's checkout — and the
 * agent has no operation for an arbitrary command. A node-pinned service with
 * a hook set therefore ran it on the wrong machine (a migration against the
 * panel host's network, a cache flush of nothing) while the deploy reported
 * success. Refused like every other shape the node cannot honour. Services
 * that already carry such a hook get the fix in the message: clear the hook,
 * or clear the target server.
 */
export function remoteHookRefusal(build: HookFields | null | undefined): string | null {
  if (!build) return null;
  const set = (
    [
      ['pre-deploy', build.preDeployCmd],
      ['post-deploy', build.postDeployCmd],
      ['pre-stop', build.preStopCmd],
    ] as const
  )
    .filter(([, cmd]) => typeof cmd === 'string' && cmd.trim() !== '')
    .map(([name]) => name);
  if (set.length === 0) return null;
  return `Deployments to a remote server are not available for this service: its ${set.join(', ')} hook${set.length > 1 ? 's run' : ' runs'} on the panel host, not on the node, and the node agent has no operation for an arbitrary command. Clear the hook${set.length > 1 ? 's' : ''} in Service → Settings → Build, or clear the target server to deploy it on the panel host.`;
}

/**
 * Queue-time 400 for {@link remoteServiceRefusal} — and, r522, for deploy
 * hooks on a node-pinned service (the pipeline refuses both again at its
 * choke point).
 */
export async function assertRemoteServiceSupported(
  db: DB,
  service: Parameters<typeof remoteServiceRefusal>[1],
): Promise<void> {
  const refusal = await remoteServiceRefusalDetail(db, service);
  if (refusal) {
    throw refusal.status === 400 ? badRequest(refusal.message, refusal.code) : new HttpError(refusal.status, refusal.code, refusal.message);
  }
  if (service.serverId == null) return;
  const build = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, service.id) });
  const hookReason = remoteHookRefusal(build);
  if (hookReason) throw badRequest(hookReason, 'remote_deploy_unsupported');
}

/** Queue-time 400 for {@link remoteDatabaseRefusal}. */
export async function assertRemoteDatabaseReachable(
  db: DB,
  service: { id: number; serverId?: number | null; templateDatabaseEnv?: unknown },
): Promise<void> {
  const reason = await remoteDatabaseRefusal(db, service);
  if (reason) throw badRequest(reason, 'remote_database_unreachable');
}

/**
 * Throw a 400 for a service pinned to a node whose type cannot run there
 * (queue-time feedback, so the operator hears it before a deployment row is
 * created). A docker service passes straight through.
 */
export function assertRemoteDeploySupported(service: {
  serverId?: number | null;
  type?: string | null;
}): void {
  if (service.serverId == null) return;
  const type = service.type ?? 'docker';
  if (remoteDeploySupported(type)) return;
  throw badRequest(remoteDeployUnsupportedReason(type), 'remote_deploy_unsupported');
}
