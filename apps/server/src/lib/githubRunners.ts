import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { githubAppInstallations, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';
import {
  GITHUB_RUNNER_DEFAULTS,
  GITHUB_RUNNER_IMAGE,
  githubRepoFullName,
  githubRunnerConfig,
  type GithubRunnerConfig,
  type GithubRunnerStatus,
} from '@ninedeploy/schemas';
import { audit } from './audit.js';
import { capture } from './exec.js';
import { GithubAppError, githubApi, installationToken } from './githubApp.js';
import { writeSecretFile } from './secretFile.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * Self-hosted GitHub Actions runners (G4.5).
 *
 * A GitHub App that subscribes to `workflow_job` gets one delivery per queued
 * job. For a job whose `runs-on` matches this App's runner labels, the panel
 * asks GitHub for a just-in-time runner configuration (single-use, bound to
 * one runner) and starts one `actions-runner` container on the panel host with
 * it. The runner takes one job and exits; `--rm` removes the container.
 *
 * Isolation: the container never gets the Docker socket, runs on its own
 * bridge network (not on any service network), with CPU, memory and pid
 * limits. Workflows that need Docker themselves (`container:`, `services:`,
 * `docker build`) therefore do not run here. Public repositories are refused
 * unless the operator allows them: anyone can open a pull request there.
 *
 * Jobs beyond `maxConcurrent` wait in memory and start as slots free up (the
 * scheduler plugin calls {@link sweepGithubRunners}). The queue does not
 * survive a panel restart; GitHub keeps such a job queued until some runner
 * picks it up or it times out after 24 hours.
 */

export const RUNNER_NETWORK = 'nd-gha-runners';
const LABEL = 'ninedeploy.gha-runner';
const settingKey = (githubAppId: number) => `github_runners:${githubAppId}`;

/** GitHub cancels a job that waits for a runner this long. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** A runner that has not picked up a job by then is removed. */
const IDLE_REAP_MS = 10 * 60 * 1000;
/** No job runs longer than GitHub's own 6-hour cap; anything older is stuck. */
const MAX_RUNNER_AGE_MS = 6 * 60 * 60 * 1000 + 15 * 60 * 1000;
const DOCKER_RUN_TIMEOUT_MS = 10 * 60 * 1000;

// ── configuration ──────────────────────────────────────────────────────────

export async function getRunnerConfig(db: DB, githubAppId: number): Promise<GithubRunnerConfig> {
  const stored = await getSettingJson<unknown>(db, settingKey(githubAppId));
  const parsed = githubRunnerConfig.safeParse({ ...GITHUB_RUNNER_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) });
  return parsed.success ? parsed.data : { ...GITHUB_RUNNER_DEFAULTS };
}

export async function setRunnerConfig(db: DB, githubAppId: number, config: GithubRunnerConfig): Promise<void> {
  await setSettingJson(db, settingKey(githubAppId), config);
}

// ── job matching ───────────────────────────────────────────────────────────

/** Where a just-in-time runner is registered, and the permission that takes. */
export type RunnerScope = { kind: 'org'; org: string } | { kind: 'repo'; repo: string; repoId: number };

export function runnerScope(inst: Pick<GithubAppInstallation, 'accountType' | 'accountLogin'>, repo: string, repoId: number): RunnerScope {
  return inst.accountType === 'Organization' && inst.accountLogin
    ? { kind: 'org', org: inst.accountLogin }
    : { kind: 'repo', repo, repoId };
}

export function scopePermission(scope: RunnerScope): string {
  return scope.kind === 'org' ? 'organization_self_hosted_runners' : 'administration';
}

const hostArchLabel = (): string => (process.arch === 'arm64' ? 'arm64' : 'x64');

/**
 * Why a queued job is not taken, or null when it is. The labels rule mirrors
 * GitHub's assignment: a runner gets a job only when it carries every label
 * in `runs-on`, so a job is ours when all its labels are ours or GitHub's
 * defaults, and at least one is a label the operator configured.
 */
