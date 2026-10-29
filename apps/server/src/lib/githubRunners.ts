import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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
import { GithubAppError, githubApi, installationToken, listInstallationRepositories } from './githubApp.js';
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
 * limits. Firewall rules on that bridge drop traffic to the host itself and
 * to private, link-local (cloud metadata) and CGNAT ranges, so a job reaches
 * the internet but not the panel, its services or the LAN; a runner never
 * starts without them unless `NINEDEPLOY_GHA_RUNNERS_UNISOLATED=1`. An
 * organization runner registers in an App-owned runner group that GitHub
 * opens only to the allowed repositories, so the allow-list holds for which
 * job a runner takes, not only for when one is started. Workflows that need Docker themselves (`container:`, `services:`,
 * `docker build`) therefore do not run here. Public repositories are refused
 * unless the operator allows them: anyone can open a pull request there.
 *
 * On a node (config `serverId`, agent 0.18.7 with the opt-in `gha.runner`)
 * the node's agent creates the same network, puts the same firewall rules on
 * its host and starts the same container; the JIT configuration reaches it
 * only inside a sealed request (agentOps/githubRunners.ts).
 *
 * Jobs beyond `maxConcurrent` wait in memory and start as slots free up (the
 * scheduler plugin calls {@link sweepGithubRunners}). The queue does not
 * survive a panel restart; GitHub keeps such a job queued until some runner
 * picks it up or it times out after 24 hours.
 */

export const RUNNER_NETWORK = 'nd-gha-runners';
/** The bridge interface of {@link RUNNER_NETWORK}, named so firewall rules can match it. */
export const RUNNER_BRIDGE = 'nd-gha0';
/** Destinations a runner may not reach: private, loopback, link-local (cloud metadata), CGNAT, multicast. */
export const BLOCKED_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '224.0.0.0/4'];
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
/** The last runner start that failed, per App, until one succeeds (shown in the status). */
const lastFailure = new Map<number, string>();
const pendingKey = (githubAppId: number, jobId: number) => `${githubAppId}:${jobId}`;

/** Test seam. */
export function resetGithubRunnersForTests(): void {
  pending.clear();
  groupCache.clear();
  lastFailure.clear();
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
  /** The node it runs on; null = the panel host. */
  serverId: number | null;
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
        serverId: null,
      };
    });
}

const NETWORK_CREATE_ARGS = [
  'network',
  'create',
  '--label',
  `${LABEL}=1`,
  '-o',
  `com.docker.network.bridge.name=${RUNNER_BRIDGE}`,
  // Runners cannot reach each other either.
  '-o',
  'com.docker.network.bridge.enable_icc=false',
  // The firewall rules are IPv4 (iptables); a daemon that turns IPv6 on for
  // new networks by default must not give runners an unfiltered IPv6 path.
  '--ipv6=false',
  RUNNER_NETWORK,
];

export async function ensureRunnerNetwork(): Promise<void> {
  const ls = async () => (await capture('docker', ['network', 'ls', '-q', '--filter', `name=^${RUNNER_NETWORK}$`], { timeoutMs: 30_000 })).trim();
  if (!(await ls())) {
    await capture('docker', NETWORK_CREATE_ARGS, { timeoutMs: 30_000 }).catch(async (err) => {
      // Two starts racing: the other one created it.
      if (!(await ls())) throw err;
    });
  }
  // Fail closed on a network someone (or an older panel) made with IPv6 or another bridge name.
  const inspect = (
    await capture(
      'docker',
      ['network', 'inspect', RUNNER_NETWORK, '--format', '{{.EnableIPv6}} {{index .Options "com.docker.network.bridge.name"}}'],
      { timeoutMs: 30_000 },
    )
  ).trim();
  if (inspect !== `false ${RUNNER_BRIDGE}`) {
    throw new Error(
      `The ${RUNNER_NETWORK} network is not the isolated runner network (IPv6 and bridge name: "${inspect}"). Remove it (docker network rm ${RUNNER_NETWORK}) and the panel recreates it.`,
    );
  }
}

