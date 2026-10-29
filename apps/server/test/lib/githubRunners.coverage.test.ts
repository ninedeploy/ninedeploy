/**
 * G4.5 Actions runners (`lib/githubRunners.ts` and `agentOps/githubRunners.ts`):
 * the edges the main suites leave out. Malformed node runner lists, an
 * unreachable panel host or node, queue expiry and re-checks, the slot limit
 * with several jobs, node reaping and stopping, repository-scoped runners,
 * runner group caching, and every validation branch of the agent ops.
 * Docker, GitHub and the agent transport are mocked; nothing touches a host.
 */
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { auditLog, githubAppInstallations, githubApps, servers, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';
import { GITHUB_RUNNER_DEFAULTS, type GithubRunnerConfig } from '@ninedeploy/schemas';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return {
    capture: vi.fn<(cmd: string, args: string[], opts?: unknown) => Promise<string>>(),
    githubApi: vi.fn(),
    installationToken: vi.fn(async () => 'ghs_token'),
    listInstallationRepositories: vi.fn(),
    agentOp: vi.fn(),
    assertNodeCapability: vi.fn(async () => undefined),
    bridge: true,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: Parameters<typeof actual.existsSync>[0]) => (String(p) === '/sys/class/net/nd-gha0' ? h.bridge : actual.existsSync(p));
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});
vi.mock('../../src/lib/exec.js', async (orig) => ({ ...(await orig<object>()), capture: h.capture }));
vi.mock('../../src/lib/githubApp.js', async (orig) => ({
  ...(await orig<object>()),
  githubApi: h.githubApi,
  installationToken: h.installationToken,
  listInstallationRepositories: h.listInstallationRepositories,
}));
vi.mock('../../src/lib/agentClient.js', async (orig) => ({ ...(await orig<object>()), agentOp: h.agentOp }));
vi.mock('../../src/lib/agentCapabilities.js', async (orig) => ({ ...(await orig<object>()), assertNodeCapability: h.assertNodeCapability }));

const lib = await import('../../src/lib/githubRunners.js');
const registry = await import('../../src/agentOps/index.js');
const { setSettingJson } = await import('../../src/lib/settings.js');
const { GithubAppError } = await import('../../src/lib/githubApp.js');
const { migratedDb, closeMigratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
const enabled = (over: Partial<GithubRunnerConfig> = {}): GithubRunnerConfig => ({ ...GITHUB_RUNNER_DEFAULTS, enabled: true, ...over });
const ok = (data: unknown, status = 200) => ({ status, data, headers: new Headers() });

function queued(over: { id?: number; repo?: string; repoId?: number; labels?: unknown; name?: unknown } = {}) {
  return {
    action: 'queued',
    workflow_job: { id: over.id ?? 77, name: 'name' in over ? over.name : 'build', labels: 'labels' in over ? over.labels : ['self-hosted', 'ninedeploy'] },
    repository: { id: over.repoId ?? 5, full_name: over.repo ?? 'acme/api', private: true },
    installation: { id: 9001 },
  };
}

let db: DB;
let ghApp: GithubApp;
let inst: GithubAppInstallation;
let key: string;
/** Rows `docker ps` prints; null makes `docker ps` fail (panel host unreachable). */
let psRows: string[] | null;
let nodeRunners: unknown;
let envFiles: string[];

beforeAll(() => {
  key = rsaKeyPair().privateKey;
});

beforeEach(async () => {
  lib.resetGithubRunnersForTests();
  db = await migratedDb();
  ghApp = await seedApp(db, key, { events: ['workflow_job'] });
  ({ inst } = await seedInstallation(db, ghApp, { accountType: 'Organization', permissions: { organization_self_hosted_runners: 'write' } }));
  await db.insert(servers).values({ id: 9, name: 'ci-1', host: '203.0.113.9', port: 4600, tokenEncrypted: 'x', status: 'online' });
  psRows = [];
  nodeRunners = [];
  envFiles = [];
  h.bridge = true;
  delete process.env['NINEDEPLOY_GHA_RUNNERS_UNISOLATED'];
  h.listInstallationRepositories.mockReset().mockResolvedValue({
    repositories: [
      { id: 5, full_name: 'acme/api', private: true },
      { id: 8, full_name: 'acme/web', private: true },
    ],
    truncated: false,
  });
  h.capture.mockReset().mockImplementation(async (cmd, args) => {
    if (args[0] === 'ps') {
      if (psRows === null) throw new Error('Cannot connect to the Docker daemon');
      return psRows.join('\n');
    }
    if (cmd === 'iptables') return '';
    if (args[0] === 'network' && args[1] === 'ls') return 'net1\n';
    if (args[0] === 'network' && args[1] === 'inspect') return 'false nd-gha0\n';
    if (args[0] === 'run' && args.includes('--env-file')) envFiles.push(readFileSync(args[args.indexOf('--env-file') + 1]!, 'utf8'));
    return '';
  });
  h.agentOp.mockReset().mockImplementation(async (_db: unknown, _serverId: number, op: string) => ({
    exitCode: 0,
    lines: op === 'gha.runner.list' ? [`ND-GHA-RUNNERS ${JSON.stringify(nodeRunners)}`] : ['ND-GHA-RUNNER {}'],
  }));
  h.assertNodeCapability.mockReset().mockResolvedValue(undefined);
  h.githubApi.mockReset().mockImplementation(async (_app: unknown, _token: string, method: string, path: string) => {
    if (method === 'POST' && path.endsWith('/generate-jitconfig')) return ok({ runner: { id: 31 }, encoded_jit_config: 'SklUU0VDUkVUSklUU0VDUkVU' }, 201);
    if (method === 'GET' && path.includes('/actions/runner-groups')) return ok({ runner_groups: [] });
    if (method === 'POST' && path.endsWith('/actions/runner-groups')) return ok({ id: 7 }, 201);
    if (method === 'GET' && path.includes('/actions/jobs/')) return ok({ status: 'queued' });
    return ok({});
  });
  h.installationToken.mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.info).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeMigratedDb(db);
});

