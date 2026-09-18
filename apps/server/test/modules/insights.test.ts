import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { insightsRoutes, serviceInsightsRoutes } from '../../src/modules/insights.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

const frameworkMocks = vi.hoisted(() => ({
  analyzeRepo: vi.fn(() => ({
    framework: { id: 'node', name: 'Node.js' },
    packageManager: 'pnpm',
    commitSha: 'abc123',
  })),
}));
vi.mock('../../src/lib/frameworks.js', () => frameworkMocks);

const gitMocks = vi.hoisted(() => ({
  checkoutCommit: vi.fn(async () => 'sha-from-mock'),
}));
vi.mock('../../src/lib/git.js', () => gitMocks);

const cryptoMocks = vi.hoisted(() => ({
  decrypt: vi.fn((v: string) => (v.startsWith('v0:') ? v.slice(3) : `dec:${v}`)),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const fakeState: { sourcesById: Record<number, { type: string; tokenEncrypted?: string; deployKeyEncrypted?: string }> } = {
  sourcesById: {},
};

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'nd-insights-'));
beforeAll(() => {
  process.env['NINEDEPLOY_DATA_DIR'] = tmpRoot;
  writeFileSync(path.join(tmpRoot, 'data.json'), '{}');
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  fakeState.sourcesById = {};
  gitMocks.checkoutCommit.mockResolvedValue('sha-from-mock');
  frameworkMocks.analyzeRepo.mockReturnValue({
    framework: { id: 'node', name: 'Node.js' },
    packageManager: 'pnpm',
    commitSha: 'abc123',
  });
  cryptoMocks.decrypt.mockImplementation((v: string) => (v.startsWith('v0:') ? v.slice(3) : `dec:${v}`));
});

const baseService = {
  id: 1,
  name: 'svc',
  slug: 'svc',
  image: 'node:20',
  port: 3000,
  volumeMount: null,
  ownerUserId: 1,
  projectId: null,
  repoUrl: 'https://example.com/repo.git',
  branch: 'main',
  sourceId: null,
};

describe('insights routes', () => {
  it('rejects unauthenticated analysis requests (public rate-limited endpoint is still behind login)', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: baseService } }) });
    await app.register(insightsRoutes);
    const res = await app.inject({ method: 'POST', url: '/', payload: { repoUrl: 'https://example.com/x' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('analyzes a repository and cleans up the temp clone dir even when analyze throws', async () => {
    frameworkMocks.analyzeRepo.mockImplementationOnce(() => {
      throw new Error('analyzer down');
    });
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: baseService } }) });
    await app.register(insightsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { repoUrl: 'https://github.com/octocat/Hello-World.git', branch: 'main' },
    });
    expect(res.statusCode).toBe(500);
    expect(gitMocks.checkoutCommit).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('attaches the decrypted source credentials when a sourceId is provided', async () => {
    fakeState.sourcesById[7] = { type: 'github', tokenEncrypted: 'v0:ghs_token' };
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: baseService, sources: fakeState.sourcesById[7] } }),
    });
    await app.register(insightsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { repoUrl: 'https://github.com/private/repo.git', branch: 'main', sourceId: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(cryptoMocks.decrypt).toHaveBeenCalledWith('v0:ghs_token');
    // call args: repoUrl, branch, commitSha, workDir, log, creds
    const call = gitMocks.checkoutCommit.mock.calls[0]!;
    expect(call[5]).toEqual({ type: 'github', token: 'ghs_token', deployKey: undefined });
    await app.close();
  });

  it('attaches the decrypted deploy key when only a deployKey is stored', async () => {
    fakeState.sourcesById[8] = { type: 'gitlab', deployKeyEncrypted: 'v0:private-key' };
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: baseService, sources: fakeState.sourcesById[8] } }),
    });
    await app.register(insightsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { repoUrl: 'ssh://git@example.com/team/repo.git', branch: 'main', sourceId: 8 },
    });
    expect(res.statusCode).toBe(200);
    const call = gitMocks.checkoutCommit.mock.calls[0]!;
    expect(call[5]).toEqual({ type: 'gitlab', token: undefined, deployKey: 'private-key' });
    await app.close();
  });

  it('skips credentials when the sourceId references a row that no longer exists', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: baseService } }) });
    await app.register(insightsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { repoUrl: 'https://example.com/r.git', branch: 'main', sourceId: 999 },
    });
    expect(res.statusCode).toBe(200);
    const call = gitMocks.checkoutCommit.mock.calls[0]!;
    expect(call[5]).toBeUndefined();
    await app.close();
  });

  it('refuses a member-supplied sourceId (operator-managed credentials)', async () => {
    // Sources are system-wide operator credentials (sourcesRoutes is
    // requireAdmin). A member probing /insights with a guessed id must not
    // get operator-held tokens attached to their clone of any repoUrl.
    fakeState.sourcesById[7] = { type: 'github', tokenEncrypted: 'v0:ghs_token' };
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: baseService, sources: fakeState.sourcesById[7] } }),
    });
    await app.register(insightsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { repoUrl: 'https://github.com/private/repo.git', branch: 'main', sourceId: 7 },
    });
    expect(res.statusCode).toBe(403);
    expect(gitMocks.checkoutCommit).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('service insights routes', () => {
  it('returns null when no insights row exists for the service', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: baseService } }) });
    await app.register(serviceInsightsRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/insights', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    await app.close();
  });

  it('returns the stored DTO when an insights row exists', async () => {
    const storedInsights = {
      serviceId: 1,
      frameworkId: 'node',
      data: { framework: { id: 'node' }, commitSha: 'stored' },
      commitSha: 'stored',
    };
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: baseService, repoInsights: storedInsights } }),
    });
    await app.register(serviceInsightsRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/insights', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ framework: { id: 'node' }, commitSha: 'stored' });
    await app.close();
  });

  it('refuses refresh for a service with no repoUrl (no clone target)', async () => {
    const noRepoSvc = { ...baseService, repoUrl: null };
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: noRepoSvc } }) });
    await app.register(serviceInsightsRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/insights/refresh', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no repository URL/);
    await app.close();
  });

  it('rejects the refresh when the repo is unreachable AND no cached .git exists', async () => {
    gitMocks.checkoutCommit.mockRejectedValueOnce(new Error('network unreachable'));
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: baseService } }) });
    await app.register(serviceInsightsRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/insights/refresh', headers: asUser() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/not reachable/);
    await app.close();
  });

  it('upserts the freshly computed insights on a successful refresh', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: baseService,
          repoInsights: undefined,
          buildConfigs: { serviceId: 1, baseDir: '/' },
        },
      }),
    });
    await app.register(serviceInsightsRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/insights/refresh', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(frameworkMocks.analyzeRepo).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({ framework: { id: 'node' }, packageManager: 'pnpm' });
    // r224: never the pipeline's canonical checkout (reposDir/<id>) — a
    // refresh mid-deploy would move the tree under the running build.
    const dir = String(vi.mocked(gitMocks.checkoutCommit).mock.calls.at(-1)?.[3]);
    expect(dir).toMatch(/_inspections/);
    expect(dir.split(/[\\/]/).at(-1)).not.toBe('1');
    await app.close();
  });
});