/** The iptables rules that keep runners off the host and private networks. */
export function isolationRules(): Array<{ chain: string; rule: string[] }> {
  return [
    // Anything a runner sends to the host itself (panel API, databases, a Docker API on TCP).
    { chain: 'INPUT', rule: ['-i', RUNNER_BRIDGE, '-j', 'DROP'] },
    // Anything it would forward to a private or metadata address.
    ...BLOCKED_RANGES.map((cidr) => ({ chain: 'DOCKER-USER', rule: ['-i', RUNNER_BRIDGE, '-d', cidr, '-j', 'DROP'] })),
  ];
}

/**
 * G4.5 on a node: the same rules, as the fixed script the node agent runs on
 * its host (through the `nsenter` helper `host.packages` uses, since the agent
 * itself lives in a container whose iptables would not guard the host).
 * Every word is a constant of this module. Exit 3: no runner bridge; 4: no
 * iptables on the host.
 */
export function nodeIsolationScript(): string {
  const lines = [
    'set -e',
    `[ -e /sys/class/net/${RUNNER_BRIDGE} ] || { echo "the runner bridge ${RUNNER_BRIDGE} is missing on the host" >&2; exit 3; }`,
    'command -v iptables >/dev/null 2>&1 || { echo "iptables is not installed on the host" >&2; exit 4; }',
    ...isolationRules().map(({ chain, rule }) => `iptables -C ${chain} ${rule.join(' ')} 2>/dev/null || iptables -I ${chain} 1 ${rule.join(' ')}`),
  ];
  return lines.join('\n');
}

/** Names this module gives runners: `nd-<app>-<job>-<6 hex>`. */
export const RUNNER_NAME_RE = /^nd-\d+-\d+-[0-9a-f]{6}$/;

const isolationSkipped = () => process.env['NINEDEPLOY_GHA_RUNNERS_UNISOLATED'] === '1';

/**
 * Put the isolation rules in place (idempotent: `-C` first). Called before
 * every start, since a host firewall reload or a reboot drops them. Refuses
 * when the panel cannot see the runner bridge: it then runs in another
 * network namespace (a container), where its iptables would not guard the host.
 */