const runCalls = () => h.capture.mock.calls.filter(([, args]) => args[0] === 'run');
const opsCalled = () => h.agentOp.mock.calls.map((c) => c[2] as string);
const psRow = (name: string, state: string, created: string, app: number | string, job: number | string, repo: string, runner: number | string, scope: string) =>
  [name, state, created, app, job, repo, runner, scope].join('\t');

describe('configuration and matching', () => {
  it('falls back to the defaults for a stored configuration that no longer parses', async () => {
    await setSettingJson(db, `github_runners:${ghApp.id}`, { enabled: true, maxConcurrent: -4 });
    expect(await lib.getRunnerConfig(db, ghApp.id)).toEqual(GITHUB_RUNNER_DEFAULTS);
    await setSettingJson(db, `github_runners:${ghApp.id}`, 'not an object');
    expect(await lib.getRunnerConfig(db, ghApp.id)).toEqual(GITHUB_RUNNER_DEFAULTS);
  });

  it('uses a repository scope when an organization installation has no login', () => {
    expect(lib.runnerScope({ accountType: 'Organization', accountLogin: null }, 'a/b', 3)).toEqual({ kind: 'repo', repo: 'a/b', repoId: 3 });
    expect(lib.scopePermission({ kind: 'repo', repo: 'a/b', repoId: 3 })).toBe('administration');
    expect(lib.scopePermission({ kind: 'org', org: 'a' })).toBe('organization_self_hosted_runners');
  });

  it('accepts the host architecture label by default', () => {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    expect(lib.jobRefusal(enabled(), { labels: ['ninedeploy', arch], repo: 'a/b', isPrivate: true })).toBeNull();
  });

  it('writes the node isolation script from the module constants only', () => {
    const script = lib.nodeIsolationScript().split('\n');
    expect(script[0]).toBe('set -e');
    expect(script).toHaveLength(3 + lib.isolationRules().length);
    expect(script.at(-1)).toContain('224.0.0.0/4');
  });

  it('leaves the cpu and memory limits off when unset', () => {
    const args = lib.runnerRunArgs(enabled({ cpus: null, memoryMb: null }), { name: 'nd-1-2-abcdef', githubAppId: 1, jobId: 2, repo: 'a/b', runnerId: 3, scope: 'org:a' }, '/x/runner.env');
    expect(args).not.toContain('--cpus');
    expect(args).not.toContain('--memory');
  });
});

describe('ensureRunnerNetwork', () => {
  it('accepts a network another start created while this one raced', async () => {
    let lsCalls = 0;
    h.capture.mockImplementation(async (_c, args) => {
      if (args[1] === 'ls') return ++lsCalls === 1 ? '' : 'net1\n';
      if (args[1] === 'create') throw new Error('network with name nd-gha-runners already exists');
      if (args[1] === 'inspect') return 'false nd-gha0';
      return '';
    });
    await expect(lib.ensureRunnerNetwork()).resolves.toBeUndefined();
    expect(lsCalls).toBe(2);
  });

  it('rethrows a create failure when the network still does not exist', async () => {
    h.capture.mockImplementation(async (_c, args) => {
      if (args[1] === 'ls') return '';
      if (args[1] === 'create') throw new Error('daemon refused');
      return 'false nd-gha0';
    });
    await expect(lib.ensureRunnerNetwork()).rejects.toThrow('daemon refused');
  });

  it('refuses a network with another bridge name', async () => {
    h.capture.mockImplementation(async (_c, args) => (args[1] === 'ls' ? 'net1' : args[1] === 'inspect' ? 'false docker1' : ''));
    await expect(lib.ensureRunnerNetwork()).rejects.toThrow(/not the isolated runner network.*docker1/);
  });
});

describe('ensureRunnerIsolation', () => {
  it('adds nothing when every rule is already in place', async () => {
    await lib.ensureRunnerIsolation(() => true);
    const calls = h.capture.mock.calls.filter(([c]) => c === 'iptables').map(([, a]) => a[0]);
    expect(calls.every((a) => a === '-C')).toBe(true);
    expect(calls).toHaveLength(lib.isolationRules().length);
  });

  it('names a non-Error insertion failure', async () => {
    h.capture.mockImplementation(async (_c, args) => {
      if (args[0] === '-C') throw new Error('missing');
      throw 'exit 4';
    });
    await expect(lib.ensureRunnerIsolation(() => true)).rejects.toThrow(/Could not add the runner firewall rule.*exit 4/);
  });

  it('refuses when the bridge is not visible (checker passed in)', async () => {
    await expect(lib.ensureRunnerIsolation(() => false)).rejects.toThrow(/cannot see the runner network/);
  });
});

