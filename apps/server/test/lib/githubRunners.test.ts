/**
 * G4.5 self-hosted Actions runners (`lib/githubRunners.ts`): which queued jobs
 * are taken, what `docker run` gets (never the Docker socket, never the JIT
 * config in argv), the slot limit and queue, idle reaping and the readiness
 * problems. GitHub and Docker are mocked; a migrated in-memory SQLite holds
 * the App rows.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { auditLog, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';
import { GITHUB_RUNNER_DEFAULTS, GITHUB_RUNNER_IMAGE, githubRunnerConfig, type GithubRunnerConfig } from '@ninedeploy/schemas';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return {
    capture: vi.fn<(cmd: string, args: string[], opts?: unknown) => Promise<string>>(),
    githubApi: vi.fn(),
    installationToken: vi.fn(async () => 'ghs_token'),
    listInstallationRepositories: vi.fn(),
    bridge: true,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: Parameters<typeof actual.existsSync>[0]) => (String(p) === '/sys/class/net/nd-gha0' ? h.bridge : actual.existsSync(p));
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

vi.mock('../../src/lib/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/exec.js')>();
  return { ...actual, capture: h.capture };
});
vi.mock('../../src/lib/githubApp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/githubApp.js')>();
  return { ...actual, githubApi: h.githubApi, installationToken: h.installationToken, listInstallationRepositories: h.listInstallationRepositories };
});

const {
  drainPending,
  handleWorkflowJob,
  jobRefusal,
  resetGithubRunnersForTests,
  runnerProblems,
  runnerRunArgs,
  runnerStatus,
  isolationRules,
  setRunnerConfig,
  sweepGithubRunners,
  stopRunner,
} = await import('../../src/lib/githubRunners.js');
const { GithubAppError } = await import('../../src/lib/githubApp.js');
const { migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
const enabled = (over: Partial<GithubRunnerConfig> = {}): GithubRunnerConfig => ({ ...GITHUB_RUNNER_DEFAULTS, enabled: true, ...over });

let db: DB;
let ghApp: GithubApp;
let inst: GithubAppInstallation;
let key: string;
/** Containers `docker ps` reports, as tab-separated rows. */
let psRows: string[];
/** Env-file contents seen by `docker run`. */
let envFiles: string[];
/** iptables invocations. */
let iptables: string[];
let networkExists: boolean;
let networkInspect: string;

function queued(over: { id?: number; labels?: string[]; private?: boolean; repo?: string } = {}) {
  return {
    action: 'queued',
    workflow_job: { id: over.id ?? 77, name: 'build', labels: over.labels ?? ['self-hosted', 'ninedeploy'] },
    repository: { id: 5, full_name: over.repo ?? 'acme/api', private: over.private ?? true },
    installation: { id: 9001 },
  };
}

beforeAll(async () => {
  key = rsaKeyPair().privateKey;
});

beforeEach(async () => {
  resetGithubRunnersForTests();
  db = await migratedDb();
  ghApp = await seedApp(db, key, { events: ['push', 'pull_request', 'workflow_job'] });
  ({ inst } = await seedInstallation(db, ghApp, { accountType: 'Organization', permissions: { organization_self_hosted_runners: 'write' } }));
  psRows = [];
  envFiles = [];
  iptables = [];
  networkExists = true;
  networkInspect = 'false nd-gha0\n';
  h.bridge = true;
  delete process.env['NINEDEPLOY_GHA_RUNNERS_UNISOLATED'];
  h.listInstallationRepositories.mockReset();
  h.listInstallationRepositories.mockResolvedValue({
    repositories: [
      { id: 5, full_name: 'acme/api', private: true },
      { id: 6, full_name: 'acme/site', private: false },
      { id: 8, full_name: 'acme/web', private: true },
    ],
    truncated: false,
  });
  h.capture.mockReset();
  h.capture.mockImplementation(async (_cmd, args) => {
    if (args[0] === 'ps') return psRows.join('\n');
    if (_cmd === 'iptables') {
      iptables.push(args.join(' '));
      if (args[0] === '-C') throw new Error('rule missing');
      return '';
    }
    if (args[0] === 'network' && args[1] === 'ls') return networkExists ? 'net1\n' : '';
    if (args[0] === 'network' && args[1] === 'inspect') return networkInspect;
    if (args[0] === 'run') {
      const file = args[args.indexOf('--env-file') + 1]!;
      envFiles.push(readFileSync(file, 'utf8'));
      return 'cid\n';
    }
    return '';
  });
  h.githubApi.mockReset();
  h.githubApi.mockImplementation(async (_app: unknown, _token: string, method: string, path: string) => {
    if (method === 'POST' && path.endsWith('/generate-jitconfig')) {
      return { status: 201, data: { runner: { id: 31 }, encoded_jit_config: 'JITSECRET' }, headers: new Headers() };
    }
    if (method === 'GET' && path.includes('/actions/runner-groups')) return { status: 200, data: { runner_groups: [] }, headers: new Headers() };
    if (method === 'POST' && path.endsWith('/actions/runner-groups')) {
      return { status: 201, data: { id: 7, name: 'NineDeploy runners' }, headers: new Headers() };
    }
    return { status: 200, data: {}, headers: new Headers() };
  });
  h.installationToken.mockClear();
});

