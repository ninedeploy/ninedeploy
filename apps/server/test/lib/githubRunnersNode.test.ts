/**
 * G4.5 Actions runners on a node: the agent ops (agentOps/githubRunners.ts,
 * opt-in `gha.runner`) and the panel starting, counting and reaping runners
 * there through them. Docker, GitHub and the agent transport are mocked.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { servers, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';
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
  };
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
const { migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
const enabled = (over: Partial<GithubRunnerConfig> = {}): GithubRunnerConfig => ({ ...GITHUB_RUNNER_DEFAULTS, enabled: true, ...over });
const queued = (id = 77) => ({
  action: 'queued',
  workflow_job: { id, name: 'build', labels: ['self-hosted', 'ninedeploy'] },
  repository: { id: 5, full_name: 'acme/api', private: true },
  installation: { id: 9001 },
});

let db: DB;
let ghApp: GithubApp;
let inst: GithubAppInstallation;
let key: string;
/** What the node's `gha.runner.list` reports. */
let nodeRunners: Array<Record<string, unknown>>;
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
  nodeRunners = [];
  envFiles = [];
  h.listInstallationRepositories.mockReset().mockResolvedValue({ repositories: [{ id: 5, full_name: 'acme/api', private: true }], truncated: false });
  h.capture.mockReset().mockImplementation(async (_cmd, args) => {
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
    if (method === 'POST' && path.endsWith('/generate-jitconfig')) return { status: 201, data: { runner: { id: 31 }, encoded_jit_config: 'SklUU0VDUkVUSklUU0VDUkVU' }, headers: new Headers() };
    if (method === 'GET' && path.includes('/actions/runner-groups')) return { status: 200, data: { runner_groups: [] }, headers: new Headers() };
    if (method === 'POST' && path.endsWith('/actions/runner-groups')) return { status: 201, data: { id: 7 }, headers: new Headers() };
    return { status: 200, data: { busy: false }, headers: new Headers() };
  });
});
afterEach(() => {
  delete process.env['NINEDEPLOY_AGENT_GHA_RUNNERS'];
});

const opsCalled = () => h.agentOp.mock.calls.map((c) => c[2] as string);

describe('the panel, with runners on a node', () => {
  it('prepares the node before registering anything, then starts the runner there with the JIT config sealed', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9 }));
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued());
    await lib.drainPending(db, log);
    expect(opsCalled()).toEqual(['gha.runner.list', 'gha.runner.prepare', 'gha.runner.start']);
    const prepareAt = h.agentOp.mock.invocationCallOrder[1]!;
    const jitAt = h.githubApi.mock.invocationCallOrder[h.githubApi.mock.calls.findIndex(([, , m, p]) => m === 'POST' && String(p).endsWith('generate-jitconfig'))]!;
    expect(prepareAt).toBeLessThan(jitAt);
    const start = h.agentOp.mock.calls[2]!;
    expect(start[1]).toBe(9);
    expect(start[3]).toMatchObject({ app: ghApp.id, job: 77, repo: 'acme/api', runner: 31, scope: 'org:acme', jitConfig: 'SklUU0VDUkVUSklUU0VDUkVU', cpus: 2, memoryMb: 4096 });
    expect(h.assertNodeCapability).toHaveBeenCalledWith(db, 9, expect.objectContaining({ cap: 'gha.runner', sealedRequired: true }));
    // Nothing ran on the panel host.
    expect(h.capture.mock.calls.some(([, a]) => a[0] === 'run')).toBe(false);
  });

  it('removes the registration when the node cannot start the runner', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9 }));
    h.agentOp.mockImplementation(async (_db: unknown, _s: number, op: string) => {
      if (op === 'gha.runner.start') throw new Error('docker run failed');
      return { exitCode: 0, lines: op === 'gha.runner.list' ? ['ND-GHA-RUNNERS []'] : [] };
    });
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued());
    await lib.drainPending(db, log);
    expect(h.githubApi).toHaveBeenCalledWith(expect.anything(), 'ghs_token', 'DELETE', '/orgs/acme/actions/runners/31');
  });

  it('counts the node runners against the slot limit, and holds jobs while the node cannot answer', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9, maxConcurrent: 1 }));
    nodeRunners = [{ name: 'nd-1-5-abcdef', state: 'running', githubAppId: ghApp.id, jobId: 5, repo: 'acme/api', runnerId: 30, scope: 'org:acme', createdAt: new Date().toISOString() }];
    await lib.handleWorkflowJob(db, log, ghApp, inst, queued());
    await lib.drainPending(db, log);
    expect(opsCalled()).not.toContain('gha.runner.start');
    nodeRunners = [];
    h.agentOp.mockRejectedValueOnce(new Error('node unreachable'));
    await lib.drainPending(db, log);
    expect(opsCalled()).not.toContain('gha.runner.start');
    // Once it answers again, the waiting job starts.
    await lib.drainPending(db, log);
    expect(opsCalled()).toContain('gha.runner.start');
  });

  it('reaps an exited node runner through the node, and lists it in the status', async () => {
    await lib.setRunnerConfig(db, ghApp.id, enabled({ serverId: 9 }));
    nodeRunners = [
      { name: 'nd-1-5-abcdef', state: 'exited', githubAppId: ghApp.id, jobId: 5, repo: 'acme/api', runnerId: 30, scope: 'org:acme', createdAt: new Date().toISOString() },
      // Not a name this module gives: ignored.
      { name: 'ninedeploy-agent', state: 'running', githubAppId: ghApp.id },
    ];
    const status = await lib.runnerStatus(db, ghApp);
    expect(status.active).toEqual([expect.objectContaining({ name: 'nd-1-5-abcdef', serverId: 9 })]);
    await lib.sweepGithubRunners(db, log);
    expect(h.agentOp).toHaveBeenCalledWith(db, 9, 'gha.runner.stop', { name: 'nd-1-5-abcdef' }, expect.any(Function), expect.anything());
  });
});