describe('listRunnerContainers (panel host)', () => {
  it('reads zone names off the date and drops bad numbers and empty labels', async () => {
    psRows = [
      psRow('nd-1-2-abcdef', 'running', '2026-10-28 10:00:00 +0300 +03', 1, 2, 'acme/api', 31, 'org:acme'),
      psRow('nd-1-3-abcdef', 'exited', 'garbage', '0', 'x', '', '-1', ''),
      '   ',
    ];
    const [a, b] = await lib.listRunnerContainers();
    expect(a).toMatchObject({ name: 'nd-1-2-abcdef', githubAppId: 1, jobId: 2, runnerId: 31, scope: 'org:acme', serverId: null });
    expect(a!.createdAt?.toISOString()).toBe('2026-10-28T07:00:00.000Z');
    expect(b).toMatchObject({ createdAt: null, githubAppId: null, jobId: null, repo: null, runnerId: null, scope: null });
  });

  it('handles a line with only a name', async () => {
    psRows = ['lonely'];
    expect(await lib.listRunnerContainers()).toEqual([
      { name: 'lonely', state: '', createdAt: null, githubAppId: null, jobId: null, repo: null, runnerId: null, scope: null, serverId: null },
    ]);
  });
});

describe('listNodeRunnerContainers', () => {
  it('fails when the node answers no runner list line', async () => {
    h.agentOp.mockResolvedValue({ exitCode: 0, lines: ['something else'] });
    await expect(lib.listNodeRunnerContainers(db, 9)).rejects.toThrow('Node #9 answered no runner list');
  });

  it('fails on a list that is not an array, and on bad JSON', async () => {
    h.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ND-GHA-RUNNERS {"a":1}'] });
    await expect(lib.listNodeRunnerContainers(db, 9)).rejects.toThrow('malformed runner list');
    h.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ND-GHA-RUNNERS [not json'] });
    await expect(lib.listNodeRunnerContainers(db, 9)).rejects.toThrow(SyntaxError);
  });

  it('drops rows that do not look like ours and normalizes the rest', async () => {
    nodeRunners = [
      null,
      'nd-1-2-abcdef',
      { name: 42 },
      { name: 'nd-1-2-ABCDEF' },
      { name: 'nd-1-2-abcdef', state: 'x'.repeat(201), createdAt: 'not a date', githubAppId: 1.5, jobId: -1, repo: 7, runnerId: '31', scope: null },
      { name: 'nd-1-3-abcdef', state: 'running', createdAt: 12345, githubAppId: 1, jobId: 3, repo: 'acme/api', runnerId: 31, scope: 'org:acme' },
      { name: 'nd-1-4-abcdef', state: 'running', createdAt: '2026-10-28T10:00:00Z', githubAppId: 1, jobId: 4 },
    ];
    const rows = await lib.listNodeRunnerContainers(db, 9);
    expect(rows.map((r) => r.name)).toEqual(['nd-1-2-abcdef', 'nd-1-3-abcdef', 'nd-1-4-abcdef']);
    expect(rows[0]).toEqual({ name: 'nd-1-2-abcdef', state: 'unknown', createdAt: null, githubAppId: null, jobId: null, repo: null, runnerId: null, scope: null, serverId: 9 });
    expect(rows[1]).toMatchObject({ createdAt: null, githubAppId: 1, jobId: 3, repo: 'acme/api', runnerId: 31, scope: 'org:acme', serverId: 9 });
    expect(rows[2]!.createdAt?.toISOString()).toBe('2026-10-28T10:00:00.000Z');
    expect(h.assertNodeCapability).toHaveBeenCalledWith(db, 9, expect.objectContaining({ cap: 'gha.runner', sealedRequired: true }));
  });

  it('does not ask the agent when the node lacks the capability', async () => {
    h.assertNodeCapability.mockRejectedValue(new Error('agent too old'));
    await expect(lib.listNodeRunnerContainers(db, 9)).rejects.toThrow('agent too old');
    expect(h.agentOp).not.toHaveBeenCalled();
  });
});

describe('listAllRunnerContainers', () => {
  it('reports each host that cannot answer, null for the panel host, without failing the rest', async () => {
    const other = await seedApp(db, key, { appId: 4343 });
    await db.insert(servers).values({ id: 10, name: 'ci-2', host: '203.0.113.10', port: 4600, tokenEncrypted: 'x', status: 'online' });
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9 }));
    await lib.setRunnerConfig(db, other.id, enabled({ serverId: 10 }));
    psRows = null;
    nodeRunners = [{ name: 'nd-1-5-abcdef', state: 'running', githubAppId: ghApp.id }];
    h.agentOp.mockImplementation(async (_db: unknown, serverId: number) => {
      if (serverId === 10) throw 'x'.repeat(400);
      return { exitCode: 0, lines: [`ND-GHA-RUNNERS ${JSON.stringify(nodeRunners)}`] };
    });
    const { containers, unreachable } = await lib.listAllRunnerContainers(db);
    expect(containers.map((c) => [c.name, c.serverId])).toEqual([['nd-1-5-abcdef', 9]]);
    expect(unreachable.get(null)).toContain('Docker daemon');
    expect(unreachable.get(10)).toHaveLength(300);
    expect(unreachable.has(9)).toBe(false);
  });
});