afterEach(() => vi.useRealTimers());

const runCalls = () => h.capture.mock.calls.filter(([, args]) => args[0] === 'run');

describe('jobRefusal', () => {
  it('takes a job whose labels are ours plus GitHub defaults', () => {
    expect(jobRefusal(enabled(), { labels: ['self-hosted', 'Linux', 'X64', 'ninedeploy'], repo: 'a/b', isPrivate: true }, 'x64')).toBeNull();
  });

  it('leaves jobs meant for other runners alone', () => {
    expect(jobRefusal(enabled(), { labels: ['self-hosted'], repo: 'a/b', isPrivate: true })).toBe('labels_not_ours');
    expect(jobRefusal(enabled(), { labels: ['ubuntu-latest'], repo: 'a/b', isPrivate: true })).toBe('labels_not_ours');
    expect(jobRefusal(enabled(), { labels: ['ninedeploy', 'gpu'], repo: 'a/b', isPrivate: true })).toBe('labels_unmatched');
    expect(jobRefusal(enabled(), { labels: ['ninedeploy', 'arm64'], repo: 'a/b', isPrivate: true }, 'x64')).toBe('labels_unmatched');
  });

  it('refuses public repositories unless allowed, and repositories outside the list', () => {
    expect(jobRefusal(enabled(), { labels: ['ninedeploy'], repo: 'a/b', isPrivate: false })).toBe('public_repository');
    expect(jobRefusal(enabled({ allowPublicRepos: true }), { labels: ['ninedeploy'], repo: 'a/b', isPrivate: false })).toBeNull();
    expect(jobRefusal(enabled({ repositories: ['acme/web'] }), { labels: ['ninedeploy'], repo: 'acme/api', isPrivate: true })).toBe(
      'repository_not_allowed',
    );
    expect(jobRefusal(enabled({ repositories: ['Acme/API'] }), { labels: ['ninedeploy'], repo: 'acme/api', isPrivate: true })).toBeNull();
  });

  it('takes nothing while runners are off', () => {
    expect(jobRefusal(GITHUB_RUNNER_DEFAULTS, { labels: ['ninedeploy'], repo: 'a/b', isPrivate: true })).toBe('runners_disabled');
  });
});

describe('githubRunnerConfig', () => {
  it('refuses GitHub default labels and duplicates', () => {
    expect(githubRunnerConfig.safeParse(enabled({ labels: ['self-hosted'] })).success).toBe(false);
    expect(githubRunnerConfig.safeParse(enabled({ labels: ['a', 'A'] })).success).toBe(false);
    expect(githubRunnerConfig.safeParse(enabled({ labels: ['a b'] })).success).toBe(false);
  });
});

describe('runnerRunArgs', () => {
  it('runs the pinned image without the Docker socket, on its own network, with limits', () => {
    const args = runnerRunArgs(enabled({ cpus: 1.5, memoryMb: 2048 }), { name: 'nd-1-2-abcdef', githubAppId: 1, jobId: 2, repo: 'a/b', runnerId: 3, scope: 'org:a' }, '/tmp/x/runner.env');
    const joined = args.join(' ');
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toContain('--privileged');
    expect(args).toContain(GITHUB_RUNNER_IMAGE);
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'nd-gha-runners']);
    expect(args.slice(args.indexOf('--cpus'), args.indexOf('--cpus') + 2)).toEqual(['--cpus', '1.5']);
    expect(args.slice(args.indexOf('--memory'), args.indexOf('--memory') + 2)).toEqual(['--memory', '2048m']);
    expect(args).toContain('--rm');
    expect(args).toContain('--pids-limit');
  });
});

