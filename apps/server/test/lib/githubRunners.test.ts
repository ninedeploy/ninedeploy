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
  };
});

vi.mock('../../src/lib/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/exec.js')>();
  return { ...actual, capture: h.capture };
});
vi.mock('../../src/lib/githubApp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/githubApp.js')>();
  return { ...actual, githubApi: h.githubApi, installationToken: h.installationToken };
});

const {
  drainPending,
  handleWorkflowJob,
  jobRefusal,
  resetGithubRunnersForTests,
  runnerProblems,
  runnerRunArgs,
  runnerStatus,
  setRunnerConfig,
  sweepGithubRunners,
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
  h.capture.mockReset();
  h.capture.mockImplementation(async (_cmd, args) => {
    if (args[0] === 'ps') return psRows.join('\n');
    if (args[0] === 'network' && args[1] === 'ls') return 'net1\n';
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
    expect(jit[4]).toMatchObject({ runner_group_id: 1, labels: ['ninedeploy'] });
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
      if (args[0] === 'network') return 'net1';
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