describe('ensureRunnerGroup', () => {
  it('reuses the cached group until the repositories change or ten minutes pass', async () => {
    const config = enabled();
    const t0 = 1_000_000;
    expect(await lib.ensureRunnerGroup(db, ghApp, inst, 'acme', 'tok', config, t0)).toBe(7);
    expect(await lib.ensureRunnerGroup(db, ghApp, inst, 'acme', 'tok', config, t0 + 60_000)).toBe(7);
    const groupCalls = () => h.githubApi.mock.calls.filter(([, , , p]) => String(p).includes('runner-groups')).length;
    expect(groupCalls()).toBe(2);
    // Ten minutes later: asked again.
    await lib.ensureRunnerGroup(db, ghApp, inst, 'acme', 'tok', config, t0 + 11 * 60_000);
    expect(groupCalls()).toBe(4);
    // Another repository list: asked again.
    h.listInstallationRepositories.mockResolvedValue({ repositories: [{ id: 5, full_name: 'acme/api', private: true }], truncated: false });
    await lib.ensureRunnerGroup(db, ghApp, inst, 'acme', 'tok', config, t0 + 11 * 60_000 + 1);
    expect(groupCalls()).toBe(6);
  });

  it('copes with a list answer without groups, and refuses a created group without an id', async () => {
    h.githubApi.mockImplementation(async (_a: unknown, _t: string, method: string) => (method === 'GET' ? ok(null) : ok({ name: 'x' }, 201)));
    await expect(lib.ensureRunnerGroup(db, ghApp, inst, 'acme', 'tok', enabled())).rejects.toThrow('GitHub answered without a runner group');
    h.githubApi.mockImplementation(async (_a: unknown, _t: string, method: string) => (method === 'GET' ? ok({}) : ok(null, 201)));
    await expect(lib.ensureRunnerGroup(db, ghApp, inst, 'acme', 'tok', enabled())).rejects.toThrow('GitHub answered without a runner group');
  });

  it('names a non-Error failure of the group calls', async () => {
    h.githubApi.mockRejectedValue('rate limited');
    await expect(lib.ensureRunnerGroup(db, ghApp, inst, 'my org', 'tok', enabled())).rejects.toThrow(/in my org .*rate limited/);
    expect(h.githubApi.mock.calls[0]![3]).toBe('/orgs/my%20org/actions/runner-groups?per_page=100');
  });
});

describe('the queue', () => {
  it('starts only up to maxConcurrent of several jobs, oldest first, and the rest as slots free up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T10:00:00Z'));
    await lib.setRunnerConfig(db, ghApp.id, enabled({ maxConcurrent: 2 }));
    psRows = null; // hold everything while the jobs arrive
    for (const id of [81, 82, 83]) {
      vi.setSystemTime(new Date(Date.now() + 1000));
      await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id }));
    }
    await lib.drainPending(db, log);
    expect(runCalls()).toHaveLength(0);
    expect((await lib.runnerStatus(db, ghApp)).problems).toContain('Docker is not reachable on the panel host.');
    psRows = [];
    await lib.drainPending(db, log);
    expect(runCalls().map(([, a]) => a.find((x) => x.startsWith('ninedeploy.gha-runner.job=')))).toEqual([
      'ninedeploy.gha-runner.job=81',
      'ninedeploy.gha-runner.job=82',
    ]);
    const status = await lib.runnerStatus(db, ghApp);
    expect(status.pending).toEqual([{ jobId: 83, repo: 'acme/api', jobName: 'build', queuedAt: '2026-10-28T10:00:03.000Z' }]);
  });

  it('ignores a delivery whose repository has no name', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    const body = { ...queued(), repository: { id: 5, private: true } };
    expect(await lib.handleWorkflowJob(db, log, ghApp, inst, body)).toEqual({ ok: 'ignored', reason: 'invalid_repository' });
  });

  it('keeps one entry for a job delivered twice, and stores a job without a name or labels list', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    psRows = null;
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id: 90, name: 42 }));
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id: 90 }));
    expect(await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id: 91, labels: 'ninedeploy' }))).toMatchObject({ ok: 'ignored', reason: 'labels_not_ours' });
    await lib.drainPending(db, log);
    expect((await lib.runnerStatus(db, ghApp)).pending).toEqual([expect.objectContaining({ jobId: 90, jobName: null })]);
  });

  it('drops a job that waited longer than GitHub keeps one queued', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T10:00:00Z'));
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    psRows = null;
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued());
    await lib.drainPending(db, log);
    expect((await lib.runnerStatus(db, ghApp)).pending).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-29T10:00:01Z'));
    psRows = [];
    await lib.drainPending(db, log);
    expect(runCalls()).toHaveLength(0);
    expect((await lib.runnerStatus(db, ghApp)).pending).toEqual([]);
  });

  it('drops the jobs of an App that was deleted or had runners turned off', async () => {
    const other = await seedApp(db, key, { appId: 4343 });
    const otherInst = (await seedInstallation(db, other, { installationId: 9100, accountType: 'Organization' })).inst;
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    await lib.setRunnerConfig(db, other.id, enabled());
    psRows = null;
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id: 1 }));
    await lib.handleWorkflowJob(db, log, other, otherInst, queued({ id: 2 }));
    await lib.drainPending(db, log);
    await db.delete(githubApps).where(eq(githubApps.id, ghApp.id));
    await lib.setRunnerConfig(db, other.id, enabled({ enabled: false }));
    psRows = [];
    await lib.drainPending(db, log);
    expect(runCalls()).toHaveLength(0);
    expect((await lib.runnerStatus(db, ghApp)).pending).toEqual([]);
    expect((await lib.runnerStatus(db, other)).pending).toEqual([]);
  });

  it('forgets the waiting jobs of one App only', async () => {
    const other = await seedApp(db, key, { appId: 4343 });
    const otherInst = (await seedInstallation(db, other, { installationId: 9100, accountType: 'Organization' })).inst;
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    await lib.setRunnerConfig(db, other.id, enabled());
    psRows = null;
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id: 1 }));
    await lib.handleWorkflowJob(db, log, other, otherInst, queued({ id: 2 }));
    await lib.drainPending(db, log);
    lib.forgetPending(ghApp.id);
    expect((await lib.runnerStatus(db, ghApp)).pending).toEqual([]);
    expect((await lib.runnerStatus(db, other)).pending).toHaveLength(1);
  });

  it('logs a drain that fails outright and keeps the chain usable', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    psRows = null;
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued());
    await lib.drainPending(db, log);
    vi.spyOn(db.query.githubApps, 'findMany').mockRejectedValueOnce(new Error('database is locked'));
    await expect(lib.drainPending(db, log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ component: 'github-runners' }), 'runner queue drain failed');
    psRows = [];
    await lib.drainPending(db, log);
    expect(runCalls()).toHaveLength(1);
  });

  it('starts nothing for an installation removed since the job was queued', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    psRows = null;
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued());
    await lib.drainPending(db, log);
    await db.update(githubAppInstallations).set({ removedAt: new Date() }).where(eq(githubAppInstallations.id, inst.id));
    psRows = [];
    await lib.drainPending(db, log);
    expect(h.installationToken).not.toHaveBeenCalled();
    expect(runCalls()).toHaveLength(0);
    expect((await lib.runnerStatus(db, ghApp)).pending).toEqual([]);
  });

  it('records a GitHub answer without a JIT configuration, a non-Error failure, and clears it after a success', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    const base = h.githubApi.getMockImplementation()!;
    h.githubApi.mockImplementation(async (a: unknown, t: string, method: string, path: string) =>
      method === 'POST' && path.endsWith('generate-jitconfig') ? ok({ runner: { id: 31 } }, 201) : base(a, t, method, path),
    );
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id: 1 }));
    await lib.drainPending(db, log);
    expect((await lib.runnerStatus(db, ghApp)).problems.join('\n')).toContain('GitHub answered without a runner configuration');

    h.githubApi.mockImplementation(async (a: unknown, t: string, method: string, path: string) => {
      if (method === 'POST' && path.endsWith('generate-jitconfig')) throw 'secondary rate limit';
      return base(a, t, method, path);
    });
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id: 2 }));
    await lib.drainPending(db, log);
    expect((await lib.runnerStatus(db, ghApp)).problems.join('\n')).toContain('The last runner could not start: secondary rate limit');
    const failed = (await db.select().from(auditLog)).filter((r) => r.action === 'github_runner.failed');
    expect(failed).toHaveLength(2);

    h.githubApi.mockImplementation(base);
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id: 3 }));
    await lib.drainPending(db, log);
    expect(runCalls()).toHaveLength(1);
    expect((await lib.runnerStatus(db, ghApp)).problems).toEqual([]);
  });

  it('starts a repository runner on a node for a personal installation', async () => {
    const personal = (await seedInstallation(db, ghApp, { installationId: 9002, accountLogin: 'jane', accountType: 'User' })).inst;
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9, cpus: null, memoryMb: null }));
    await lib.handleWorkflowJob(db, log, ghApp, personal, queued({ repo: 'jane/site', repoId: 12 }));
    await lib.drainPending(db, log);
    expect(opsCalled()).toEqual(['gha.runner.list', 'gha.runner.prepare', 'gha.runner.start']);
    expect(h.agentOp.mock.calls[2]![3]).toMatchObject({ repo: 'jane/site', scope: 'repo:jane/site', cpus: null, memoryMb: null });
    const jit = h.githubApi.mock.calls.find(([, , m, p]) => m === 'POST' && String(p).endsWith('generate-jitconfig'))!;
    expect(jit[3]).toBe('/repos/jane/site/actions/runners/generate-jitconfig');
    expect(jit[4]).toMatchObject({ runner_group_id: 1 });
    expect(h.installationToken).toHaveBeenCalledWith(db, ghApp, expect.anything(), { permissions: { administration: 'write' }, repositoryIds: [12] });
  });
});

