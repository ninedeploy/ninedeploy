import { eq, inArray } from 'drizzle-orm';
import { services, settings, type DB, type Service } from '@ninedeploy/db';
import { gitPollConfig, type GitPollConfig, type GitPollView } from '@ninedeploy/schemas';
import { remoteBranchHead } from './git.js';
import { gitPollStored, type GitPollStored } from './ownedSettingSchemas.js';
import { getSettingJson, setSettingJson } from './settings.js';
import { settingRowsWithPrefix } from './settingRows.js';
import { resolveCloneCreds } from './sourceCreds.js';
import { type Provider } from './webhooks.js';
import { handlePush } from './webhookDispatch.js';

/**
 * X2 Git polling. Opt-in per service (`git_poll:<id>`), for a server that
 * cannot receive webhooks: every `intervalSeconds` the head of the service's
 * branch is read with `git ls-remote` (lib/git.ts `remoteBranchHead`: the
 * egress gate, the pinned addresses and the source's credential, as for a
 * checkout), and a head the poll has not seen goes through `handlePush`, the
 * webhook path, with its CI gate, its privilege check and its duplicate guard.
 *
 * A poll sees the head and nothing else. Watch paths and `[skip cd]` markers
 * are read from a push payload, so they do not apply to a poll; the panel
 * says so where polling is turned on.
 *
 * The row also holds what the last poll found. `lastSha` is the head the
 * poll last acted on, deployed or not: a head it sees again deploys nothing,
 * so a deploy that failed is not retried every interval. A new commit, or a
 * redeploy, starts one. The first poll compares with the commit the service
 * runs, and so does every later one: a head the service runs is left alone,
 * even when a webhook deployed it between two polls. No migration: the
 * settings row is the state.
 */

const PREFIX = 'git_poll:';
const key = (serviceId: number) => `${PREFIX}${serviceId}`;

export type { GitPollStored };

export async function getGitPoll(db: DB, serviceId: number): Promise<GitPollStored | null> {
  const parsed = gitPollStored.safeParse(await getSettingJson<unknown>(db, key(serviceId), null));
  return parsed.success ? parsed.data : null;
}

export function gitPollView(stored: GitPollStored | null, svc: Pick<Service, 'repoUrl'>): GitPollView {
  return {
    supported: gitPollSupported(svc),
    poll: stored ? { intervalSeconds: stored.intervalSeconds } : null,
    lastSha: stored?.lastSha ?? null,
    lastPolledAt: stored?.lastPolledAt ?? null,
    lastError: stored?.lastError ?? null,
    lastDeploymentId: stored?.lastDeploymentId ?? null,
  };
}

/** Turning polling off removes the row, and with it what the polls found. Changing the interval keeps it. */
export async function setGitPoll(db: DB, serviceId: number, poll: GitPollConfig | null): Promise<void> {
  if (poll === null) {
    await db.delete(settings).where(eq(settings.key, key(serviceId)));
    return;
  }
  const prev = await getGitPoll(db, serviceId);
  await setSettingJson(db, key(serviceId), gitPollStored.parse({ ...(prev ?? {}), ...gitPollConfig.parse(poll) }));
}

/** Polling reads a repository, so it is for a service that has one. */
export function gitPollSupported(svc: Pick<Service, 'repoUrl'>): boolean {
  return !!svc.repoUrl;
}

/**
 * The provider a repository is hosted with, read from its URL. It is named
 * in the deploy's dispatch result and decides nothing else.
 */
export function gitProviderOf(repoUrl: string): Provider {
  // `https://host/path`, `ssh://git@host/path` and `git@host:path` alike.
  const match = /^(?:[a-z]+:\/\/)?(?:[^@/]+@)?([^/:]+)/.exec(repoUrl);
  const host = match?.[1]?.toLowerCase() ?? '';
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  if (host.includes('bitbucket')) return 'bitbucket';
  return 'gitea';
}

export interface GitPollDeps {
  now?: number;
  /** Reads the head of the service's branch on its remote; null when the remote has no such branch. */
  head?: (svc: Service, db: DB) => Promise<string | null>;
  push?: typeof handlePush;
}