export function jobRefusal(
  config: GithubRunnerConfig,
  job: { labels: string[]; repo: string; isPrivate: boolean },
  arch: string = hostArchLabel(),
): string | null {
  if (!config.enabled) return 'runners_disabled';
  const own = new Set(config.labels.map((l) => l.toLowerCase()));
  const defaults = new Set<string>(['self-hosted', 'linux', arch]);
  const labels = job.labels.map((l) => l.toLowerCase());
  if (!labels.some((l) => own.has(l))) return 'labels_not_ours';
  if (!labels.every((l) => own.has(l) || defaults.has(l))) return 'labels_unmatched';
  if (!job.isPrivate && !config.allowPublicRepos) return 'public_repository';
  if (config.repositories.length > 0 && !config.repositories.some((r) => r.toLowerCase() === job.repo.toLowerCase())) {
    return 'repository_not_allowed';
  }
  return null;
}

// ── pending queue ──────────────────────────────────────────────────────────

interface PendingJob {
  githubAppId: number;
  installationRowId: number;
  jobId: number;
  repo: string;
  repoId: number;
  jobName: string | null;
  queuedAt: number;
}

const pending = new Map<string, PendingJob>();
const pendingKey = (githubAppId: number, jobId: number) => `${githubAppId}:${jobId}`;

/** Test seam. */
export function resetGithubRunnersForTests(): void {
  pending.clear();
  drainChain = Promise.resolve();
}

// ── docker ─────────────────────────────────────────────────────────────────

export interface RunnerContainer {
  name: string;
  githubAppId: number | null;
  jobId: number | null;
  repo: string | null;
  runnerId: number | null;
  scope: string | null;
  state: string;
  createdAt: Date | null;
}

/** Every runner container on the panel host (running or not). */
export async function listRunnerContainers(): Promise<RunnerContainer[]> {
  const format = [
    '{{.Names}}',
    '{{.State}}',
    '{{.CreatedAt}}',
    `{{.Label "${LABEL}.app"}}`,
    `{{.Label "${LABEL}.job"}}`,
    `{{.Label "${LABEL}.repo"}}`,
    `{{.Label "${LABEL}.runner"}}`,
    `{{.Label "${LABEL}.scope"}}`,
  ].join('\t');
  const raw = await capture('docker', ['ps', '-a', '--filter', `label=${LABEL}=1`, '--format', format], { timeoutMs: 30_000 });
  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name = '', state = '', created = '', app, job, repo, runner, scope] = line.split('\t');
      // `2026-10-28 10:00:00 +0300 +03`: drop the zone name Date cannot read.
      const at = new Date(created.replace(/ [A-Z+-][A-Za-z0-9+-]*$/, ''));
      return {
        name,
        state,
        createdAt: Number.isNaN(at.getTime()) ? null : at,
        githubAppId: num(app),
        jobId: num(job),
        repo: repo || null,
        runnerId: num(runner),
        scope: scope || null,
      };
    });
}

async function ensureRunnerNetwork(): Promise<void> {
  const existing = (await capture('docker', ['network', 'ls', '-q', '--filter', `name=^${RUNNER_NETWORK}$`], { timeoutMs: 30_000 })).trim();
  if (!existing) {
    await capture('docker', ['network', 'create', '--label', `${LABEL}=1`, RUNNER_NETWORK], { timeoutMs: 30_000 }).catch(async (err) => {
      // Two starts racing: the other one created it.
      const again = (await capture('docker', ['network', 'ls', '-q', '--filter', `name=^${RUNNER_NETWORK}$`], { timeoutMs: 30_000 })).trim();
      if (!again) throw err;
    });
  }
}

