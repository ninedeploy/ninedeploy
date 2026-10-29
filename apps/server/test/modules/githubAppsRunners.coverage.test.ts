/**
 * G4.5 runner routes of the GitHub App operator API (`modules/githubApps.ts`):
 * `GET/PUT /:id/runners` and `DELETE /:id/runners/:name`. Docker, the node
 * agent and GitHub are mocked: `docker ps` prints the rows a test sets, the
 * node lists the runners a test sets.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, servers, users, type DB, type GithubApp } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return {
    capture: vi.fn<(cmd: string, args: string[], opts?: unknown) => Promise<string>>(),
    githubApi: vi.fn(),
    installationToken: vi.fn(async () => 'ghs_token'),
    agentOp: vi.fn(),
    assertNodeCapability: vi.fn(async () => undefined),
    guardedFetch: vi.fn(),
  };
});

vi.mock('../../src/lib/egressGuard.js', async (orig) => ({ ...(await orig<object>()), guardedFetch: h.guardedFetch }));
vi.mock('../../src/lib/panelOrigin.js', () => ({ panelOrigin: async () => 'https://panel.example.com' }));
vi.mock('../../src/lib/exec.js', async (orig) => ({ ...(await orig<object>()), capture: h.capture }));
vi.mock('../../src/lib/githubApp.js', async (orig) => ({ ...(await orig<object>()), githubApi: h.githubApi, installationToken: h.installationToken }));
vi.mock('../../src/lib/agentClient.js', async (orig) => ({ ...(await orig<object>()), agentOp: h.agentOp }));
vi.mock('../../src/lib/agentCapabilities.js', async (orig) => ({ ...(await orig<object>()), assertNodeCapability: h.assertNodeCapability }));

const { githubAppsRoutes } = await import('../../src/modules/githubApps.js');
const { getRunnerConfig, resetGithubRunnersForTests, setRunnerConfig, handleWorkflowJob } = await import('../../src/lib/githubRunners.js');
const { asUser, buildTestApp } = await import('../helpers.js');
const { closeMigratedDb, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('../lib/githubAppKit.js');

const key = rsaKeyPair('pkcs1');
const config = { enabled: true, labels: ['ninedeploy'], maxConcurrent: 2, cpus: 1, memoryMb: 1024, allowPublicRepos: false, repositories: [] };

let db: DB;
let row: GithubApp;
/** `docker ps` rows on the panel host; null = Docker unreachable. */
let psRows: string[] | null;
let nodeRunners: Array<Record<string, unknown>>;

const psRow = (name: string, app: number, runner = 31) => [name, 'running', '2026-10-28 10:00:00 +0000 UTC', app, 1, 'acme/api', runner, 'org:acme'].join('\t');

beforeEach(async () => {
  resetGithubRunnersForTests();
  db = await migratedDb();
  await db.insert(users).values([{ id: 1, email: 'op1@example.test', passwordHash: 'x', isInstanceOperator: true }]);
  await db.insert(servers).values({ id: 9, name: 'ci-1', host: '203.0.113.9', port: 4600, tokenEncrypted: 'x', status: 'online' });
  row = await seedApp(db, key.privateKey, { events: ['workflow_job'] });
  await seedInstallation(db, row, { accountType: 'Organization', permissions: { organization_self_hosted_runners: 'write' } });
  psRows = [];
  nodeRunners = [];
  h.capture.mockReset().mockImplementation(async (_cmd, args) => {
    if (args[0] === 'ps') {
      if (psRows === null) throw new Error('Cannot connect to the Docker daemon');
      return psRows.join('\n');
    }
    return '';
  });
  h.agentOp.mockReset().mockImplementation(async (_db: unknown, _s: number, op: string) => ({
    exitCode: 0,
    lines: op === 'gha.runner.list' ? [`ND-GHA-RUNNERS ${JSON.stringify(nodeRunners)}`] : ['ND-GHA-RUNNER {}'],
  }));
  h.assertNodeCapability.mockReset().mockResolvedValue(undefined);
  h.githubApi.mockReset().mockResolvedValue({ status: 204, data: null, headers: new Headers() });
  h.guardedFetch.mockReset().mockRejectedValue(new Error('no network in this test'));
});

afterEach(() => closeMigratedDb(db));

async function server() {
  const app = await buildTestApp({ db });
  await app.register(githubAppsRoutes);
  return app;
}

const put = async (payload: unknown, id: number = row.id) => (await server()).inject({ method: 'PUT', url: `/${id}/runners`, headers: asUser(1), payload: payload as Record<string, unknown> });
const auditsOf = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

describe('GET /:id/runners', () => {
  it('answers 404 for an App that does not exist', async () => {
    const app = await server();
    expect((await app.inject({ method: 'GET', url: '/9999/runners', headers: asUser(1) })).statusCode).toBe(404);
  });

  it('lists the runners on the panel host and says when Docker is unreachable', async () => {
    await setRunnerConfig(db, row.id, config);
    psRows = [psRow(`nd-${row.id}-1-aaaaaa`, row.id)];
    const app = await server();
    const res = (await app.inject({ method: 'GET', url: `/${row.id}/runners`, headers: asUser(1) })).json();
    expect(res.active).toEqual([expect.objectContaining({ name: `nd-${row.id}-1-aaaaaa`, serverId: null, state: 'running' })]);
    expect(res.problems).toEqual([]);
    psRows = null;
    const down = (await app.inject({ method: 'GET', url: `/${row.id}/runners`, headers: asUser(1) })).json();
    expect(down.problems).toEqual(['Docker is not reachable on the panel host.']);
  });
});

