import { asc, eq } from 'drizzle-orm';
import { deployments, domains, services, sources, type DB, type Service } from '@ninedeploy/db';
import { decrypt } from './crypto.js';
import { guardedFetch } from './egressGuard.js';
import { commitStateFor, type CommitState, type FeedbackLog } from './githubFeedback.js';
import { redactSecrets } from './redactSecret.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * Commit statuses for GitLab, Gitea and Bitbucket (ROADMAP 0.16.8 item 8),
 * the counterpart of the GitHub App's `report_status` (lib/githubFeedback.ts)
 * for services that clone through a token source of one of those types.
 *
 * Opt-in per service (settings row `commit_status:<serviceId>`, no
 * migration). The service reports `pending` when a deploy starts with a known
 * commit, then success / failure / error, named `ninedeploy/<slug>` (or
 * `ninedeploy/<parent-slug>/preview` for a PR preview, reported through its
 * parent's setting). A preview of a fork is never reported: its commit is not
 * in the parent's repository, and the parent's token must not touch it.
 *
 * The API host is the repository's own host (the one the clone already sends
 * this token to), or api.bitbucket.org for bitbucket.org; the request goes
 * through the egress guard. Observational only: every failure is logged
 * redacted and swallowed, so the provider being down or the token lacking the
 * scope never fails or delays a deploy.
 */

export type GitStatusProvider = 'gitlab' | 'gitea' | 'bitbucket';
const PROVIDERS: ReadonlySet<string> = new Set<GitStatusProvider>(['gitlab', 'gitea', 'bitbucket']);

export interface CommitStatusSetting {
  enabled: boolean;
}

const settingKey = (serviceId: number) => `commit_status:${serviceId}`;

export async function getCommitStatusSetting(db: DB, serviceId: number): Promise<CommitStatusSetting> {
  const stored = await getSettingJson<CommitStatusSetting>(db, settingKey(serviceId), null);
  return { enabled: stored?.enabled === true };
}

export async function setCommitStatusSetting(db: DB, serviceId: number, setting: CommitStatusSetting): Promise<void> {
  await setSettingJson(db, settingKey(serviceId), { enabled: setting.enabled });
}

/** Whether a source type can report commit statuses here. */
export const reportsCommitStatus = (type: string | null | undefined): type is GitStatusProvider => PROVIDERS.has(type ?? '');

const SHA40 = /^[0-9a-f]{40}$/;
const DESCRIPTION_MAX = 140;

/** A repository URL split into its origin and path (`group/sub/repo`), or null when it is not an https URL. */
export function parseRepoUrl(repoUrl: string): { origin: string; host: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(repoUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(path) || path.split('/').some((p) => p === '.' || p === '..')) return null;
  return { origin: url.origin, host: url.host.toLowerCase(), path };
}

/** The API request that sets one commit status, per provider. */
export function statusRequest(
  provider: GitStatusProvider,
  repo: { origin: string; host: string; path: string },
  sha: string,
  state: CommitState,
  body: { context: string; description: string; targetUrl: string | null },
): { url: string; json: Record<string, unknown> } {
  if (provider === 'gitlab') {
    const glState = state === 'pending' ? 'running' : state === 'success' ? 'success' : state === 'failure' ? 'failed' : 'canceled';
    return {
      url: `${repo.origin}/api/v4/projects/${encodeURIComponent(repo.path)}/statuses/${sha}`,
      json: { state: glState, name: body.context, description: body.description, ...(body.targetUrl ? { target_url: body.targetUrl } : {}) },
    };
  }
  if (provider === 'gitea') {
    const [owner, name] = repo.path.split('/');
    return {
      url: `${repo.origin}/api/v1/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/statuses/${sha}`,
      json: { state, context: body.context, description: body.description, ...(body.targetUrl ? { target_url: body.targetUrl } : {}) },
    };
  }
  // Bitbucket Cloud only: Server/Data Center has another API and is refused in target().
  const [workspace, slug] = repo.path.split('/');
  const api = 'https://api.bitbucket.org';
  const bbState = state === 'pending' ? 'INPROGRESS' : state === 'success' ? 'SUCCESSFUL' : state === 'failure' ? 'FAILED' : 'STOPPED';
  return {
    url: `${api}/2.0/repositories/${encodeURIComponent(workspace!)}/${encodeURIComponent(slug!)}/commit/${sha}/statuses/build`,
    // Bitbucket requires a url; the repository itself stands in when the service has no domain.
    json: { key: body.context.slice(0, 40), name: body.context, state: bbState, description: body.description, url: body.targetUrl ?? `${repo.origin}/${repo.path}` },
  };
}