/** The `docker run` arguments for one runner; the JIT config travels in the env file, never argv. */
export function runnerRunArgs(
  config: GithubRunnerConfig,
  meta: { name: string; githubAppId: number; jobId: number; repo: string; runnerId: number; scope: string },
  envFile: string,
): string[] {
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    meta.name,
    '--label',
    `${LABEL}=1`,
    '--label',
    `${LABEL}.app=${meta.githubAppId}`,
    '--label',
    `${LABEL}.job=${meta.jobId}`,
    '--label',
    `${LABEL}.repo=${meta.repo}`,
    '--label',
    `${LABEL}.runner=${meta.runnerId}`,
    '--label',
    `${LABEL}.scope=${meta.scope}`,
    '--network',
    RUNNER_NETWORK,
    '--pids-limit',
    '4096',
    ...(config.cpus != null ? ['--cpus', String(config.cpus)] : []),
    ...(config.memoryMb != null ? ['--memory', `${config.memoryMb}m`] : []),
    '--env-file',
    envFile,
    GITHUB_RUNNER_IMAGE,
    '/bin/bash',
    '-c',
    'exec ./run.sh --jitconfig "$ND_JITCONFIG"',
  ];
}

async function removeContainer(name: string): Promise<void> {
  await capture('docker', ['rm', '-f', name], { timeoutMs: 60_000 }).catch(() => undefined);
}

// ── GitHub calls ───────────────────────────────────────────────────────────

const scopeLabel = (scope: RunnerScope) => (scope.kind === 'org' ? `org:${scope.org}` : `repo:${scope.repo}`);

function runnersPath(scope: RunnerScope): string {
  return scope.kind === 'org'
    ? `/orgs/${encodeURIComponent(scope.org)}/actions/runners`
    : `/repos/${scope.repo}/actions/runners`;
}

async function scopeToken(db: DB, ghApp: GithubApp, inst: GithubAppInstallation, scope: RunnerScope): Promise<string> {
  return installationToken(db, ghApp, inst, {
    permissions: { [scopePermission(scope)]: 'write' },
    ...(scope.kind === 'repo' ? { repositoryIds: [scope.repoId] } : {}),
  });
}

/** Parse `org:<login>` / `repo:<owner/name>` back from a container label. */
function parseScopeLabel(label: string | null): { kind: 'org'; org: string } | { kind: 'repo'; repo: string } | null {
  if (!label) return null;
  if (label.startsWith('org:')) return { kind: 'org', org: label.slice(4) };
  if (label.startsWith('repo:') && githubRepoFullName.safeParse(label.slice(5)).success) return { kind: 'repo', repo: label.slice(5) };
  return null;
}

// ── start ──────────────────────────────────────────────────────────────────

async function loadInstallation(db: DB, id: number): Promise<GithubAppInstallation | undefined> {
  return db.query.githubAppInstallations.findFirst({
    where: and(eq(githubAppInstallations.id, id), isNull(githubAppInstallations.removedAt), isNull(githubAppInstallations.suspendedAt)),
  });
}

async function startRunner(db: DB, log: FastifyBaseLogger, ghApp: GithubApp, job: PendingJob, config: GithubRunnerConfig): Promise<void> {
  const inst = await loadInstallation(db, job.installationRowId);
  if (!inst) return;
  const scope = runnerScope(inst, job.repo, job.repoId);
  const token = await scopeToken(db, ghApp, inst, scope);
  const runnerName = `nd-${ghApp.id}-${job.jobId}-${randomBytes(3).toString('hex')}`;
  const res = await githubApi<{ runner?: { id?: number }; encoded_jit_config?: string }>(
    ghApp,
    token,
    'POST',
    `${runnersPath(scope)}/generate-jitconfig`,
    { name: runnerName, runner_group_id: 1, labels: config.labels, work_folder: '_work' },
  );
  const jit = res.data?.encoded_jit_config;
  const runnerId = res.data?.runner?.id;
  if (typeof jit !== 'string' || !jit || !Number.isSafeInteger(runnerId)) throw new Error('GitHub answered without a runner configuration');

  await ensureRunnerNetwork();
  const envFile = writeSecretFile('nd-gha', 'runner.env', `ND_JITCONFIG=${jit}\n`);
  try {
    await capture(
      'docker',
      runnerRunArgs(config, { name: runnerName, githubAppId: ghApp.id, jobId: job.jobId, repo: job.repo, runnerId: runnerId as number, scope: scopeLabel(scope) }, envFile.path),
      { timeoutMs: DOCKER_RUN_TIMEOUT_MS },
    );
  } catch (err) {
    // The registration would otherwise linger as an offline runner.
    await githubApi(ghApp, token, 'DELETE', `${runnersPath(scope)}/${runnerId}`).catch(() => undefined);
    throw err;
  } finally {
    envFile.cleanup();
  }
  log.info({ component: 'github-runners', githubAppId: ghApp.id, jobId: job.jobId, repo: job.repo, runner: runnerName }, 'started a just-in-time runner');
}