describe('handleWorkflowJob', () => {
  it('starts an org runner for a matching job, the JIT config only in the env file', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    const res = await handleWorkflowJob(db, log, ghApp, inst, queued());
    expect(res).toEqual({ ok: true, action: 'runner_queued', jobId: 77 });
    await drainPending(db, log);

    const jit = h.githubApi.mock.calls.find(([, , m, p]) => m === 'POST' && String(p).endsWith('generate-jitconfig'))!;
    expect(jit[3]).toBe('/orgs/acme/actions/runners/generate-jitconfig');
    // The App's own group, open only to the private repositories of the installation.
    expect(jit[4]).toMatchObject({ runner_group_id: 7, labels: ['ninedeploy'] });
    const group = h.githubApi.mock.calls.find(([, , m, p]) => m === 'POST' && p === '/orgs/acme/actions/runner-groups')!;
    expect(group[4]).toMatchObject({ visibility: 'selected', allows_public_repositories: false, selected_repository_ids: [5, 8] });
    expect(h.installationToken).toHaveBeenCalledWith(db, ghApp, expect.anything(), { permissions: { organization_self_hosted_runners: 'write' } });

    expect(runCalls()).toHaveLength(1);
    const args = runCalls()[0]![1];
    expect(args.join(' ')).not.toContain('JITSECRET');
    expect(envFiles).toEqual(['ND_JITCONFIG=JITSECRET\n']);
    expect(args).toContain('ninedeploy.gha-runner.scope=org:acme');
    expect(args).toContain('ninedeploy.gha-runner.runner=31');
  });

  it('uses a repository runner (administration permission) on a personal installation', async () => {
    const personal = (await seedInstallation(db, ghApp, { installationId: 9002, accountLogin: 'jane', accountType: 'User' })).inst;
    await setRunnerConfig(db, ghApp.id, enabled());
    await handleWorkflowJob(db, log, ghApp, personal, queued({ repo: 'jane/site' }));
    await drainPending(db, log);
    const jit = h.githubApi.mock.calls.find(([, , m]) => m === 'POST')!;
    expect(jit[3]).toBe('/repos/jane/site/actions/runners/generate-jitconfig');
    // A repository runner serves only its repository: no group is needed.
    expect(h.githubApi.mock.calls.some(([, , , p]) => String(p).includes('runner-groups'))).toBe(false);
    expect(h.installationToken).toHaveBeenCalledWith(db, ghApp, expect.anything(), { permissions: { administration: 'write' }, repositoryIds: [5] });
  });

  it('ignores refused jobs and later actions without starting anything', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    expect(await handleWorkflowJob(db, log, ghApp, inst, queued({ private: false }))).toMatchObject({ ok: 'ignored', reason: 'public_repository' });
    expect(await handleWorkflowJob(db, log, ghApp, inst, queued({ labels: ['ubuntu-latest'] }))).toMatchObject({ reason: 'labels_not_ours' });
    expect(await handleWorkflowJob(db, log, ghApp, inst, { ...queued(), workflow_job: null })).toMatchObject({ reason: 'invalid_workflow_job' });
    expect(await handleWorkflowJob(db, log, ghApp, inst, { ...queued(), repository: { id: 5, full_name: '../x', private: true } })).toMatchObject({
      reason: 'invalid_repository',
    });
    await drainPending(db, log);
    expect(runCalls()).toHaveLength(0);
  });

  it('holds jobs beyond the slot limit and drops one another runner took', async () => {
    await setRunnerConfig(db, ghApp.id, enabled({ maxConcurrent: 1 }));
    psRows = [`nd-${ghApp.id}-1-aaaaaa\trunning\t2026-10-28 10:00:00 +0000 UTC\t${ghApp.id}\t1\tacme/api\t9\torg:acme`];
    await handleWorkflowJob(db, log, ghApp, inst, queued({ id: 80 }));
    await handleWorkflowJob(db, log, ghApp, inst, queued({ id: 81 }));
    await drainPending(db, log);
    expect(runCalls()).toHaveLength(0);
    expect((await runnerStatus(db, ghApp)).pending.map((p) => p.jobId)).toEqual([80, 81]);

    await handleWorkflowJob(db, log, ghApp, inst, { ...queued({ id: 80 }), action: 'in_progress' });
    psRows = [];
    await drainPending(db, log);
    expect(runCalls()).toHaveLength(1);
    expect(runCalls()[0]![1]).toContain('ninedeploy.gha-runner.job=81');
    expect((await runnerStatus(db, ghApp)).pending).toEqual([]);
  });

  it('records a failed start and removes the registration', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    h.capture.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'ps') return '';
      if (args[0] === 'network') return args[1] === 'inspect' ? 'false nd-gha0' : 'net1';
      if (args[0] === 'run') throw new Error('pull access denied');
      return '';
    });
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    expect(h.githubApi.mock.calls.some(([, , m, p]) => m === 'DELETE' && p === '/orgs/acme/actions/runners/31')).toBe(true);
    const rows = await db.select().from(auditLog);
    expect(rows.map((r) => r.action)).toContain('github_runner.failed');
  });
});