function statusDescription(state: CommitState, service: Service): string {
  const name = service.name.trim();
  const text =
    state === 'pending' ? `Deploying ${name}` : state === 'success' ? `Deployed ${name}` : state === 'failure' ? `Deploy of ${name} failed` : `Deploy of ${name} was cancelled`;
  return text.slice(0, DESCRIPTION_MAX);
}

interface Target {
  service: Service;
  owner: Service;
  provider: GitStatusProvider;
  token: string;
  repo: { origin: string; host: string; path: string };
}

/** Everything one report needs, or null when this deploy does not report (off, no source, a fork, an odd URL). */
async function target(db: DB, serviceId: number): Promise<Target | null> {
  const service = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!service || service.previewFromFork) return null;
  const owner = service.previewParentServiceId != null ? await db.query.services.findFirst({ where: eq(services.id, service.previewParentServiceId) }) : service;
  if (!owner || !(await getCommitStatusSetting(db, owner.id)).enabled) return null;
  if (!owner.sourceId || !owner.repoUrl) return null;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, owner.sourceId) });
  if (!src || !reportsCommitStatus(src.type) || !src.tokenEncrypted) return null;
  const repo = parseRepoUrl(owner.repoUrl);
  if (!repo) return null;
  if (src.type === 'bitbucket' && repo.host !== 'bitbucket.org') return null;
  // Gitea and Bitbucket address a repository as owner/name; nested paths are GitLab's.
  if (src.type !== 'gitlab' && repo.path.split('/').length !== 2) return null;
  // A self-hosted source names its server: never send its token to another host.
  if (src.baseUrl) {
    const base = parseRepoUrl(`${src.baseUrl.replace(/\/+$/, '')}/x/y`);
    if (!base || base.host !== repo.host) return null;
  }
  return { service, owner, provider: src.type, token: decrypt(src.tokenEncrypted), repo };
}

async function firstDomainUrl(db: DB, serviceId: number): Promise<string | null> {
  const row = await db.query.domains.findFirst({ where: eq(domains.serviceId, serviceId), orderBy: [asc(domains.id)] });
  return row?.hostname ? `https://${row.hostname}` : null;
}

/** Test seam: how a status is sent. */
export const commitStatusDeps = { fetch: guardedFetch };

async function report(db: DB, log: FeedbackLog, serviceId: number, sha: string | null | undefined, state: CommitState): Promise<void> {
  const commit = (sha ?? '').trim().toLowerCase();
  if (!SHA40.test(commit)) return;
  let secret: string | null = null;
  try {
    const t = await target(db, serviceId);
    if (!t) return;
    secret = t.token;
    const context = t.service.id !== t.owner.id ? `ninedeploy/${t.owner.slug}/preview` : `ninedeploy/${t.service.slug}`;
    const req = statusRequest(t.provider, t.repo, commit, state, {
      context,
      description: statusDescription(state, t.service),
      targetUrl: await firstDomainUrl(db, t.service.id),
    });
    const res = await commitStatusDeps.fetch(req.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(t.provider === 'gitlab' ? { 'private-token': t.token } : { authorization: `${t.provider === 'gitea' ? 'token' : 'Bearer'} ${t.token}` }),
      },
      body: JSON.stringify(req.json),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${t.provider} answered ${res.status} for the commit status`);
  } catch (err) {
    try {
      log.warn({ serviceId, state, error: redactSecrets(err, secret ? [secret] : []) }, 'Commit status failed (the deploy is unaffected)');
    } catch {
      /* a logger failure must not escape either */
    }
  }
}

/** `service.deploying`: a pending status, when the commit is already known. */
export async function deployingCommitStatus(db: DB, log: FeedbackLog, serviceId: number, deploymentId: number): Promise<void> {
  try {
    const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
    await report(db, log, serviceId, dep?.commitSha, 'pending');
  } catch {
    /* observational */
  }
}

/** `deployment.status_changed`: the final status. */
export async function outcomeCommitStatus(db: DB, log: FeedbackLog, deploymentId: number | undefined, status: string | undefined): Promise<void> {
  const state = commitStateFor(status);
  if (!state || typeof deploymentId !== 'number') return;
  try {
    const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
    if (dep) await report(db, log, dep.serviceId, dep.commitSha, state);
  } catch {
    /* observational */
  }
}