describe('sweepGithubRunners: re-checking waiting jobs', () => {
  async function holdJob(id = 77) {
    psRows = null;
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued({ id }));
    await lib.drainPending(db, log);
    psRows = [];
  }

  it('drops a job GitHub no longer has queued', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    await holdJob();
    const base = h.githubApi.getMockImplementation()!;
    h.githubApi.mockImplementation(async (a: unknown, t: string, method: string, path: string) =>
      path.includes('/actions/jobs/') ? ok({ status: 'completed' }) : base(a, t, method, path),
    );
    await lib.sweepGithubRunners(db, log);
    expect(h.githubApi).toHaveBeenCalledWith(expect.anything(), 'ghs_token', 'GET', '/repos/acme/api/actions/jobs/77');
    expect(h.installationToken).toHaveBeenCalledWith(db, ghApp, expect.anything(), { permissions: { actions: 'read' }, repositoryIds: [5] });
    expect(runCalls()).toHaveLength(0);
    expect((await lib.runnerStatus(db, ghApp)).pending).toEqual([]);
  });

  it('starts a job GitHub still has queued, and one it cannot check', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    await holdJob(77);
    await lib.sweepGithubRunners(db, log);
    expect(runCalls()).toHaveLength(1);

    await holdJob(78);
    const base = h.githubApi.getMockImplementation()!;
    h.githubApi.mockImplementation(async (a: unknown, t: string, method: string, path: string) => {
      if (path.includes('/actions/jobs/')) throw new Error('502');
      return base(a, t, method, path);
    });
    await lib.sweepGithubRunners(db, log);
    expect(runCalls()).toHaveLength(2);
  });

  it('drops a job whose installation is gone before asking GitHub', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    await holdJob();
    await db.update(githubAppInstallations).set({ suspendedAt: new Date() }).where(eq(githubAppInstallations.id, inst.id));
    await lib.sweepGithubRunners(db, log);
    expect(h.githubApi.mock.calls.some(([, , , p]) => String(p).includes('/actions/jobs/'))).toBe(false);
    expect((await lib.runnerStatus(db, ghApp)).pending).toEqual([]);
  });

  it('drains leftover jobs even after every App turned runners off', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    await holdJob();
    await lib.setRunnerConfig(db, ghApp.id, enabled({ enabled: false }));
    await lib.sweepGithubRunners(db, log);
    expect((await lib.runnerStatus(db, ghApp)).pending).toEqual([]);
    expect(runCalls()).toHaveLength(0);
  });
});