let drainChain: Promise<void> = Promise.resolve();

/**
 * Start as many waiting jobs as free slots allow. Serialized, so two
 * deliveries never both see the same free slot.
 */
export function drainPending(db: DB, log: FastifyBaseLogger, opts: { recheck?: boolean } = {}): Promise<void> {
  const next = drainChain.then(() => drainOnce(db, log, opts)).catch((err) => {
    log.warn({ err, component: 'github-runners' }, 'runner queue drain failed');
  });
  drainChain = next;
  return next;
}

async function drainOnce(db: DB, log: FastifyBaseLogger, opts: { recheck?: boolean }): Promise<void> {
  if (pending.size === 0) return;
  const now = Date.now();
  const containers = await listRunnerContainers();
  const byApp = new Map<number, PendingJob[]>();
  for (const job of [...pending.values()].sort((a, b) => a.queuedAt - b.queuedAt)) {
    if (now - job.queuedAt > PENDING_TTL_MS) {
      pending.delete(pendingKey(job.githubAppId, job.jobId));
      continue;
    }
    byApp.set(job.githubAppId, [...(byApp.get(job.githubAppId) ?? []), job]);
  }
  for (const [githubAppId, jobs] of byApp) {
    const ghApp = await db.query.githubApps.findFirst({ where: (t, { eq: is }) => is(t.id, githubAppId) });
    if (!ghApp) {
      for (const job of jobs) pending.delete(pendingKey(githubAppId, job.jobId));
      continue;
    }
    const config = await getRunnerConfig(db, githubAppId);
    if (!config.enabled) {
      for (const job of jobs) pending.delete(pendingKey(githubAppId, job.jobId));
      continue;
    }
    let running = containers.filter((c) => c.githubAppId === githubAppId).length;
    for (const job of jobs) {
      if (running >= config.maxConcurrent) break;
      const key = pendingKey(githubAppId, job.jobId);
      if (opts.recheck && !(await stillQueued(db, ghApp, job))) {
        pending.delete(key);
        continue;
      }
      pending.delete(key);
      running += 1;
      try {
        await startRunner(db, log, ghApp, job, config);
      } catch (err) {
        log.warn({ err, component: 'github-runners', githubAppId, jobId: job.jobId }, 'could not start a runner');
        await audit(db, null, 'github_runner.failed', job.repo, {
          githubAppId,
          jobId: job.jobId,
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        });
      }
    }
  }
}

/** Whether GitHub still has the job waiting (a job that waited is often taken by another runner or cancelled). */
async function stillQueued(db: DB, ghApp: GithubApp, job: PendingJob): Promise<boolean> {
  const inst = await loadInstallation(db, job.installationRowId);
  if (!inst) return false;
  try {
    const token = await installationToken(db, ghApp, inst, { permissions: { actions: 'read' }, repositoryIds: [job.repoId] });
    const res = await githubApi<{ status?: string }>(ghApp, token, 'GET', `/repos/${job.repo}/actions/jobs/${job.jobId}`);
    return res.data?.status === 'queued';
  } catch {
    // Unknown: keep waiting rather than drop a job.
    return true;
  }
}

// ── webhook ────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

export interface WorkflowJobResult {
  ok: true | 'ignored';
  action?: string;
  reason?: string;
  jobId?: number;
}

/**
 * `workflow_job` delivery. `queued` enqueues a matching job and starts the
 * drain without waiting for it (GitHub gives a delivery 10 seconds); any
 * later action drops the job from the queue, since some runner has it.
 */