describe('the agent ops', () => {
  const run = (op: string, params: Record<string, unknown>, sealed = true) => {
    const lines: string[] = [];
    return registry.runRegisteredOp(op, params, (l) => lines.push(l), { sealed }, { NINEDEPLOY_AGENT_GHA_RUNNERS: 'on' }).then(() => lines);
  };
  const good = { name: 'nd-1-77-abcdef', app: 1, job: 77, repo: 'acme/api', runner: 31, scope: 'org:acme', cpus: 2, memoryMb: 4096, jitConfig: 'SklUU0VDUkVUSklUU0VDUkVU' };

  it('are opt-in on the node, sealed only', () => {
    expect(registry.AGENT_OPS.get('gha.runner.start')).toMatchObject({ cap: 'gha.runner', sealedOnly: true });
    expect(registry.capabilityKillSwitch('gha.runner', {})).toBe('NINEDEPLOY_AGENT_GHA_RUNNERS');
    expect(registry.capabilityKillSwitch('gha.runner', { NINEDEPLOY_AGENT_GHA_RUNNERS: 'on' })).toBeNull();
    expect(registry.capabilityKillSwitch('gha.runner', { NINEDEPLOY_AGENT_GHA_RUNNERS: 'off' })).toBe('NINEDEPLOY_AGENT_GHA_RUNNERS');
  });

  it('firewalls the host through the nsenter helper, then runs the runner with the JIT config only in the env file', async () => {
    await run('gha.runner.start', good);
    const host = h.capture.mock.calls.find(([, a]) => a.includes('nsenter'))!;
    expect(host[1]).toEqual(expect.arrayContaining(['--privileged', '--pid=host', '--net=host']));
    const script = host[1].at(-1)!;
    expect(script).toContain('[ -e /sys/class/net/nd-gha0 ]');
    expect(script).toContain('iptables -C INPUT -i nd-gha0 -j DROP 2>/dev/null || iptables -I INPUT 1 -i nd-gha0 -j DROP');
    expect(script).toContain('-d 169.254.0.0/16 -j DROP');
    const runner = h.capture.mock.calls.find(([, a]) => a.includes('--env-file'))!;
    expect(h.capture.mock.calls.indexOf(host)).toBeLessThan(h.capture.mock.calls.indexOf(runner));
    expect(runner[1].join(' ')).not.toContain(good.jitConfig);
    expect(runner[1]).toEqual(expect.arrayContaining(['--network', 'nd-gha-runners', '--cpus', '2', '--memory', '4096m']));
    expect(runner[1].join(' ')).not.toContain('docker.sock');
    expect(envFiles).toEqual([`ND_JITCONFIG=${good.jitConfig}\n`]);
  });

  it('starts nothing when the firewall cannot be put in place', async () => {
    h.capture.mockImplementation(async (_c, args) => {
      if (args.includes('nsenter')) throw new Error('iptables is not installed on the host');
      if (args[0] === 'network' && args[1] === 'ls') return 'net1\n';
      if (args[0] === 'network' && args[1] === 'inspect') return 'false nd-gha0\n';
      return '';
    });
    await expect(run('gha.runner.start', good)).rejects.toThrow(/firewall rules/);
    expect(h.capture.mock.calls.some(([, a]) => a.includes('--env-file'))).toBe(false);
  });

  it('refuses malformed requests', async () => {
    await expect(run('gha.runner.start', { ...good, name: 'ninedeploy-agent' })).rejects.toThrow(/runner name/);
    await expect(run('gha.runner.start', { ...good, repo: '../x' })).rejects.toThrow(/repo/);
    await expect(run('gha.runner.start', { ...good, scope: 'org:a b' })).rejects.toThrow(/scope/);
    await expect(run('gha.runner.start', { ...good, jitConfig: 'x\nND_OTHER=1' })).rejects.toThrow(/jitConfig/);
    await expect(run('gha.runner.start', { ...good, memoryMb: 10 })).rejects.toThrow(/memoryMb/);
    // Stop removes only a runner container this module started.
    await expect(run('gha.runner.stop', { name: 'nd-1-77-abcdef' })).rejects.toThrow(/no runner/);
  });
});