describe('sweepGithubRunners: reaping', () => {
  const T = new Date('2026-10-28T10:30:00Z').getTime();
  const OLD = '2026-10-28 10:00:00 +0000 UTC';

  it('keeps a running runner without a creation time, and one whose registration cannot be found', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    psRows = [
      psRow(`nd-${ghApp.id}-1-aaaaaa`, 'running', 'unparsable', ghApp.id, 1, 'acme/api', 31, 'org:acme'),
      // No scope label: GitHub cannot be asked, so it counts as busy.
      psRow(`nd-${ghApp.id}-2-bbbbbb`, 'running', OLD, ghApp.id, 2, 'acme/api', 32, ''),
      // A scope label that is not ours.
      psRow(`nd-${ghApp.id}-3-cccccc`, 'running', OLD, ghApp.id, 3, 'acme/api', 33, 'team:acme'),
      // A repository label that is not a repository name.
      psRow(`nd-${ghApp.id}-4-dddddd`, 'running', OLD, ghApp.id, 4, 'acme/api', 34, 'repo:../etc'),
      // An App that no longer exists.
      psRow(`nd-999-5-eeeeee`, 'running', OLD, 999, 5, 'acme/api', 35, 'org:acme'),
      // An organization no installation belongs to.
      psRow(`nd-${ghApp.id}-6-ffffff`, 'running', OLD, ghApp.id, 6, 'other/api', 36, 'org:other'),
      // No runner id.
      psRow(`nd-${ghApp.id}-7-abcabc`, 'running', OLD, ghApp.id, 7, 'acme/api', '', 'org:acme'),
    ];
    await lib.sweepGithubRunners(db, log, T);
    expect(h.capture.mock.calls.some(([, a]) => a[0] === 'rm')).toBe(false);
    expect(h.githubApi.mock.calls.some(([, , m]) => m === 'GET')).toBe(false);
  });

  it('reaps an idle repository runner through the repository path, and survives a failed deregistration', async () => {
    await seedInstallation(db, ghApp, { installationId: 9002, accountLogin: 'Jane', accountType: 'User' });
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    psRows = [psRow(`nd-${ghApp.id}-1-aaaaaa`, 'running', OLD, ghApp.id, 1, 'jane/site', 41, 'repo:jane/site')];
    h.githubApi.mockImplementation(async (_a: unknown, _t: string, method: string) => {
      if (method === 'GET') return ok({ busy: false });
      throw new Error('500');
    });
    await lib.sweepGithubRunners(db, log, T);
    expect(h.githubApi.mock.calls.map(([, , m, p]) => `${m} ${p}`)).toEqual(['GET /repos/jane/site/actions/runners/41', 'DELETE /repos/jane/site/actions/runners/41']);
    expect(h.installationToken).toHaveBeenCalledWith(db, ghApp, expect.objectContaining({ accountLogin: 'Jane' }), { permissions: { administration: 'write' } });
    expect(h.capture.mock.calls.filter(([, a]) => a[0] === 'rm').map(([, a]) => a[2])).toEqual([`nd-${ghApp.id}-1-aaaaaa`]);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ reason: 'never picked up a job' }), 'removed a runner');
  });

  it('removes a runner past the job limit even when GitHub cannot be asked about it', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    psRows = [psRow(`nd-${ghApp.id}-1-aaaaaa`, 'running', OLD, ghApp.id, 1, 'acme/api', 31, '')];
    await lib.sweepGithubRunners(db, log, new Date('2026-10-28T17:00:00Z').getTime());
    expect(h.capture.mock.calls.filter(([, a]) => a[0] === 'rm').map(([, a]) => a[2])).toEqual([`nd-${ghApp.id}-1-aaaaaa`]);
    expect(h.githubApi).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ reason: 'outlived the 6-hour job limit' }), 'removed a runner');
  });

  it('keeps a runner whose busy check fails for another reason than a 404', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled());
    psRows = [psRow(`nd-${ghApp.id}-1-aaaaaa`, 'running', OLD, ghApp.id, 1, 'acme/api', 31, 'org:acme')];
    h.githubApi.mockRejectedValue(new GithubAppError('forbidden', 'forbidden', 403));
    await lib.sweepGithubRunners(db, log, T);
    expect(h.capture.mock.calls.some(([, a]) => a[0] === 'rm')).toBe(false);
  });

  it('reaps a node runner through the node, and leaves it when the node cannot remove it', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9 }));
    nodeRunners = [
      { name: 'nd-1-5-abcdef', state: 'running', githubAppId: ghApp.id, jobId: 5, repo: 'acme/api', runnerId: 30, scope: 'org:acme', createdAt: '2026-10-28T03:00:00Z' },
    ];
    await lib.sweepGithubRunners(db, log, T);
    expect(h.agentOp).toHaveBeenCalledWith(db, 9, 'gha.runner.stop', { name: 'nd-1-5-abcdef' }, expect.any(Function), { timeoutMs: 11 * 60 * 1000 });
    expect(h.githubApi).toHaveBeenCalledWith(expect.anything(), 'ghs_token', 'DELETE', '/orgs/acme/actions/runners/30');
    // The agent op's line callback is a no-op.
    const onLine = h.agentOp.mock.calls.find((c) => c[2] === 'gha.runner.stop')![4] as (l: string) => void;
    expect(onLine('x')).toBeUndefined();

    h.githubApi.mockClear();
    h.agentOp.mockImplementation(async (_db: unknown, _s: number, op: string) => {
      if (op === 'gha.runner.stop') throw new Error('node went away');
      return { exitCode: 0, lines: [`ND-GHA-RUNNERS ${JSON.stringify(nodeRunners)}`] };
    });
    await lib.sweepGithubRunners(db, log, T);
    expect(h.githubApi.mock.calls.some(([, , m]) => m === 'DELETE')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ runner: 'nd-1-5-abcdef' }), 'could not remove a runner');
  });
});