describe('runner isolation and groups (security review)', () => {
  it('firewalls the runner bridge before anything is registered on GitHub', async () => {
    networkExists = false;
    await setRunnerConfig(db, ghApp.id, enabled());
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    const inserted = iptables.filter((c) => c.startsWith('-I'));
    expect(inserted).toEqual(isolationRules().map(({ chain, rule }) => ['-I', chain, '1', ...rule].join(' ')));
    expect(inserted).toContain('-I INPUT 1 -i nd-gha0 -j DROP');
    expect(inserted).toContain('-I DOCKER-USER 1 -i nd-gha0 -d 169.254.0.0/16 -j DROP');
    const network = h.capture.mock.calls.find(([, a]) => a[0] === 'network' && a[1] === 'create');
    expect(network?.[1]).toEqual(expect.arrayContaining(['com.docker.network.bridge.name=nd-gha0', 'com.docker.network.bridge.enable_icc=false']));
  });

  it('creates the network without IPv6, and refuses one that has it', async () => {
    networkExists = false;
    await setRunnerConfig(db, ghApp.id, enabled());
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    const create = h.capture.mock.calls.find(([, a]) => a[0] === 'network' && a[1] === 'create')!;
    expect(create[1]).toContain('--ipv6=false');
    expect(runCalls()).toHaveLength(1);

    networkExists = true;
    networkInspect = 'true nd-gha0\n';
    await handleWorkflowJob(db, log, ghApp, inst, queued({ id: 91 }));
    await drainPending(db, log);
    expect(runCalls()).toHaveLength(1);
    expect((await runnerStatus(db, ghApp)).problems.join('\n')).toContain('not the isolated runner network');
  });

  it('starts nothing when the panel cannot see the bridge, and says why', async () => {
    h.bridge = false;
    await setRunnerConfig(db, ghApp.id, enabled());
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    expect(h.githubApi.mock.calls.some(([, , m, p]) => m === 'POST' && String(p).endsWith('generate-jitconfig'))).toBe(false);
    expect(runCalls()).toHaveLength(0);
    expect((await runnerStatus(db, ghApp)).problems.join('\n')).toContain('cannot see the runner network');
  });

  it('starts nothing if firewall insertion fails', async () => {
    const original = h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (cmd, args, opts) => {
      if (cmd === 'iptables' && args[0] === '-I') throw new Error('permission denied');
      return original(cmd, args, opts);
    });
    await setRunnerConfig(db, ghApp.id, enabled());
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    expect(runCalls()).toHaveLength(0);
    expect(h.githubApi.mock.calls.some(([, , method, path]) => method === 'POST' && String(path).endsWith('generate-jitconfig'))).toBe(false);
    expect((await runnerStatus(db, ghApp)).problems.join('\n')).toContain('Could not add the runner firewall rule');
  });

  it('starts nothing when no permitted repositories are visible', async () => {
    h.listInstallationRepositories.mockResolvedValue({ repositories: [], truncated: false });
    await setRunnerConfig(db, ghApp.id, enabled());
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    expect(runCalls()).toHaveLength(0);
    expect((await runnerStatus(db, ghApp)).problems.join('\n')).toContain('No allowed repository');
  });

  it('runs without the firewall only when explicitly told to', async () => {
    h.bridge = false;
    process.env['NINEDEPLOY_GHA_RUNNERS_UNISOLATED'] = '1';
    await setRunnerConfig(db, ghApp.id, enabled());
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    expect(iptables).toEqual([]);
    expect(runCalls()).toHaveLength(1);
  });

  it('starts no organization runner when the runner group cannot be set up', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    h.githubApi.mockImplementation(async (_a: unknown, _t: string, method: string, path: string) => {
      if (path.includes('runner-groups')) {
        if (method === 'GET') return { status: 200, data: { runner_groups: [] }, headers: new Headers() };
        throw new GithubAppError('GitHub API POST failed (HTTP 403): upgrade your plan', 'forbidden', 403);
      }
      return { status: 201, data: { runner: { id: 31 }, encoded_jit_config: 'JITSECRET' }, headers: new Headers() };
    });
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    expect(h.githubApi.mock.calls.some(([, , , p]) => String(p).endsWith('generate-jitconfig'))).toBe(false);
    expect((await runnerStatus(db, ghApp)).problems.join('\n')).toContain('GitHub Team or Enterprise');
  });

  it('keeps the group to the repository list and lets public repositories in only when allowed', async () => {
    await setRunnerConfig(db, ghApp.id, enabled({ repositories: ['acme/web'] }));
    await handleWorkflowJob(db, log, ghApp, inst, queued({ repo: 'acme/web' }));
    await drainPending(db, log);
    const first = h.githubApi.mock.calls.find(([, , m, p]) => m === 'POST' && p === '/orgs/acme/actions/runner-groups')!;
    expect(first[4]).toMatchObject({ selected_repository_ids: [8] });

    resetGithubRunnersForTests();
    h.githubApi.mockClear();
    await setRunnerConfig(db, ghApp.id, enabled({ allowPublicRepos: true }));
    await handleWorkflowJob(db, log, ghApp, inst, queued({ id: 90 }));
    await drainPending(db, log);
    const second = h.githubApi.mock.calls.find(([, , m, p]) => m === 'POST' && p === '/orgs/acme/actions/runner-groups')!;
    expect(second[4]).toMatchObject({ allows_public_repositories: true, selected_repository_ids: [5, 6, 8] });
  });

  it('updates an existing group instead of making another', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    h.githubApi.mockImplementation(async (_a: unknown, _t: string, method: string, path: string) => {
      if (method === 'GET' && path.includes('runner-groups')) {
        return { status: 200, data: { runner_groups: [{ id: 12, name: `NineDeploy runners (App ${ghApp.id})` }] }, headers: new Headers() };
      }
      if (path.endsWith('generate-jitconfig')) return { status: 201, data: { runner: { id: 31 }, encoded_jit_config: 'J' }, headers: new Headers() };
      return { status: 204, data: null, headers: new Headers() };
    });
    await handleWorkflowJob(db, log, ghApp, inst, queued());
    await drainPending(db, log);
    const calls = h.githubApi.mock.calls.map(([, , m, p]) => `${m} ${p}`);
    expect(calls).toContain('PATCH /orgs/acme/actions/runner-groups/12');
    expect(calls).toContain('PUT /orgs/acme/actions/runner-groups/12/repositories');
    expect(calls).not.toContain('POST /orgs/acme/actions/runner-groups');
    expect(h.githubApi.mock.calls.find(([, , , p]) => String(p).endsWith('generate-jitconfig'))![4]).toMatchObject({ runner_group_id: 12 });
  });
});