export async function handleWorkflowJob(
  db: DB,
  log: FastifyBaseLogger,
  ghApp: GithubApp,
  inst: GithubAppInstallation,
  body: Json,
): Promise<WorkflowJobResult> {
  const job = obj(body['workflow_job']);
  const repo = obj(body['repository']);
  const jobId = Number(job?.['id']);
  const repoId = Number(repo?.['id']);
  const fullName = typeof repo?.['full_name'] === 'string' ? repo['full_name'] : '';
  if (!job || !Number.isSafeInteger(jobId) || jobId <= 0 || !Number.isSafeInteger(repoId) || repoId <= 0) {
    return { ok: 'ignored', reason: 'invalid_workflow_job' };
  }
  if (!githubRepoFullName.safeParse(fullName).success) return { ok: 'ignored', reason: 'invalid_repository' };
  const action = body['action'];
  const key = pendingKey(ghApp.id, jobId);
  if (action !== 'queued') {
    pending.delete(key);
    return { ok: true, action: 'runner_job_updated', jobId };
  }
  const labels = Array.isArray(job['labels']) ? job['labels'].filter((l): l is string => typeof l === 'string').slice(0, 50) : [];
  const config = await getRunnerConfig(db, ghApp.id);
  const refusal = jobRefusal(config, { labels, repo: fullName, isPrivate: repo?.['private'] === true });
  if (refusal) return { ok: 'ignored', reason: refusal, jobId };
  if (!pending.has(key)) {
    pending.set(key, {
      githubAppId: ghApp.id,
      installationRowId: inst.id,
      jobId,
      repo: fullName,
      repoId,
      jobName: typeof job['name'] === 'string' ? job['name'].slice(0, 200) : null,
      queuedAt: Date.now(),
    });
  }
  void drainPending(db, log);
  return { ok: true, action: 'runner_queued', jobId };
}

// ── sweep ──────────────────────────────────────────────────────────────────

/**
 * Periodic upkeep: start waiting jobs (re-checking each still waits), and
 * remove runners that never picked up a job or outlived any job.
 */
export async function sweepGithubRunners(db: DB, log: FastifyBaseLogger, now: number = Date.now()): Promise<void> {
  // Nothing to do (and no Docker call) on a panel that never turned runners on.
  const apps = await db.query.githubApps.findMany({ columns: { id: true } });
  const anyEnabled = (await Promise.all(apps.map((a) => getRunnerConfig(db, a.id)))).some((c) => c.enabled);
  if (!anyEnabled && pending.size === 0) return;
  await drainPending(db, log, { recheck: true });
  let containers: RunnerContainer[];
  try {
    containers = await listRunnerContainers();
  } catch {
    return; // no Docker: nothing to reap
  }
  for (const c of containers) {
    const age = c.createdAt ? now - c.createdAt.getTime() : 0;
    if (c.state !== 'running') {
      await removeContainer(c.name);
      continue;
    }
    if (age > MAX_RUNNER_AGE_MS) {
      await reapRunner(db, log, c, 'outlived the 6-hour job limit');
      continue;
    }
    if (age > IDLE_REAP_MS && !(await runnerBusy(db, c))) await reapRunner(db, log, c, 'never picked up a job');
  }
}

async function appAndToken(db: DB, c: RunnerContainer): Promise<{ ghApp: GithubApp; token: string; path: string } | null> {
  const scope = parseScopeLabel(c.scope);
  if (!scope || c.githubAppId == null || c.runnerId == null) return null;
  const ghApp = await db.query.githubApps.findFirst({ where: (t, { eq: is }) => is(t.id, c.githubAppId as number) });
  if (!ghApp) return null;
  const installations = await db.query.githubAppInstallations.findMany({
    where: and(eq(githubAppInstallations.githubAppId, ghApp.id), isNull(githubAppInstallations.removedAt)),
  });
  const owner = scope.kind === 'org' ? scope.org : scope.repo.split('/')[0];
  const inst = installations.find((i) => i.accountLogin?.toLowerCase() === owner?.toLowerCase());
  if (!inst) return null;
  const permission = scope.kind === 'org' ? 'organization_self_hosted_runners' : 'administration';
  const token = await installationToken(db, ghApp, inst, { permissions: { [permission]: 'write' } });
  const base = scope.kind === 'org' ? `/orgs/${encodeURIComponent(scope.org)}/actions/runners` : `/repos/${scope.repo}/actions/runners`;
  return { ghApp, token, path: `${base}/${c.runnerId}` };
}