describe('stopRunner', () => {
  it('stops a node runner through the node and removes its registration', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9 }));
    nodeRunners = [{ name: 'nd-1-5-abcdef', state: 'running', githubAppId: ghApp.id, jobId: 5, repo: 'acme/api', runnerId: 30, scope: 'org:acme' }];
    expect(await lib.stopRunner(db, log, ghApp.id, 'nd-1-5-abcdef')).toBe(true);
    expect(opsCalled()).toEqual(['gha.runner.list', 'gha.runner.stop']);
    expect(h.capture.mock.calls.some(([, a]) => a[0] === 'rm')).toBe(false);
    expect(h.githubApi).toHaveBeenCalledWith(expect.anything(), 'ghs_token', 'DELETE', '/orgs/acme/actions/runners/30');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ reason: 'stopped by an operator' }), 'removed a runner');
  });

  it('surfaces a node failure to the operator', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9 }));
    nodeRunners = [{ name: 'nd-1-5-abcdef', state: 'running', githubAppId: ghApp.id, runnerId: 30, scope: 'org:acme' }];
    h.agentOp.mockImplementation(async (_db: unknown, _s: number, op: string) => {
      if (op === 'gha.runner.stop') throw new Error('gha.runner: no runner nd-1-5-abcdef on this node');
      return { exitCode: 0, lines: [`ND-GHA-RUNNERS ${JSON.stringify(nodeRunners)}`] };
    });
    await expect(lib.stopRunner(db, log, ghApp.id, 'nd-1-5-abcdef')).rejects.toThrow('no runner');
  });

  it('answers false when no host lists the runner', async () => {
    psRows = null;
    expect(await lib.stopRunner(db, log, ghApp.id, `nd-${ghApp.id}-1-aaaaaa`)).toBe(false);
  });
});

describe('runner status and problems', () => {
  it('says why runners cannot start on a node that refuses the capability', async () => {
    h.assertNodeCapability.mockRejectedValue(new Error('the agent on node #9 does not offer gha.runner'));
    const problems = await lib.runnerProblems(db, ghApp, enabled({ serverId: 9 }));
    expect(problems).toEqual(['Runners cannot start on node #9: the agent on node #9 does not offer gha.runner']);
    h.assertNodeCapability.mockRejectedValue('sealed requests are off');
    expect(await lib.runnerProblems(db, ghApp, enabled({ serverId: 9 }))).toEqual(['Runners cannot start on node #9: sealed requests are off']);
  });

  it('names an App without installations or events, and a personal installation without administration', async () => {
    const bare = await seedApp(db, key, { appId: 5151, events: null });
    expect(await lib.runnerProblems(db, bare, enabled())).toEqual([
      expect.stringContaining('Workflow job'),
      'The GitHub App is not installed on any account yet.',
    ]);
    await seedInstallation(db, bare, { installationId: 9200, accountLogin: null, accountType: 'User', permissions: null });
    const problems = await lib.runnerProblems(db, bare, enabled());
    expect(problems.join('\n')).toContain('The installation on #9200 lacks "administration: write"');
  });

  it('reports a node that did not list its runners, only while runners are on', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9 }));
    h.agentOp.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const status = await lib.runnerStatus(db, ghApp);
    expect(status.problems).toEqual(['Node #9 did not list its runners: connect ECONNREFUSED']);
    expect(status.active).toEqual([]);

    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9, enabled: false }));
    expect((await lib.runnerStatus(db, ghApp)).problems).toEqual([]);
  });

  it('lists only this App runners, with a null start time when unknown', async () => {
    psRows = [
      psRow(`nd-${ghApp.id}-1-aaaaaa`, 'running', 'unparsable', ghApp.id, 1, 'acme/api', 31, 'org:acme'),
      psRow(`nd-999-1-aaaaaa`, 'running', 'unparsable', 999, 1, 'acme/api', 31, 'org:acme'),
    ];
    const status = await lib.runnerStatus(db, ghApp);
    expect(status.active).toEqual([{ name: `nd-${ghApp.id}-1-aaaaaa`, serverId: null, jobId: 1, repo: 'acme/api', state: 'running', startedAt: null }]);
  });
});

