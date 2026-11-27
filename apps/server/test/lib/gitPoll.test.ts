/** X2 Git polling (`lib/gitPoll.ts`, `modules/gitPoll.ts`) on a migrated SQLite: what a poll deploys, and what it leaves alone. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { deployments, services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
// The git call itself is proven against a real Git server in gitRemoteHead.test.ts; here it is a stand-in,
// so that the poll's own reader (the source's credential, then the call) runs for real.
vi.mock('../../src/lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/git.js')>();
  return { ...actual, remoteBranchHead: vi.fn() };
});

const lib = await import('../../src/lib/gitPoll.js');
const { remoteBranchHead } = await import('../../src/lib/git.js');
const { gitPollRoutes } = await import('../../src/modules/gitPoll.js');
const { audit } = await import('../../src/lib/audit.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  vi.mocked(audit).mockClear();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, repoUrl: 'https://github.com/acme/web.git', commitSha: 'a'.repeat(40), status: 'running' },
    { id: 6, name: 'img', slug: 'img', type: 'docker', branch: 'main', ownerUserId: 1, status: 'running' },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

const RUNNING = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const LATER = 'c'.repeat(40);
const MIN = 60_000;
const T0 = Date.parse('2026-11-27T12:00:00Z');
const NOTHING = { due: 0, queued: 0, unchanged: 0, failed: 0 };

describe('the setting', () => {
  it('is off until turned on, keeps what the polls found when the interval changes, and is gone when turned off', async () => {
    const { setSettingJson } = await import('../../src/lib/settings.js');
    expect(await lib.getGitPoll(db, 5)).toBeNull();
    await setSettingJson(db, 'git_poll:5', { intervalSeconds: 300, lastSha: NEXT, lastPolledAt: '2026-11-27T11:00:00.000Z', lastError: null, lastDeploymentId: 9 });
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ intervalSeconds: 60, lastSha: NEXT, lastDeploymentId: 9 });
    // An export carries the interval, never the state of a poll.
    const { readPortableServiceSettings } = await import('../../src/lib/portableSettings.js');
    expect(await readPortableServiceSettings(db, 5)).toEqual({ gitPoll: { intervalSeconds: 60 } });
    await lib.setGitPoll(db, 5, null);
    expect(await lib.getGitPoll(db, 5)).toBeNull();
    // A row of a shape this panel does not read is off, not a poll.
    await setSettingJson(db, 'git_poll:5', { intervalSeconds: 5 });
    expect(await lib.getGitPoll(db, 5)).toBeNull();
  });

  it('is for a service that has a repository, and names the provider from the URL', () => {
    expect(lib.gitPollSupported({ repoUrl: 'https://x/y.git' })).toBe(true);
    expect(lib.gitPollSupported({ repoUrl: null })).toBe(false);
    expect(lib.gitProviderOf('https://github.com/acme/web.git')).toBe('github');
    expect(lib.gitProviderOf('git@github.com:acme/web.git')).toBe('github');
    expect(lib.gitProviderOf('https://gitlab.com/acme/web.git')).toBe('gitlab');
    expect(lib.gitProviderOf('https://bitbucket.org/acme/web.git')).toBe('bitbucket');
    expect(lib.gitProviderOf('https://git.example.com/acme/web.git')).toBe('gitea');
  });
});

describe('pollDueGitServices', () => {
  function harness(head: string | null | Error, pushResult: Record<string, unknown> = { ok: true, deploymentId: 41 }) {
    const headFn = vi.fn(async () => {
      if (head instanceof Error) throw head;
      return head;
    });
    const push = vi.fn(async () => pushResult);
    return { headFn, push, deps: { now: T0, head: headFn, push: push as never } };
  }

  it('does nothing while no service polls', async () => {
    const h = harness(NEXT);
    expect(await lib.pollDueGitServices(db, h.deps)).toEqual(NOTHING);
    expect(h.headFn).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it('deploys a head the service does not run yet, once, and not again while the head stays', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    const h = harness(NEXT);
    expect(await lib.pollDueGitServices(db, h.deps)).toEqual({ due: 1, queued: 1, unchanged: 0, failed: 0 });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith(
      db,
      5,
      // A poll reads the head only: no message, no author, no changed files.
      { branch: 'main', sha: NEXT, message: '', author: '', changedFiles: [], commitsListed: 0 },
      { branch: 'main', watchPaths: null, provider: 'github' },
    );
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastSha: NEXT, lastPolledAt: '2026-11-27T12:00:00.000Z', lastError: null, lastDeploymentId: 41 });

    // Not due yet: the interval has not passed.
    expect(await lib.pollDueGitServices(db, { ...h.deps, now: T0 + 59_000 })).toEqual(NOTHING);
    expect(h.push).toHaveBeenCalledTimes(1);
    // Due again, the same head: nothing is deployed.
    expect(await lib.pollDueGitServices(db, { ...h.deps, now: T0 + MIN })).toEqual({ due: 1, queued: 0, unchanged: 1, failed: 0 });
    expect(h.push).toHaveBeenCalledTimes(1);
    // A new head is deployed.
    const h2 = harness(LATER);
    expect(await lib.pollDueGitServices(db, { ...h2.deps, now: T0 + 2 * MIN })).toEqual({ due: 1, queued: 1, unchanged: 0, failed: 0 });
    expect((await lib.getGitPoll(db, 5))?.lastSha).toBe(LATER);
  });

  it('goes through the push path for real: one deployment for the head, and none more while the head stays', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    // Only the git call is a stand-in (mocked above): the poll reads the head with the service's own
    // credentials, and the deploy is queued by the webhook path itself.
    vi.mocked(remoteBranchHead).mockReset().mockResolvedValue(NEXT);
    expect(await lib.pollDueGitServices(db, { now: T0 })).toEqual({ due: 1, queued: 1, unchanged: 0, failed: 0 });
    const [repoUrl, branch, creds, limits] = vi.mocked(remoteBranchHead).mock.calls[0];
    expect([repoUrl, branch, limits]).toEqual(['https://github.com/acme/web.git', 'main', { timeoutMs: 20_000 }]);
    // The service has no source, so the repository is read as it is.
    expect(creds?.token).toBeFalsy();
    const queued = await db.query.deployments.findMany({ where: eq(deployments.serviceId, 5) });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ commitSha: NEXT, status: 'queued', trigger: 'webhook' });
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastSha: NEXT, lastDeploymentId: queued[0].id, lastError: null });
    expect(await lib.pollDueGitServices(db, { now: T0 + MIN })).toEqual({ due: 1, queued: 0, unchanged: 1, failed: 0 });
    expect(await db.query.deployments.findMany({ where: eq(deployments.serviceId, 5) })).toHaveLength(1);
  });

  it("keeps the git call's own error when the head cannot be read", async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    vi.mocked(remoteBranchHead).mockReset().mockRejectedValueOnce(new Error('git ls-remote failed for https://github.com/acme/web.git: could not read Username'));
    expect(await lib.pollDueGitServices(db, { now: T0 })).toEqual({ due: 1, queued: 0, unchanged: 0, failed: 1 });
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastError: 'git ls-remote failed for https://github.com/acme/web.git: could not read Username' });
    expect(await db.query.deployments.findMany({ where: eq(deployments.serviceId, 5) })).toHaveLength(0);
  });

  it('deploys nothing when the first poll finds the commit the service already runs', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    const h = harness(RUNNING);
    expect(await lib.pollDueGitServices(db, h.deps)).toEqual({ due: 1, queued: 0, unchanged: 1, failed: 0 });
    expect(h.push).not.toHaveBeenCalled();
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastSha: RUNNING, lastError: null, lastDeploymentId: null });
  });

  it('leaves alone a head the service came to run between two polls, as when a webhook deployed it', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    expect(await lib.pollDueGitServices(db, harness(NEXT).deps)).toEqual({ due: 1, queued: 1, unchanged: 0, failed: 0 });
    // A webhook deploys the next commit, and that deploy finishes before the poll is due again:
    // no deployment of it is in progress any more for the duplicate guard to find.
    await db.update(services).set({ commitSha: LATER }).where(eq(services.id, 5));
    const h = harness(LATER);
    expect(await lib.pollDueGitServices(db, { ...h.deps, now: T0 + MIN })).toEqual({ due: 1, queued: 0, unchanged: 1, failed: 0 });
    expect(h.push).not.toHaveBeenCalled();
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastSha: LATER, lastError: null });
  });

  it('records a head the push path declined, so it is not offered again every interval', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    const h = harness(NEXT, { ok: 'skipped', reason: 'duplicate', deploymentId: 7 });
    expect(await lib.pollDueGitServices(db, h.deps)).toEqual({ due: 1, queued: 0, unchanged: 1, failed: 0 });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastSha: NEXT, lastDeploymentId: 7, lastError: null });
    expect(await lib.pollDueGitServices(db, { ...h.deps, now: T0 + MIN })).toEqual({ due: 1, queued: 0, unchanged: 1, failed: 0 });
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it('keeps the error of a poll that could not read the head, and reads it again at the next interval', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    const gone = harness(null);
    expect(await lib.pollDueGitServices(db, gone.deps)).toEqual({ due: 1, queued: 0, unchanged: 0, failed: 1 });
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastError: 'the remote has no branch main', lastPolledAt: '2026-11-27T12:00:00.000Z' });
    expect((await lib.getGitPoll(db, 5))?.lastSha).toBeUndefined();
    expect(gone.push).not.toHaveBeenCalled();

    const broken = harness(new Error(`git ls-remote failed for https://github.com/acme/web.git: ${'x'.repeat(400)}`));
    expect(await lib.pollDueGitServices(db, { ...broken.deps, now: T0 + MIN })).toEqual({ due: 1, queued: 0, unchanged: 0, failed: 1 });
    expect((await lib.getGitPoll(db, 5))?.lastError).toHaveLength(300);

    const back = harness(NEXT);
    expect(await lib.pollDueGitServices(db, { ...back.deps, now: T0 + 2 * MIN })).toEqual({ due: 1, queued: 1, unchanged: 0, failed: 0 });
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastSha: NEXT, lastError: null });
  });

  it('keeps a head the push path refused, so the next interval offers it again', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    const h = harness(NEXT);
    h.push.mockRejectedValueOnce(new Error('Forbidden: the owner of this service may not deploy it'));
    expect(await lib.pollDueGitServices(db, h.deps)).toEqual({ due: 1, queued: 0, unchanged: 0, failed: 1 });
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastError: 'Forbidden: the owner of this service may not deploy it' });
    expect((await lib.getGitPoll(db, 5))?.lastSha).toBeUndefined();
    expect(await lib.pollDueGitServices(db, { ...h.deps, now: T0 + MIN })).toEqual({ due: 1, queued: 1, unchanged: 0, failed: 0 });
    expect(h.push).toHaveBeenCalledTimes(2);
    expect(await lib.getGitPoll(db, 5)).toMatchObject({ lastSha: NEXT, lastError: null });
  });

  it('marks a poll as run before it starts, so a slow one is not started twice', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const headFn = vi.fn(async () => {
      release();
      return NEXT;
    });
    const push = vi.fn(async () => ({ ok: true }));
    const first = lib.pollDueGitServices(db, { now: T0, head: headFn, push: push as never });
    await started;
    // The first poll has not returned; a tick at the same moment finds nothing due.
    expect(await lib.pollDueGitServices(db, { now: T0, head: headFn, push: push as never })).toEqual(NOTHING);
    expect(await first).toEqual({ due: 1, queued: 1, unchanged: 0, failed: 0 });
    expect(headFn).toHaveBeenCalledTimes(1);
  });

  it('goes on past one service whose head cannot be read', async () => {
    await lib.setGitPoll(db, 5, { intervalSeconds: 60 });
    const h = harness(NEXT);
    h.headFn.mockRejectedValueOnce(new Error('ssh: connect to host github.com port 22: timed out'));
    expect(await lib.pollDueGitServices(db, h.deps)).toEqual({ due: 1, queued: 0, unchanged: 0, failed: 1 });
    expect(h.push).not.toHaveBeenCalled();
  });

  it('turns polling off for a service that has no repository to poll, and leaves alone one that is gone and a row it cannot read', async () => {
    const { setSettingJson } = await import('../../src/lib/settings.js');
    await lib.setGitPoll(db, 6, { intervalSeconds: 60 });
    await setSettingJson(db, 'git_poll:5', { intervalSeconds: 'often' });
    await setSettingJson(db, 'git_poll:99', { intervalSeconds: 60 });
    await setSettingJson(db, 'git_poll:not-an-id', { intervalSeconds: 60 });
    const h = harness(NEXT);
    expect(await lib.pollDueGitServices(db, h.deps)).toEqual(NOTHING);
    expect(h.headFn).not.toHaveBeenCalled();
    // Not due on every tick after that either: its row is gone.
    expect(await lib.getGitPoll(db, 6)).toBeNull();
    // A row whose service is gone is the orphan sweep's to remove (plugins/housekeeping.ts), and a row this panel cannot read is left as it is.
    const { settingRowsWithPrefix } = await import('../../src/lib/settingRows.js');
    expect((await settingRowsWithPrefix(db, 'git_poll:')).map((row) => row.key).sort()).toEqual(['git_poll:5', 'git_poll:99', 'git_poll:not-an-id']);
  });
});

describe('routes', () => {
  it('reads the setting and what the last poll found, turns polling on and off, and audits the change', async () => {
    const app = await buildTestApp({ db });
    await app.register(gitPollRoutes, { prefix: '/services' });
    const read = await app.inject({ method: 'GET', url: '/services/5/git-poll', headers: asUser(1) });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual({ supported: true, poll: null, lastSha: null, lastPolledAt: null, lastError: null, lastDeploymentId: null });

    const set = await app.inject({ method: 'PUT', url: '/services/5/git-poll', headers: asUser(1), payload: { poll: { intervalSeconds: 120 } } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ supported: true, poll: { intervalSeconds: 120 } });
    expect(audit).toHaveBeenLastCalledWith(db, 1, 'service.git_poll.set', 'web #5', { serviceId: 5, intervalSeconds: 120 });

    const off = await app.inject({ method: 'PUT', url: '/services/5/git-poll', headers: asUser(1), payload: { poll: null } });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ poll: null, supported: true });
    expect(audit).toHaveBeenLastCalledWith(db, 1, 'service.git_poll.set', 'web #5', { serviceId: 5, intervalSeconds: null });
    expect(await lib.getGitPoll(db, 5)).toBeNull();
  });

  it('refuses an interval shorter than a minute, a longer one than a day, and a key it does not know', async () => {
    const app = await buildTestApp({ db });
    await app.register(gitPollRoutes, { prefix: '/services' });
    for (const poll of [{ intervalSeconds: 59 }, { intervalSeconds: 86_401 }, { intervalSeconds: 90.5 }, { intervalSeconds: 60, branch: 'x' }]) {
      const res = await app.inject({ method: 'PUT', url: '/services/5/git-poll', headers: asUser(1), payload: { poll } });
      expect(res.statusCode, JSON.stringify(poll)).toBe(400);
    }
    expect((await app.inject({ method: 'PUT', url: '/services/5/git-poll', headers: asUser(1), payload: { poll: { intervalSeconds: 86_400 } } })).statusCode).toBe(200);
    expect(await lib.getGitPoll(db, 5)).toEqual({ intervalSeconds: 86_400 });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('refuses polling for a service that deploys an image; turning it off stays allowed', async () => {
    const app = await buildTestApp({ db });
    await app.register(gitPollRoutes, { prefix: '/services' });
    expect((await app.inject({ method: 'GET', url: '/services/6/git-poll', headers: asUser(1) })).json().supported).toBe(false);
    const on = await app.inject({ method: 'PUT', url: '/services/6/git-poll', headers: asUser(1), payload: { poll: { intervalSeconds: 120 } } });
    expect(on.statusCode).toBe(422);
    expect(on.json().error.code).toBe('git_poll_unsupported');
    expect(await lib.getGitPoll(db, 6)).toBeNull();
    expect(audit).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'PUT', url: '/services/6/git-poll', headers: asUser(1), payload: { poll: null } })).statusCode).toBe(200);
  });
});