describe('sweepGithubRunners', () => {
  it('makes no Docker call while no App has runners on', async () => {
    await sweepGithubRunners(db, log);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('reaps an idle runner and keeps a busy one', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    const old = '2026-10-28 10:00:00 +0000 UTC';
    psRows = [
      `nd-${ghApp.id}-1-aaaaaa\trunning\t${old}\t${ghApp.id}\t1\tacme/api\t31\torg:acme`,
      `nd-${ghApp.id}-2-bbbbbb\trunning\t${old}\t${ghApp.id}\t2\tacme/api\t32\torg:acme`,
    ];
    h.githubApi.mockImplementation(async (_a: unknown, _t: string, method: string, path: string) => {
      if (method === 'GET' && path.endsWith('/31')) return { status: 200, data: { busy: false }, headers: new Headers() };
      if (method === 'GET' && path.endsWith('/32')) return { status: 200, data: { busy: true }, headers: new Headers() };
      return { status: 204, data: null, headers: new Headers() };
    });
    await sweepGithubRunners(db, log, new Date('2026-10-28T10:30:00Z').getTime());
    const removed = h.capture.mock.calls.filter(([, a]) => a[0] === 'rm').map(([, a]) => a[2]);
    expect(removed).toEqual([`nd-${ghApp.id}-1-aaaaaa`]);
    expect(h.githubApi.mock.calls.some(([, , m, p]) => m === 'DELETE' && p === '/orgs/acme/actions/runners/31')).toBe(true);
  });

  it('treats a runner GitHub no longer knows as done', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    psRows = [`nd-${ghApp.id}-1-aaaaaa\trunning\t2026-10-28 10:00:00 +0000 UTC\t${ghApp.id}\t1\tacme/api\t31\torg:acme`];
    h.githubApi.mockImplementation(async (_a: unknown, _t: string, method: string) => {
      if (method === 'GET') throw new GithubAppError('gone', 'not_found', 404);
      return { status: 204, data: null, headers: new Headers() };
    });
    await sweepGithubRunners(db, log, new Date('2026-10-28T10:30:00Z').getTime());
    expect(h.capture.mock.calls.some(([, a]) => a[0] === 'rm')).toBe(true);
  });
});

