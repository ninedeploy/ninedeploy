/**
 * 0.13 additions to `modules/sources.ts`: GitHub App sources (repository
 * list, branches and test through the installation) and Gitea (`baseUrl`,
 * live test, repository list, branches). No network: `guardedFetch` is a fake
 * provider router. The pre-0.13 behaviour stays pinned in test/sources.test.ts.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { githubAppInstallations, sources, users, type DB, type GithubApp } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ef'.repeat(32);
  process.env['DOCKER_HOST'] = 'tcp://127.0.0.1:9';
  return { guardedFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>() };
});

vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/egressGuard.js')>();
  return { ...actual, guardedFetch: h.guardedFetch };
});

const { sourcesRoutes } = await import('../../src/modules/sources.js');
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('../helpers.js');
const { fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('../lib/githubAppKit.js');

const key = rsaKeyPair('pkcs1');

let db: DB;
let gh: ReturnType<typeof fakeGithub>;

beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'op@example.test', passwordHash: 'x', isInstanceOperator: true });
  clearGithubAppCaches();
  gh = fakeGithub();
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(gh.handler);
  delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
});

async function server() {
  const app = await buildTestApp({ db });
  await app.register(sourcesRoutes);
  return app;
}

const repo = (id: number, name: string) => ({
  id,
  name,
  full_name: `acme/${name}`,
  clone_url: `https://github.com/acme/${name}.git`,
  default_branch: 'main',
  private: true,
});

describe('github_app sources', () => {
  let ghApp: GithubApp;
  let sourceId: number;
  let instId: number;

  beforeEach(async () => {
    ghApp = await seedApp(db, key.privateKey);
    const seeded = await seedInstallation(db, ghApp);
    sourceId = seeded.sourceId;
    instId = seeded.inst.id;
  });

  it('lists the installation repositories with repoId, following Link pages', async () => {
    gh.on('GET', /^\/installation\/repositories$/, (call) => {
      const page = new URL(call.url).searchParams.get('page');
      return page === '2'
        ? json(200, { repositories: [repo(3, 'c')] })
        : json(200, { repositories: [repo(1, 'a'), repo(2, 'b')] }, { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' });
    });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${sourceId}/repos`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-nd-source-error']).toBeUndefined();
    expect(res.json()).toEqual([
      { name: 'a', fullName: 'acme/a', url: 'https://github.com/acme/a.git', defaultBranch: 'main', isPrivate: true, repoId: 1 },
      { name: 'b', fullName: 'acme/b', url: 'https://github.com/acme/b.git', defaultBranch: 'main', isPrivate: true, repoId: 2 },
      { name: 'c', fullName: 'acme/c', url: 'https://github.com/acme/c.git', defaultBranch: 'main', isPrivate: true, repoId: 3 },
    ]);
    // A metadata-only installation token, not scoped to one repository.
    const mint = gh.calls.find((c) => c.path.endsWith('/access_tokens'))!;
    expect(mint.body).toEqual({ permissions: { metadata: 'read' } });
    const lists = gh.calls.filter((c) => c.path === '/installation/repositories');
    expect(lists.map((c) => c.url)).toEqual([
      'https://api.github.com/installation/repositories?per_page=100',
      'https://api.github.com/installation/repositories?per_page=100&page=2',
    ]);
    expect(lists[0]!.headers.get('authorization')).toBe(`Bearer ${gh.minted[0]}`);
  });

  it('explains an unusable installation in x-nd-source-error instead of listing', async () => {
    await db.update(githubAppInstallations).set({ suspendedAt: new Date() }).where(eq(githubAppInstallations.id, instId));
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${sourceId}/repos`, headers: asUser() });
    expect(res.json()).toEqual([]);
    expect(res.headers['x-nd-source-error']).toMatch(/suspended/);
    expect(gh.calls).toHaveLength(0);
  });

  it('keeps the partial list and says why when a later page fails, never echoing the token', async () => {
    gh.on('GET', /^\/installation\/repositories$/, (call) =>
      new URL(call.url).searchParams.get('page') === '2'
        ? json(502, {})
        : json(200, { repositories: [repo(1, 'a')] }, { link: '<x?page=2>; rel="next"' }),
    );
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${sourceId}/repos`, headers: asUser() });
    expect(res.json()).toHaveLength(1);
    expect(res.headers['x-nd-source-error']).toBe('GitHub App API 502 on page 2; showing the first 1 repositories');
    expect(res.body + JSON.stringify(res.headers)).not.toContain('SECRETTOKEN');
  });

  it('lists branches by full name or clone URL and refuses another host', async () => {
    gh.on('GET', /^\/repos\/acme\/a\/branches$/, () => json(200, [{ name: 'main' }, { name: 'dev' }]));
    const app = await server();
    const byName = await app.inject({ method: 'GET', url: `/${sourceId}/branches?repo=acme/a`, headers: asUser() });
    expect(byName.json()).toEqual(['main', 'dev']);
    const byUrl = await app.inject({
      method: 'GET',
      url: `/${sourceId}/branches?repo=${encodeURIComponent('https://github.com/acme/a.git')}`,
      headers: asUser(),
    });
    expect(byUrl.json()).toEqual(['main', 'dev']);
    expect(gh.calls.find((c) => c.path.endsWith('/access_tokens'))!.body).toEqual({ permissions: { contents: 'read' } });

    const foreign = await app.inject({
      method: 'GET',
      url: `/${sourceId}/branches?repo=${encodeURIComponent('https://evil.example/acme/a.git')}`,
      headers: asUser(),
    });
    expect(foreign.json()).toEqual(['main', 'master']);
    expect(foreign.headers['x-nd-source-error']).toMatch(/Refusing to send a GitHub App token to evil\.example/);

    const missing = await app.inject({ method: 'GET', url: `/${sourceId}/branches?repo=acme/gone`, headers: asUser() });
    expect(missing.json()).toEqual(['main', 'master']);
    expect(missing.headers['x-nd-source-error']).toBe('GitHub App API 404 on acme/gone');
  });

  it('tests the App key and reports the installation', async () => {
    gh.on('GET', /^\/app$/, () => json(200, { id: 4242 }));
    gh.on('GET', /^\/app\/installations\/9001$/, () =>
      json(200, { account: { login: 'acme' }, repository_selection: 'all', permissions: { contents: 'read' }, suspended_at: null }),
    );
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${sourceId}/test`, headers: asUser() });
    expect(res.json()).toEqual({
      ok: true,
      provider: 'github_app',
      login: 'acme',
      repositorySelection: 'all',
      permissions: { contents: 'read' },
      suspended: false,
    });

    gh.on('GET', /^\/app\/installations\/9001$/, () => json(200, { account: { login: 'acme' }, suspended_at: '2026-10-01T00:00:00Z' }));
    const suspended = await app.inject({ method: 'GET', url: `/${sourceId}/test`, headers: asUser() });
    expect(suspended.json()).toMatchObject({ ok: false, provider: 'github_app', suspended: true });

    gh.on('GET', /^\/app$/, () => json(401, { message: 'Bad credentials' }));
    const refused = await app.inject({ method: 'GET', url: `/${sourceId}/test`, headers: asUser() });
    expect(refused.json()).toMatchObject({ ok: false, provider: 'github_app', status: 401 });
  });

  it('a github_app source with no installation (App deleted) fails closed with a message', async () => {
    const [orphan] = await db.insert(sources).values({ type: 'github_app', name: 'gh-app:gone' }).returning();
    const app = await server();
    const repos = await app.inject({ method: 'GET', url: `/${orphan!.id}/repos`, headers: asUser() });
    expect(repos.json()).toEqual([]);
    expect(repos.headers['x-nd-source-error']).toMatch(/no installation/);
    const test = await app.inject({ method: 'GET', url: `/${orphan!.id}/test`, headers: asUser() });
    expect(test.json()).toMatchObject({ ok: false, provider: 'github_app' });
  });
});

describe('gitea sources', () => {
  async function giteaSource(baseUrl: string | null) {
    const [row] = await db
      .insert(sources)
      .values({ type: 'gitea', name: 'gitea', tokenEncrypted: encrypt('GITEA_TOKEN_VALUE'), baseUrl })
      .returning();
    return row!;
  }

  it('creates and patches baseUrl, refusing http without private egress and non-gitea types', async () => {
    const app = await server();
    const ok = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: { name: 'g', type: 'gitea', token: 't', baseUrl: 'https://git.example.com/' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ type: 'gitea', baseUrl: 'https://git.example.com', hasToken: true });

    const http = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: { name: 'g', type: 'gitea', baseUrl: 'http://git.lan' } });
    expect(http.statusCode).toBe(400);
    expect(http.json().error.code).toBe('insecure_base_url');

    const github = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: { name: 'g', type: 'github', baseUrl: 'https://x.example' } });
    expect(github.statusCode).toBe(400);
    expect(github.json().error.code).toBe('base_url_unsupported');

    const id = ok.json().id as number;
    const patchHttp = await app.inject({ method: 'PATCH', url: `/${id}`, headers: asUser(), payload: { baseUrl: 'http://git.lan' } });
    expect(patchHttp.statusCode).toBe(400);
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
    const patched = await app.inject({ method: 'PATCH', url: `/${id}`, headers: asUser(), payload: { baseUrl: 'http://git.lan' } });
    expect(patched.json().baseUrl).toBe('http://git.lan');
    const cleared = await app.inject({ method: 'PATCH', url: `/${id}`, headers: asUser(), payload: { baseUrl: null } });
    expect(cleared.json().baseUrl).toBeNull();

    const list = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(list.body).not.toContain('GITEA_TOKEN_VALUE');
  });

  it('keeps the old { ok:false, error } shape when the base URL is not set', async () => {
    const src = await giteaSource(null);
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${src.id}/test`, headers: asUser() });
    expect(res.json()).toEqual({ ok: false, error: 'Set the Gitea base URL to enable the live test' });
    const repos = await app.inject({ method: 'GET', url: `/${src.id}/repos`, headers: asUser() });
    expect(repos.json()).toEqual([]);
    expect(repos.headers['x-nd-source-error']).toMatch(/base URL/);
    expect(gh.calls).toHaveLength(0);
  });

  it('tests the token against <base>/api/v1/user', async () => {
    gh.on('GET', /^\/api\/v1\/user$/, () => json(200, { login: 'ersin', full_name: 'Ersin' }));
    const src = await giteaSource('https://git.example.com');
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${src.id}/test`, headers: asUser() });
    expect(res.json()).toEqual({ ok: true, provider: 'gitea', login: 'ersin', name: 'Ersin' });
    expect(gh.calls[0]!.url).toBe('https://git.example.com/api/v1/user');
    expect(gh.calls[0]!.headers.get('authorization')).toBe('token GITEA_TOKEN_VALUE');

    gh.on('GET', /^\/api\/v1\/user$/, () => json(401, { message: 'token GITEA_TOKEN_VALUE is invalid' }));
    const bad = await app.inject({ method: 'GET', url: `/${src.id}/test`, headers: asUser() });
    expect(bad.json()).toMatchObject({ ok: false, provider: 'gitea', status: 401 });
    expect(bad.body).not.toContain('GITEA_TOKEN_VALUE');
  });

  it('refuses a stored http base at use time once private egress is off', async () => {
    const src = await giteaSource('http://git.lan');
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${src.id}/test`, headers: asUser() });
    expect(res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/must use https/) });
    expect(gh.calls).toHaveLength(0);
  });

  it('lists repositories through Link pages and branches by name or clone URL', async () => {
    gh.on('GET', /^\/api\/v1\/user\/repos$/, (call) =>
      new URL(call.url).searchParams.get('page') === '2'
        ? json(200, [{ name: 'b', full_name: 'me/b', clone_url: 'https://git.example.com/me/b.git', default_branch: '', private: false }])
        : json(200, [{ name: 'a', full_name: 'me/a', clone_url: 'https://git.example.com/me/a.git', default_branch: 'trunk', private: true }], {
            link: '<https://git.example.com/api/v1/user/repos?limit=50&page=2>; rel="next"',
          }),
    );
    gh.on('GET', /^\/api\/v1\/repos\/me\/a\/branches$/, () => json(200, [{ name: 'trunk' }]));
    const src = await giteaSource('https://git.example.com');
    const app = await server();
    const repos = await app.inject({ method: 'GET', url: `/${src.id}/repos`, headers: asUser() });
    expect(repos.json()).toEqual([
      { name: 'a', fullName: 'me/a', url: 'https://git.example.com/me/a.git', defaultBranch: 'trunk', isPrivate: true },
      { name: 'b', fullName: 'me/b', url: 'https://git.example.com/me/b.git', defaultBranch: 'main', isPrivate: false },
    ]);
    expect(gh.calls.map((c) => c.url)).toEqual([
      'https://git.example.com/api/v1/user/repos?limit=50',
      'https://git.example.com/api/v1/user/repos?limit=50&page=2',
    ]);

    const byName = await app.inject({ method: 'GET', url: `/${src.id}/branches?repo=me/a`, headers: asUser() });
    expect(byName.json()).toEqual(['trunk']);
    const byUrl = await app.inject({
      method: 'GET',
      url: `/${src.id}/branches?repo=${encodeURIComponent('https://git.example.com/me/a.git')}`,
      headers: asUser(),
    });
    expect(byUrl.json()).toEqual(['trunk']);
    expect(gh.calls.at(-1)!.url).toBe('https://git.example.com/api/v1/repos/me/a/branches?limit=50');

    const traversal = await app.inject({ method: 'GET', url: `/${src.id}/branches?repo=${encodeURIComponent('../../admin')}`, headers: asUser() });
    expect(traversal.json()).toEqual(['main', 'master']);
    expect(traversal.headers['x-nd-source-error']).toMatch(/expected owner\/repo/);
  });
});

// G1.2: a GitLab source on a self-hosted base URL; without one it still means gitlab.com.
describe('gitlab sources', () => {
  async function gitlabSource(baseUrl: string | null) {
    const [row] = await db
      .insert(sources)
      .values({ type: 'gitlab', name: 'gitlab', tokenEncrypted: encrypt('GITLAB_TOKEN_VALUE'), baseUrl })
      .returning();
    return row!;
  }

  it('accepts a base URL on create and patch, with the same https rule as Gitea', async () => {
    const app = await server();
    const ok = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: { name: 'gl', type: 'gitlab', token: 't', baseUrl: 'https://gitlab.example.com/' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ type: 'gitlab', baseUrl: 'https://gitlab.example.com' });
    const http = await app.inject({ method: 'PATCH', url: `/${ok.json().id}`, headers: asUser(), payload: { baseUrl: 'http://gitlab.lan' } });
    expect(http.statusCode).toBe(400);
    expect(http.json().error.code).toBe('insecure_base_url');
  });

  it('lists projects, branches and tests the token against the self-hosted instance', async () => {
    gh.on('GET', /^\/gitlab\/api\/v4\/projects$/, () =>
      json(200, [
        { name: 'api', path_with_namespace: 'team/backend/api', http_url_to_repo: 'https://gitlab.example.com/gitlab/team/backend/api.git', default_branch: 'develop', visibility: 'private' },
      ]),
    );
    gh.on('GET', /^\/gitlab\/api\/v4\/projects\/team%2Fbackend%2Fapi\/repository\/branches$/, () => json(200, [{ name: 'develop' }, { name: 'main' }]));
    gh.on('GET', /^\/gitlab\/api\/v4\/user$/, () => json(200, { username: 'ersin', name: 'Ersin' }));
    const src = await gitlabSource('https://gitlab.example.com/gitlab/');
    const app = await server();

    const repos = await app.inject({ method: 'GET', url: `/${src.id}/repos`, headers: asUser() });
    expect(repos.headers['x-nd-source-error']).toBeUndefined();
    expect(repos.json()).toEqual([
      { name: 'api', fullName: 'team/backend/api', url: 'https://gitlab.example.com/gitlab/team/backend/api.git', defaultBranch: 'develop', isPrivate: true },
    ]);
    expect(gh.calls[0]!.url).toBe('https://gitlab.example.com/gitlab/api/v4/projects?membership=true&per_page=100&order_by=updated_at');
    expect(gh.calls[0]!.headers.get('private-token')).toBe('GITLAB_TOKEN_VALUE');

    const byPath = await app.inject({ method: 'GET', url: `/${src.id}/branches?repo=team/backend/api`, headers: asUser() });
    expect(byPath.json()).toEqual(['develop', 'main']);
    const byUrl = await app.inject({
      method: 'GET',
      url: `/${src.id}/branches?repo=${encodeURIComponent('https://gitlab.example.com/gitlab/team/backend/api.git')}`,
      headers: asUser(),
    });
    expect(byUrl.json()).toEqual(['develop', 'main']);
    expect(gh.calls.at(-1)!.url).toBe('https://gitlab.example.com/gitlab/api/v4/projects/team%2Fbackend%2Fapi/repository/branches?per_page=100');

    const traversal = await app.inject({ method: 'GET', url: `/${src.id}/branches?repo=${encodeURIComponent('team/../admin')}`, headers: asUser() });
    expect(traversal.json()).toEqual(['main', 'master']);
    expect(traversal.headers['x-nd-source-error']).toMatch(/expected group\/project/);

    const test = await app.inject({ method: 'GET', url: `/${src.id}/test`, headers: asUser() });
    expect(test.json()).toEqual({ ok: true, provider: 'gitlab', login: 'ersin', name: 'Ersin' });
    expect(gh.calls.at(-1)!.url).toBe('https://gitlab.example.com/gitlab/api/v4/user');
  });

  it('keeps gitlab.com without a base URL, and refuses a stored http base once private egress is off', async () => {
    gh.on('GET', /^\/api\/v4\/projects\/acme%2Fapp\/repository\/branches$/, () => json(200, [{ name: 'trunk' }]));
    const cloud = await gitlabSource(null);
    const app = await server();
    const branches = await app.inject({ method: 'GET', url: `/${cloud.id}/branches?repo=acme/app`, headers: asUser() });
    expect(branches.json()).toEqual(['trunk']);
    expect(gh.calls.at(-1)!.url).toBe('https://gitlab.com/api/v4/projects/acme%2Fapp/repository/branches?per_page=100');

    const lan = await gitlabSource('http://gitlab.lan');
    const calls = gh.calls.length;
    const res = await app.inject({ method: 'GET', url: `/${lan.id}/test`, headers: asUser() });
    expect(res.json()).toMatchObject({ ok: false, provider: 'gitlab', error: expect.stringMatching(/must use https/) });
    const repos = await app.inject({ method: 'GET', url: `/${lan.id}/repos`, headers: asUser() });
    expect(repos.json()).toEqual([]);
    expect(repos.headers['x-nd-source-error']).toMatch(/must use https/);
    const br = await app.inject({ method: 'GET', url: `/${lan.id}/branches?repo=acme/app`, headers: asUser() });
    expect(br.json()).toEqual(['main', 'master']);
    expect(gh.calls).toHaveLength(calls);
  });

  it('reports a GitLab API failure without echoing the token', async () => {
    gh.on('GET', /^\/api\/v4\/projects\/acme%2Fapp\/repository\/branches$/, () => json(404, { message: 'not found' }));
    const src = await gitlabSource(null);
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/${src.id}/branches?repo=acme/app`, headers: asUser() });
    expect(res.json()).toEqual(['main', 'master']);
    expect(res.headers['x-nd-source-error']).toBe('GitLab API 404 on acme/app');
    expect(res.body).not.toContain('GITLAB_TOKEN_VALUE');

    h.guardedFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED (token GITLAB_TOKEN_VALUE)'));
    const down = await app.inject({ method: 'GET', url: `/${src.id}/branches?repo=acme/app`, headers: asUser() });
    expect(down.json()).toEqual(['main', 'master']);
    expect(down.headers['x-nd-source-error']).toMatch(/^GitLab API unreachable: /);
    expect(down.headers['x-nd-source-error']).not.toContain('GITLAB_TOKEN_VALUE');
  });
});
