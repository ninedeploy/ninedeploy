/**
 * Commit statuses on GitLab, Gitea and Bitbucket (lib/gitCommitStatus.ts,
 * modules/commitStatus.ts): the request each provider gets, which deploys
 * report, where the token may go, and that a failure stays observational.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployments, services, sources, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const lib = await import('../../src/lib/gitCommitStatus.js');
const { commitStatusRoutes } = await import('../../src/modules/commitStatus.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

const SHA = 'a'.repeat(40);
const TOKEN = 'glpat-secret-token-value';
let db: DB;
const sent: Array<{ url: string; init: RequestInit }> = [];
const log = { warn: vi.fn() };

beforeEach(async () => {
  sent.length = 0;
  log.warn.mockReset();
  lib.commitStatusDeps.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url, init: init! });
    return new Response('{}', { status: 201 });
  }) as never;
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(sources).values([
    { id: 1, type: 'gitlab', name: 'gl', tokenEncrypted: encrypt(TOKEN) },
    { id: 2, type: 'gitea', name: 'gt', tokenEncrypted: encrypt('gitea-token'), baseUrl: 'https://git.example.com' },
    { id: 3, type: 'bitbucket', name: 'bb', tokenEncrypted: encrypt('bb-token') },
    { id: 4, type: 'github', name: 'gh', tokenEncrypted: encrypt('ghp') },
  ] as never);
  await db.insert(services).values([
    { id: 5, name: 'API', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, sourceId: 1, repoUrl: 'https://gitlab.com/acme/platform/api.git' },
    { id: 6, name: 'Site', slug: 'site', type: 'docker', branch: 'main', ownerUserId: 1, sourceId: 2, repoUrl: 'https://git.example.com/acme/site' },
    { id: 7, name: 'Shop', slug: 'shop', type: 'docker', branch: 'main', ownerUserId: 1, sourceId: 3, repoUrl: 'https://bitbucket.org/acme/shop.git' },
    { id: 8, name: 'API pr-3', slug: 'api-pr-3', type: 'docker', branch: 'feature', ownerUserId: 1, sourceId: 1, repoUrl: 'https://gitlab.com/acme/platform/api.git', previewParentServiceId: 5 },
    { id: 9, name: 'Fork pr-4', slug: 'api-pr-4', type: 'docker', branch: 'fork', ownerUserId: 1, sourceId: 1, repoUrl: 'https://gitlab.com/someone/api.git', previewParentServiceId: 5, previewFromFork: true },
    { id: 10, name: 'Gh', slug: 'gh', type: 'docker', branch: 'main', ownerUserId: 1, sourceId: 4, repoUrl: 'https://github.com/acme/gh' },
  ] as never);
  for (const id of [5, 6, 7, 10]) await lib.setCommitStatusSetting(db, id, { enabled: true });
});
afterEach(() => closeMigratedDb(db));

async function deployment(serviceId: number, commitSha: string | null = SHA): Promise<number> {
  const [row] = await db.insert(deployments).values({ serviceId, status: 'running', commitSha, trigger: 'manual' } as never).returning();
  return row!.id;
}
const headers = (i: number) => sent[i]!.init.headers as Record<string, string>;
const body = (i: number) => JSON.parse(String(sent[i]!.init.body)) as Record<string, unknown>;

describe('the request per provider', () => {
  it('GitLab: the encoded project path, PRIVATE-TOKEN, running then success', async () => {
    const dep = await deployment(5);
    await lib.deployingCommitStatus(db, log, 5, dep);
    await lib.outcomeCommitStatus(db, log, dep, 'success');
    expect(sent.map((s) => s.url)).toEqual([
      `https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fapi/statuses/${SHA}`,
      `https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fapi/statuses/${SHA}`,
    ]);
    expect(headers(0)['private-token']).toBe(TOKEN);
    expect(body(0)).toEqual({ state: 'running', name: 'ninedeploy/api', description: 'Deploying API' });
    expect(body(1)).toMatchObject({ state: 'success', description: 'Deployed API' });
  });

  it('Gitea: owner/name on the source host with a token header; Bitbucket Cloud with a Bearer token and a url', async () => {
    await lib.outcomeCommitStatus(db, log, await deployment(6), 'failed');
    await lib.outcomeCommitStatus(db, log, await deployment(7), 'cancelled');
    expect(sent[0]!.url).toBe(`https://git.example.com/api/v1/repos/acme/site/statuses/${SHA}`);
    expect(headers(0).authorization).toBe('token gitea-token');
    expect(body(0)).toMatchObject({ state: 'failure', context: 'ninedeploy/site' });
    expect(sent[1]!.url).toBe(`https://api.bitbucket.org/2.0/repositories/acme/shop/commit/${SHA}/statuses/build`);
    expect(headers(1).authorization).toBe('Bearer bb-token');
    expect(body(1)).toMatchObject({ state: 'STOPPED', key: 'ninedeploy/shop', url: 'https://bitbucket.org/acme/shop' });
  });

  it('a preview reports through its parent with the preview context; a fork preview never reports', async () => {
    await lib.outcomeCommitStatus(db, log, await deployment(8), 'success');
    expect(body(0)).toMatchObject({ name: 'ninedeploy/api/preview', description: 'Deployed API pr-3' });
    sent.length = 0;
    await lib.outcomeCommitStatus(db, log, await deployment(9), 'success');
    expect(sent).toEqual([]);
  });
});

describe('what does not report', () => {
  it('off, a GitHub PAT source, an unknown commit, a status that is not an outcome', async () => {
    await lib.setCommitStatusSetting(db, 5, { enabled: false });
    await lib.outcomeCommitStatus(db, log, await deployment(5), 'success');
    await lib.outcomeCommitStatus(db, log, await deployment(10), 'success');
    await lib.outcomeCommitStatus(db, log, await deployment(6, 'abc123'), 'success');
    await lib.outcomeCommitStatus(db, log, await deployment(6), 'building');
    expect(sent).toEqual([]);
  });

  it('never sends a self-hosted source token to another host, nor Bitbucket statuses off bitbucket.org', async () => {
    await db.update(services).set({ repoUrl: 'https://evil.example.net/acme/site' }).where(eq(services.id, 6));
    await db.update(services).set({ repoUrl: 'https://bitbucket.example.com/acme/shop' }).where(eq(services.id, 7));
    await lib.outcomeCommitStatus(db, log, await deployment(6), 'success');
    await lib.outcomeCommitStatus(db, log, await deployment(7), 'success');
    expect(sent).toEqual([]);
  });

  it('a refused or failing request is logged without the token and never throws', async () => {
    lib.commitStatusDeps.fetch = vi.fn(async () => {
      throw new Error(`connect failed with ${TOKEN}`);
    }) as never;
    await expect(lib.outcomeCommitStatus(db, log, await deployment(5), 'success')).resolves.toBeUndefined();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(TOKEN);
    lib.commitStatusDeps.fetch = vi.fn(async () => new Response('no', { status: 403 })) as never;
    await lib.outcomeCommitStatus(db, log, await deployment(5), 'success');
    expect(JSON.stringify(log.warn.mock.calls.at(-1))).toContain('gitlab answered 403');
  });
});

describe('parseRepoUrl', () => {
  it('reads https URLs and refuses others and traversal', () => {
    expect(lib.parseRepoUrl('https://gitlab.com/a/b/c.git')).toEqual({ origin: 'https://gitlab.com', host: 'gitlab.com', path: 'a/b/c' });
    expect(lib.parseRepoUrl('git@gitlab.com:a/b.git')).toBeNull();
    expect(lib.parseRepoUrl('https://gitlab.com/a/../b')).toBeNull();
    expect(lib.parseRepoUrl('https://gitlab.com/onlyone')).toBeNull();
  });
});

describe('GET|PUT /services/:id/commit-status', () => {
  async function app() {
    const a = await buildTestApp({ db });
    await a.register(commitStatusRoutes, { prefix: '/services' });
    return a;
  }

  it('reads the setting and the provider, turns it on and off, and refuses a service that cannot report', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/services/5/commit-status', headers: asUser(1) })).json()).toEqual({ enabled: true, provider: 'gitlab', unavailable: null });
    const off = await a.inject({ method: 'PUT', url: '/services/5/commit-status', headers: asUser(1), payload: { enabled: false } });
    expect(off.json()).toMatchObject({ enabled: false });
    expect((await lib.getCommitStatusSetting(db, 5)).enabled).toBe(false);
    const gh = await a.inject({ method: 'PUT', url: '/services/10/commit-status', headers: asUser(1), payload: { enabled: true } });
    expect(gh.json().error.code).toBe('commit_status_unavailable');
    const preview = await a.inject({ method: 'GET', url: '/services/8/commit-status', headers: asUser(1) });
    expect(preview.json().unavailable).toMatch(/parent/);
    expect((await a.inject({ method: 'PUT', url: '/services/5/commit-status', headers: asUser(1), payload: { enabled: 'yes' } })).statusCode).toBe(400);
    await a.close();
  });
});