export interface GitPollSummary {
  /** The polls that ran. */
  due: number;
  queued: number;
  /** A head seen before, or the commit the service already runs. */
  unchanged: number;
  /** Polls that could not get a verdict: the head was not read, or the deploy was refused. */
  failed: number;
}

async function defaultHead(svc: Service, db: DB): Promise<string | null> {
  const creds = await resolveCloneCreds(db, { id: svc.id, name: svc.name, sourceId: svc.sourceId, repoUrl: svc.repoUrl });
  return remoteBranchHead(svc.repoUrl!, svc.branch!, creds, { timeoutMs: 20_000 });
}

/**
 * Poll every service whose polling is due, one after another. A poll is due
 * when its interval has passed since its last run. It is marked as run
 * before it starts, so a slow one is not started twice. Errors are kept on
 * the service (`lastError`) and never stop the other polls.
 */
export async function pollDueGitServices(db: DB, deps: GitPollDeps = {}): Promise<GitPollSummary> {
  const now = deps.now ?? Date.now();
  const summary: GitPollSummary = { due: 0, queued: 0, unchanged: 0, failed: 0 };
  const due = new Map<number, GitPollStored>();
  for (const row of await settingRowsWithPrefix(db, PREFIX)) {
    const parsed = gitPollStored.safeParse(row.value);
    if (!parsed.success || !row.key.startsWith(PREFIX)) continue;
    const id = Number(row.key.slice(PREFIX.length));
    if (!Number.isInteger(id) || id <= 0) continue;
    const last = parsed.data.lastPolledAt ? Date.parse(parsed.data.lastPolledAt) : Number.NaN;
    if (Number.isFinite(last) && now - last < parsed.data.intervalSeconds * 1000) continue;
    due.set(id, parsed.data);
  }
  if (due.size === 0) return summary;
  const save = (serviceId: number, stored: GitPollStored) => setSettingJson(db, key(serviceId), stored);
  const found = await db.query.services.findMany({ where: inArray(services.id, [...due.keys()]) });
  for (const svc of found) {
    if (!gitPollSupported(svc) || !svc.branch) {
      // Nothing to ask any more, say since the service was switched to an image: polling turns itself off,
      // rather than staying due on every tick behind a card that is no longer shown.
      await db.delete(settings).where(eq(settings.key, key(svc.id)));
      continue;
    }
    const before = due.get(svc.id)!;
    summary.due++;
    const ran: GitPollStored = { ...before, lastPolledAt: new Date(now).toISOString() };
    await save(svc.id, ran);
    try {
      const head = await (deps.head ?? defaultHead)(svc, db);
      if (head === null) throw new Error(`the remote has no branch ${svc.branch}`);
      if (head === before.lastSha) {
        await save(svc.id, { ...ran, lastError: null });
        summary.unchanged++;
        continue;
      }
      let deploymentId = before.lastDeploymentId ?? null;
      let queued = false;
      // A head the service runs is left alone, whether the first poll found it there or a webhook
      // deployed it between two polls: the duplicate guard below only covers a deploy still in progress.
      if (head !== svc.commitSha) {
        const result = await (deps.push ?? handlePush)(
          db,
          svc.id,
          { branch: svc.branch, sha: head, message: '', author: '', changedFiles: [], commitsListed: 0 },
          // A poll reads the head only: no commit message and no changed files, so the
          // webhook's watch paths and `[skip cd]` markers have nothing to act on here.
          { branch: svc.branch, watchPaths: null, provider: gitProviderOf(svc.repoUrl!) },
        );
        if (typeof result.deploymentId === 'number') deploymentId = result.deploymentId;
        queued = result.ok === true;
      }
      await save(svc.id, { ...ran, lastSha: head, lastError: null, lastDeploymentId: deploymentId });
      if (queued) summary.queued++;
      else summary.unchanged++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      await save(svc.id, { ...ran, lastError: message });
      summary.failed++;
    }
  }
  return summary;
}