export async function ensureRunnerIsolation(bridgeVisible: (iface: string) => boolean = (iface) => existsSync(`/sys/class/net/${iface}`)): Promise<void> {
  if (isolationSkipped()) return;
  if (!bridgeVisible(RUNNER_BRIDGE)) {
    throw new Error(
      `The panel cannot see the runner network's bridge (${RUNNER_BRIDGE}), so it cannot firewall it. Run the panel on the host, or set NINEDEPLOY_GHA_RUNNERS_UNISOLATED=1 to run runners without isolation.`,
    );
  }
  for (const { chain, rule } of isolationRules()) {
    try {
      await capture('iptables', ['-C', chain, ...rule], { timeoutMs: 15_000 });
    } catch {
      try {
        await capture('iptables', ['-I', chain, '1', ...rule], { timeoutMs: 15_000 });
      } catch (err) {
        throw new Error(`Could not add the runner firewall rule (iptables ${chain} ${rule.join(' ')}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

// ── nodes ──────────────────────────────────────────────────────────────────

const NODE_RUNNER_FEATURE = 'run GitHub Actions runners';
const NODE_OP_TIMEOUT_MS = DOCKER_RUN_TIMEOUT_MS + 60_000;

async function nodeRunnerOp(db: DB, serverId: number, op: string, params: Record<string, unknown>): Promise<string[]> {
  const { assertNodeCapability } = await import('./agentCapabilities.js');
  await assertNodeCapability(db, serverId, { cap: 'gha.runner', feature: NODE_RUNNER_FEATURE, sealedRequired: true });
  const { agentOp } = await import('./agentClient.js');
  return (await agentOp(db, serverId, op, params, () => undefined, { timeoutMs: NODE_OP_TIMEOUT_MS })).lines;
}

/** The runner containers on a node, from its agent. Rows that do not look like ours are dropped. */
export async function listNodeRunnerContainers(db: DB, serverId: number): Promise<RunnerContainer[]> {
  const line = (await nodeRunnerOp(db, serverId, 'gha.runner.list', {})).find((l) => l.startsWith('ND-GHA-RUNNERS '));
  if (!line) throw new Error(`Node #${serverId} answered no runner list`);
  const rows = JSON.parse(line.slice('ND-GHA-RUNNERS '.length)) as unknown;
  if (!Array.isArray(rows)) throw new Error(`Node #${serverId} answered a malformed runner list`);
  const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : null);
  return rows.flatMap((r: Record<string, unknown>): RunnerContainer[] => {
    if (!r || typeof r !== 'object' || typeof r['name'] !== 'string' || !RUNNER_NAME_RE.test(r['name'])) return [];
    const at = typeof r['createdAt'] === 'string' ? new Date(r['createdAt']) : null;
    return [
      {
        name: r['name'],
        state: text(r['state']) ?? 'unknown',
        createdAt: at && !Number.isNaN(at.getTime()) ? at : null,
        githubAppId: num(r['githubAppId']),
        jobId: num(r['jobId']),
        repo: text(r['repo']),
        runnerId: num(r['runnerId']),
        scope: text(r['scope']),
        serverId,
      },
    ];
  });
}

/**
 * Runner containers on every host runners may use: the panel host and each
 * node a configuration points at. A host that cannot answer is reported in
 * `unreachable` (null = the panel host) instead of failing the rest.
 */
export async function listAllRunnerContainers(db: DB): Promise<{ containers: RunnerContainer[]; unreachable: Map<number | null, string> }> {
  const apps = await db.query.githubApps.findMany({ columns: { id: true } });
  const nodes = new Set<number>();
  for (const a of apps) {
    const serverId = (await getRunnerConfig(db, a.id)).serverId;
    if (serverId != null) nodes.add(serverId);
  }
  const containers: RunnerContainer[] = [];
  const unreachable = new Map<number | null, string>();
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);
  try {
    containers.push(...(await listRunnerContainers()));
  } catch (err) {
    unreachable.set(null, message(err));
  }
  for (const serverId of nodes) {
    try {
      containers.push(...(await listNodeRunnerContainers(db, serverId)));
    } catch (err) {
      unreachable.set(serverId, message(err));
    }
  }
  return { containers, unreachable };
}

async function removeRunnerContainer(db: DB, c: Pick<RunnerContainer, 'name' | 'serverId'>, strict = false): Promise<boolean> {
  try {
    if (c.serverId != null) await nodeRunnerOp(db, c.serverId, 'gha.runner.stop', { name: c.name });
    else await capture('docker', ['rm', '-f', c.name], { timeoutMs: 60_000 });
    return true;
  } catch (err) {
    if (strict) throw err;
    return false;
  }
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

// ── organization runner group ──────────────────────────────────────────────

interface RunnerGroup {
  id: number;
  name: string;
}

/** Group id per (App, installation), refreshed when the allowed repositories change or after 10 minutes. */
const groupCache = new Map<string, { fingerprint: string; groupId: number; at: number }>();
const GROUP_REFRESH_MS = 10 * 60 * 1000;

export const runnerGroupName = (ghApp: Pick<GithubApp, 'id'>) => `NineDeploy runners (App ${ghApp.id})`;

/**
 * The repositories an organization runner may serve: the configured list (or
 * every repository the installation sees), minus public ones unless allowed.
 */
async function allowedRepositoryIds(db: DB, ghApp: GithubApp, inst: GithubAppInstallation, config: GithubRunnerConfig): Promise<number[]> {
  const token = await installationToken(db, ghApp, inst, { permissions: { metadata: 'read' } });
  const { repositories } = await listInstallationRepositories(ghApp, token);
  const wanted = new Set(config.repositories.map((r) => r.toLowerCase()));
  return repositories
    .filter((r) => (wanted.size === 0 || wanted.has(r.full_name.toLowerCase())) && (r.private || config.allowPublicRepos))
    .map((r) => r.id)
    .sort((a, b) => a - b);
}

/**
 * The App's own runner group in the organization, open only to the allowed
 * repositories. GitHub hands an organization runner any queued job its group
 * may serve, so this is what makes the repository list and the public-repo
 * refusal binding. Runner groups beyond the default need GitHub Team or
 * Enterprise; without one, no runner is started.
 */
export async function ensureRunnerGroup(
  db: DB,
  ghApp: GithubApp,
  inst: GithubAppInstallation,
  org: string,
  token: string,
  config: GithubRunnerConfig,
  now: number = Date.now(),
): Promise<number> {
  const repoIds = await allowedRepositoryIds(db, ghApp, inst, config);
  if (repoIds.length === 0) throw new Error('No allowed repository: the runner group would serve none.');
  const fingerprint = `${config.allowPublicRepos}:${repoIds.join(',')}`;
  const key = `${ghApp.id}:${inst.id}`;
  const cached = groupCache.get(key);
  if (cached && cached.fingerprint === fingerprint && now - cached.at < GROUP_REFRESH_MS) return cached.groupId;

  const base = `/orgs/${encodeURIComponent(org)}/actions/runner-groups`;
  const name = runnerGroupName(ghApp);
  const settings = { visibility: 'selected', allows_public_repositories: config.allowPublicRepos };
  let group: RunnerGroup | undefined;
  try {
    const listed = await githubApi<{ runner_groups?: RunnerGroup[] }>(ghApp, token, 'GET', `${base}?per_page=100`);
    group = (listed.data?.runner_groups ?? []).find((g) => g.name === name);
    if (!group) {
      const created = await githubApi<RunnerGroup>(ghApp, token, 'POST', base, { name, ...settings, selected_repository_ids: repoIds });
      group = created.data;
    } else {
      await githubApi(ghApp, token, 'PATCH', `${base}/${group.id}`, settings);
      await githubApi(ghApp, token, 'PUT', `${base}/${group.id}/repositories`, { selected_repository_ids: repoIds });
    }
  } catch (err) {
    groupCache.delete(key);
    throw new Error(
      `Could not set up the runner group "${name}" in ${org} (runner groups need GitHub Team or Enterprise): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!group || !Number.isSafeInteger(group.id)) throw new Error('GitHub answered without a runner group');
  groupCache.set(key, { fingerprint, groupId: group.id, at: now });
  return group.id;
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
  const serverId = config.serverId ?? null;
  // Isolation first: nothing is registered on GitHub for a runner that cannot start safely.
  if (serverId === null) {
    await ensureRunnerNetwork();
    await ensureRunnerIsolation();
  } else await nodeRunnerOp(db, serverId, 'gha.runner.prepare', {});
  // A repository runner serves only its repository; an organization runner, only its group's.
  const runnerGroupId = scope.kind === 'org' ? await ensureRunnerGroup(db, ghApp, inst, scope.org, token, config) : 1;
  const runnerName = `nd-${ghApp.id}-${job.jobId}-${randomBytes(3).toString('hex')}`;
  const res = await githubApi<{ runner?: { id?: number }; encoded_jit_config?: string }>(
    ghApp,
    token,
    'POST',
    `${runnersPath(scope)}/generate-jitconfig`,
    { name: runnerName, runner_group_id: runnerGroupId, labels: config.labels, work_folder: '_work' },
  );
  const jit = res.data?.encoded_jit_config;
  const runnerId = res.data?.runner?.id;
  if (typeof jit !== 'string' || !jit || !Number.isSafeInteger(runnerId)) throw new Error('GitHub answered without a runner configuration');

  const meta = { name: runnerName, githubAppId: ghApp.id, jobId: job.jobId, repo: job.repo, runnerId: runnerId as number, scope: scopeLabel(scope) };
  try {
    if (serverId === null) {
      const envFile = writeSecretFile('nd-gha', 'runner.env', `ND_JITCONFIG=${jit}\n`);
      try {
        await capture('docker', runnerRunArgs(config, meta, envFile.path), { timeoutMs: DOCKER_RUN_TIMEOUT_MS });
      } finally {
        envFile.cleanup();
      }
    } else {
      await nodeRunnerOp(db, serverId, 'gha.runner.start', {
        name: meta.name,
        app: meta.githubAppId,
        job: meta.jobId,
        repo: meta.repo,
        runner: meta.runnerId,
        scope: meta.scope,
        cpus: config.cpus,
        memoryMb: config.memoryMb,
        jitConfig: jit,
      });
    }
  } catch (err) {
    // The registration would otherwise linger as an offline runner.
    await githubApi(ghApp, token, 'DELETE', `${runnersPath(scope)}/${runnerId}`).catch(() => undefined);
    throw err;
  }
  log.info({ component: 'github-runners', githubAppId: ghApp.id, jobId: job.jobId, repo: job.repo, runner: runnerName, serverId }, 'started a just-in-time runner');
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
  const { containers, unreachable } = await listAllRunnerContainers(db);
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
    // The host this App's runners start on cannot be counted: its jobs wait for the next sweep.
    if (unreachable.has(config.serverId ?? null)) continue;
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
        lastFailure.delete(githubAppId);
      } catch (err) {
        lastFailure.set(githubAppId, err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500));
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
  // A host that cannot answer has nothing to reap this time.
  const { containers } = await listAllRunnerContainers(db);
  for (const c of containers) {
    const age = c.createdAt ? now - c.createdAt.getTime() : 0;
    if (c.state !== 'running') {
      await removeRunnerContainer(db, c);
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

async function reapRunner(db: DB, log: FastifyBaseLogger, c: RunnerContainer, reason: string, strict = false): Promise<void> {
  if (!(await removeRunnerContainer(db, c, strict))) {
    log.warn({ component: 'github-runners', runner: c.name }, 'could not remove a runner');
    return;
  }
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
  const c = (await listAllRunnerContainers(db)).containers.find((x) => x.name === name && x.githubAppId === githubAppId);
  if (!c) return false;
  await reapRunner(db, log, c, 'stopped by an operator', true);
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
  if (config.serverId != null) {
    try {
      const { assertNodeCapability } = await import('./agentCapabilities.js');
      await assertNodeCapability(db, config.serverId, { cap: 'gha.runner', feature: NODE_RUNNER_FEATURE, sealedRequired: true });
    } catch (err) {
      problems.push(`Runners cannot start on node #${config.serverId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
  const failure = lastFailure.get(ghApp.id);
  if (failure) problems.push(`The last runner could not start: ${failure}`);
  const listed = await listAllRunnerContainers(db);
  containers = listed.containers;
  const where = config.serverId ?? null;
  if (config.enabled && listed.unreachable.has(where)) {
    problems.push(where === null ? 'Docker is not reachable on the panel host.' : `Node #${where} did not list its runners: ${listed.unreachable.get(where)}`);
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
      .map((c) => ({ name: c.name, serverId: c.serverId, jobId: c.jobId, repo: c.repo, state: c.state, startedAt: c.createdAt?.toISOString() ?? null })),
  };
}

/** Drop this App's waiting jobs (runners turned off or the App deleted). */
export function forgetPending(githubAppId: number): void {
  for (const [key, job] of pending) if (job.githubAppId === githubAppId) pending.delete(key);
}