describe('runner operator and expiration', () => {
  it('stops only the requested App runner and removes its GitHub registration', async () => {
    const name = `nd-${ghApp.id}-1-aaaaaa`;
    psRows = [`${name}\trunning\t2026-10-28 10:00:00 +0000 UTC\t${ghApp.id}\t1\tacme/api\t31\torg:acme`];
    expect(await stopRunner(db, log, ghApp.id + 1, name)).toBe(false);
    expect(h.capture.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
    expect(await stopRunner(db, log, ghApp.id, name)).toBe(true);
    expect(h.capture.mock.calls.some(([, args]) => args[0] === 'rm' && args[2] === name)).toBe(true);
    expect(h.githubApi.mock.calls.some(([, , method, path]) => method === 'DELETE' && path === '/orgs/acme/actions/runners/31')).toBe(true);
  });

  it('removes exited runners and those exceeding the maximum age', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    psRows = [
      `nd-${ghApp.id}-1-aaaaaa\texited\t2026-10-28 10:00:00 +0000 UTC\t${ghApp.id}\t1\tacme/api\t31\torg:acme`,
      `nd-${ghApp.id}-2-bbbbbb\trunning\t2026-10-28 10:00:00 +0000 UTC\t${ghApp.id}\t2\tacme/api\t32\torg:acme`,
    ];
    await sweepGithubRunners(db, log, new Date('2026-10-28T17:00:00Z').getTime());
    expect(h.capture.mock.calls.filter(([, args]) => args[0] === 'rm').map(([, args]) => args[2])).toEqual([`nd-${ghApp.id}-1-aaaaaa`, `nd-${ghApp.id}-2-bbbbbb`]);
    expect(h.githubApi.mock.calls.some(([, , method, path]) => method === 'DELETE' && path === '/orgs/acme/actions/runners/32')).toBe(true);
  });

  it('retains an idle runner when GitHub cannot confirm it is idle', async () => {
    await setRunnerConfig(db, ghApp.id, enabled());
    psRows = [`nd-${ghApp.id}-1-aaaaaa\trunning\t2026-10-28 10:00:00 +0000 UTC\t${ghApp.id}\t1\tacme/api\t31\torg:acme`];
    h.githubApi.mockRejectedValue(new Error('GitHub unavailable'));
    await sweepGithubRunners(db, log, new Date('2026-10-28T10:30:00Z').getTime());
    expect(h.capture.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false);
  });
});

describe('runnerProblems', () => {
  it('names the missing event and permission', async () => {
    const bare = await seedApp(db, key, { appId: 5151, events: ['push'] });
    await seedInstallation(db, bare, { installationId: 9100, accountType: 'Organization', permissions: { contents: 'read' } });
    const problems = await runnerProblems(db, bare, enabled());
    expect(problems.join('\n')).toContain('Workflow job');
    expect(problems.join('\n')).toContain('organization_self_hosted_runners: write');
    expect(await runnerProblems(db, ghApp, enabled())).toEqual([]);
    expect(await runnerProblems(db, bare, GITHUB_RUNNER_DEFAULTS)).toEqual([]);
  });
});