describe('PUT /:id/runners', () => {
  it('refuses to move runners to a node while this App still has runners on the panel host', async () => {
    await setRunnerConfig(db, row.id, config);
    psRows = [psRow(`nd-${row.id}-1-aaaaaa`, row.id)];
    const res = await put({ ...config, serverId: 9 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('runners_active');
    expect((await getRunnerConfig(db, row.id)).serverId ?? null).toBeNull();
    expect(await auditsOf('github_app.runners_update')).toHaveLength(0);
  });

  it('refuses to move runners back to the panel host while some still run on the node', async () => {
    await setRunnerConfig(db, row.id, { ...config, serverId: 9 });
    nodeRunners = [{ name: 'nd-1-5-abcdef', state: 'running', githubAppId: row.id, runnerId: 30, scope: 'org:acme' }];
    const res = await put({ ...config, serverId: null });
    expect(res.statusCode).toBe(409);
    expect((await getRunnerConfig(db, row.id)).serverId).toBe(9);
  });

  it('moves runners when only other Apps have runners on the old host', async () => {
    await setRunnerConfig(db, row.id, config);
    psRows = [psRow('nd-999-1-aaaaaa', 999), psRow(`nd-${row.id}-1-bbbbbb`, row.id + 1)];
    const res = await put({ ...config, serverId: 9 });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.serverId).toBe(9);
    await vi.waitFor(async () => expect(await auditsOf('github_app.runners_update')).toHaveLength(1));
    const [audit] = await auditsOf('github_app.runners_update');
    expect(audit?.meta).toMatchObject({ githubAppId: row.id, serverId: 9, enabled: true, repositories: 0, maxConcurrent: 2 });
  });

  it('moves runners when the old host cannot list any of them', async () => {
    await setRunnerConfig(db, row.id, config);
    psRows = null;
    const res = await put({ ...config, serverId: 9 });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.serverId).toBe(9);
  });

  it('turning runners off forgets this App waiting jobs', async () => {
    await setRunnerConfig(db, row.id, config);
    psRows = null; // the job waits: the panel host cannot count its runners
    const inst = (await db.query.githubAppInstallations.findFirst())!;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    await handleWorkflowJob(db, log, row, inst, {
      action: 'queued',
      workflow_job: { id: 77, name: 'build', labels: ['ninedeploy'] },
      repository: { id: 5, full_name: 'acme/api', private: true },
    });
    const app = await server();
    const before = (await app.inject({ method: 'GET', url: `/${row.id}/runners`, headers: asUser(1) })).json();
    expect(before.pending).toHaveLength(1);
    const res = await put({ ...config, enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().pending).toEqual([]);
    expect(res.json().config.enabled).toBe(false);
  });

  it('refuses a request without a body and stores nothing', async () => {
    const res = await put(undefined);
    expect(res.statusCode).toBe(400);
    expect(await auditsOf('github_app.runners_update')).toHaveLength(0);
  });

  it('answers 404 for an App that does not exist', async () => {
    expect((await put(config, 9999)).statusCode).toBe(404);
  });
});

describe('DELETE /:id/runners/:name', () => {
  it('stops this App runner, removes its registration and audits it', async () => {
    const name = `nd-${row.id}-1-aaaaaa`;
    psRows = [psRow(name, row.id)];
    const app = await server();
    const res = await app.inject({ method: 'DELETE', url: `/${row.id}/runners/${name}`, headers: asUser(1) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.capture).toHaveBeenCalledWith('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
    expect(h.githubApi).toHaveBeenCalledWith(expect.anything(), 'ghs_token', 'DELETE', '/orgs/acme/actions/runners/31');
    await vi.waitFor(async () => expect(await auditsOf('github_app.runner_stop')).toHaveLength(1));
    const [audit] = await auditsOf('github_app.runner_stop');
    expect(audit?.meta).toMatchObject({ githubAppId: row.id, runner: name });
  });

  it('stops a runner on a node through the node agent', async () => {
    await setRunnerConfig(db, row.id, { ...config, serverId: 9 });
    nodeRunners = [{ name: 'nd-1-5-abcdef', state: 'running', githubAppId: row.id, runnerId: 30, scope: 'org:acme' }];
    const app = await server();
    const res = await app.inject({ method: 'DELETE', url: `/${row.id}/runners/nd-1-5-abcdef`, headers: asUser(1) });
    expect(res.statusCode).toBe(200);
    expect(h.agentOp).toHaveBeenCalledWith(db, 9, 'gha.runner.stop', { name: 'nd-1-5-abcdef' }, expect.any(Function), expect.anything());
  });

  it('answers 404 for a runner of another App or one no host lists', async () => {
    const name = `nd-${row.id}-1-aaaaaa`;
    psRows = [psRow(name, row.id + 1)];
    const app = await server();
    const res = await app.inject({ method: 'DELETE', url: `/${row.id}/runners/${name}`, headers: asUser(1) });
    expect(res.statusCode).toBe(404);
    expect(h.capture.mock.calls.some(([, a]) => a[0] === 'rm')).toBe(false);
    expect(await auditsOf('github_app.runner_stop')).toHaveLength(0);
  });

  it('answers 404 for an App that does not exist', async () => {
    const app = await server();
    expect((await app.inject({ method: 'DELETE', url: '/9999/runners/nd-1-1-aaaaaa', headers: asUser(1) })).statusCode).toBe(404);
  });
});