/** Whether GitHub reports the runner busy; unknown counts as busy, so a working runner is never cut off. */
async function runnerBusy(db: DB, c: RunnerContainer): Promise<boolean> {
  try {
    const ctx = await appAndToken(db, c);
    if (!ctx) return true;
    const res = await githubApi<{ busy?: boolean }>(ctx.ghApp, ctx.token, 'GET', ctx.path);
    return res.data?.busy !== false;
  } catch (err) {
    // 404: GitHub already dropped the registration (ephemeral runner done).
    return !(err instanceof GithubAppError && err.status === 404);
  }
}

async function reapRunner(db: DB, log: FastifyBaseLogger, c: RunnerContainer, reason: string): Promise<void> {
  await removeContainer(c.name);
  try {
    const ctx = await appAndToken(db, c);
    if (ctx) await githubApi(ctx.ghApp, ctx.token, 'DELETE', ctx.path);
  } catch {
    /* the ephemeral registration expires on its own */
  }
  log.info({ component: 'github-runners', runner: c.name, reason }, 'removed a runner');
}

/** Stop one runner by name (operator action). Only names this module created. */
export async function stopRunner(db: DB, log: FastifyBaseLogger, githubAppId: number, name: string): Promise<boolean> {
  const c = (await listRunnerContainers()).find((x) => x.name === name && x.githubAppId === githubAppId);
  if (!c) return false;
  await reapRunner(db, log, c, 'stopped by an operator');
  return true;
}

// ── status ─────────────────────────────────────────────────────────────────

/** What still keeps runners from working for this App. */
export async function runnerProblems(db: DB, ghApp: GithubApp, config: GithubRunnerConfig): Promise<string[]> {
  if (!config.enabled) return [];
  const problems: string[] = [];
  if (!(ghApp.events ?? []).includes('workflow_job')) {
    problems.push('The GitHub App does not subscribe to the "Workflow job" event. Turn it on under the App\'s Permissions & events.');
  }
  const installations = await db.query.githubAppInstallations.findMany({
    where: and(eq(githubAppInstallations.githubAppId, ghApp.id), isNull(githubAppInstallations.removedAt)),
  });
  if (installations.length === 0) problems.push('The GitHub App is not installed on any account yet.');
  for (const inst of installations) {
    const permission = inst.accountType === 'Organization' ? 'organization_self_hosted_runners' : 'administration';
    if (inst.permissions?.[permission] !== 'write') {
      problems.push(
        `The installation on ${inst.accountLogin ?? `#${inst.installationId}`} lacks "${permission}: write". Add it to the App and accept it on the installation.`,
      );
    }
  }
  return problems;
}

export async function runnerStatus(db: DB, ghApp: GithubApp): Promise<GithubRunnerStatus> {
  const config = await getRunnerConfig(db, ghApp.id);
  let containers: RunnerContainer[] = [];
  const problems = await runnerProblems(db, ghApp, config);
  try {
    containers = await listRunnerContainers();
  } catch {
    if (config.enabled) problems.push('Docker is not reachable on the panel host.');
  }
  return {
    config,
    image: GITHUB_RUNNER_IMAGE,
    problems,
    pending: [...pending.values()]
      .filter((p) => p.githubAppId === ghApp.id)
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .map((p) => ({ jobId: p.jobId, repo: p.repo, jobName: p.jobName, queuedAt: new Date(p.queuedAt).toISOString() })),
    active: containers
      .filter((c) => c.githubAppId === ghApp.id)
      .map((c) => ({ name: c.name, jobId: c.jobId, repo: c.repo, state: c.state, startedAt: c.createdAt?.toISOString() ?? null })),
  };
}

/** Drop this App's waiting jobs (runners turned off or the App deleted). */
export function forgetPending(githubAppId: number): void {
  for (const [key, job] of pending) if (job.githubAppId === githubAppId) pending.delete(key);
}