describe('the agent ops on the node', () => {
  const env = { NINEDEPLOY_AGENT_GHA_RUNNERS: 'on' };
  const run = (op: string, params: Record<string, unknown>) => {
    const lines: string[] = [];
    return registry.runRegisteredOp(op, params, (l) => lines.push(l), { sealed: true }, env).then((code) => ({ code, lines }));
  };
  const good = { name: 'nd-1-77-abcdef', app: 1, job: 77, repo: 'acme/api', runner: 31, scope: 'org:acme', cpus: 2, memoryMb: 4096, jitConfig: 'SklUU0VDUkVUSklUU0VDUkVU' };

  it('prepares the network and the host firewall', async () => {
    const res = await run('gha.runner.prepare', {});
    expect(res).toEqual({ code: 0, lines: ['ND-GHA-RUNNER {"prepared":true}'] });
    expect(h.capture.mock.calls.some(([, a]) => a.includes('nsenter'))).toBe(true);
  });

  it('names a non-Error firewall failure, and keeps only the tail of a long one', async () => {
    h.capture.mockImplementation(async (_c, args) => {
      if (args.includes('nsenter')) throw 'exit 3';
      return args[1] === 'inspect' ? 'false nd-gha0' : 'net1';
    });
    await expect(run('gha.runner.prepare', {})).rejects.toThrow('on this node: exit 3');
    h.capture.mockImplementation(async (_c, args) => {
      if (args.includes('nsenter')) throw new Error(`${'a'.repeat(400)}TAIL`);
      return args[1] === 'inspect' ? 'false nd-gha0' : 'net1';
    });
    const err = await run('gha.runner.prepare', {}).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/TAIL$/);
    expect((err as Error).message).not.toContain('a'.repeat(301));
  });

  it('starts nothing when the network is not the isolated one', async () => {
    h.capture.mockImplementation(async (_c, args) => (args[1] === 'inspect' ? 'true nd-gha0' : 'net1'));
    await expect(run('gha.runner.start', good)).rejects.toThrow(/not the isolated runner network/);
    expect(h.capture.mock.calls.some(([, a]) => a.includes('nsenter') || a.includes('--env-file'))).toBe(false);
  });

  it('starts a runner without limits, and reports it', async () => {
    const res = await run('gha.runner.start', { ...good, cpus: undefined, memoryMb: null });
    expect(res.lines).toEqual(['ND-GHA-RUNNER {"started":"nd-1-77-abcdef"}']);
    const runner = h.capture.mock.calls.find(([, a]) => a.includes('--env-file'))!;
    expect(runner[1]).not.toContain('--cpus');
    expect(runner[1]).not.toContain('--memory');
    expect(runner[1]).toContain('ninedeploy.gha-runner.scope=org:acme');
  });

  it('accepts a repository scope', async () => {
    const res = await run('gha.runner.start', { ...good, scope: 'repo:acme/api' });
    expect(res.code).toBe(0);
  });

  it('cleans up the env file even when docker run fails', async () => {
    let envPath = '';
    h.capture.mockImplementation(async (_c, args) => {
      if (args.includes('--env-file')) {
        envPath = args[args.indexOf('--env-file') + 1]!;
        throw new Error('pull access denied');
      }
      return args[1] === 'inspect' ? 'false nd-gha0' : 'net1';
    });
    await expect(run('gha.runner.start', good)).rejects.toThrow('pull access denied');
    const { existsSync } = await import('node:fs');
    expect(envPath).not.toBe('');
    expect(existsSync(envPath)).toBe(false);
  });

  it.each([
    [{ name: 42 }, /runner name/],
    [{ repo: 7 }, /invalid repo/],
    [{ scope: 3 }, /invalid scope/],
    [{ scope: 'team:acme' }, /invalid scope/],
    [{ cpus: '2' }, /invalid cpus/],
    [{ cpus: 0.1 }, /invalid cpus/],
    [{ cpus: 65 }, /invalid cpus/],
    [{ cpus: Number.NaN }, /invalid cpus/],
    [{ memoryMb: '4096' }, /invalid memoryMb/],
    [{ memoryMb: 1024.5 }, /invalid memoryMb/],
    [{ memoryMb: 262145 }, /invalid memoryMb/],
    [{ jitConfig: 5 }, /invalid jitConfig/],
    [{ jitConfig: 'short' }, /invalid jitConfig/],
    [{ app: '1' }, /invalid app/],
    [{ app: 0 }, /invalid app/],
    [{ job: 1.5 }, /invalid job/],
    [{ job: Number.MAX_SAFE_INTEGER + 2 }, /invalid job/],
    [{ runner: -3 }, /invalid runner/],
    [{ runner: undefined }, /invalid runner/],
  ])('refuses %o before touching Docker', async (bad, message) => {
    await expect(run('gha.runner.start', { ...good, ...bad })).rejects.toThrow(message);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('lists the runner containers it started', async () => {
    psRows = [psRow('nd-1-77-abcdef', 'running', '2026-10-28 10:00:00 +0000 UTC', 1, 77, 'acme/api', 31, 'org:acme')];
    const res = await run('gha.runner.list', {});
    expect(res.code).toBe(0);
    expect(res.lines).toHaveLength(1);
    const listed = JSON.parse(res.lines[0]!.slice('ND-GHA-RUNNERS '.length)) as Array<Record<string, unknown>>;
    expect(listed).toEqual([expect.objectContaining({ name: 'nd-1-77-abcdef', githubAppId: 1, jobId: 77, runnerId: 31, scope: 'org:acme' })]);
    // What the node answers, the panel reads back.
    h.agentOp.mockResolvedValue({ exitCode: 0, lines: res.lines });
    expect((await lib.listNodeRunnerContainers(db, 9)).map((c) => [c.name, c.serverId])).toEqual([['nd-1-77-abcdef', 9]]);
  });

  it('stops a runner it started, and refuses a malformed name', async () => {
    psRows = [psRow('nd-1-77-abcdef', 'running', '2026-10-28 10:00:00 +0000 UTC', 1, 77, 'acme/api', 31, 'org:acme')];
    const res = await run('gha.runner.stop', { name: 'nd-1-77-abcdef' });
    expect(res.lines).toEqual(['ND-GHA-RUNNER {"stopped":"nd-1-77-abcdef"}']);
    expect(h.capture).toHaveBeenCalledWith('docker', ['rm', '-f', 'nd-1-77-abcdef'], { timeoutMs: 60_000 });
    await expect(run('gha.runner.stop', { name: 'ninedeploy-traefik' })).rejects.toThrow(/runner name/);
    await expect(run('gha.runner.stop', {})).rejects.toThrow(/runner name/);
  });
});
