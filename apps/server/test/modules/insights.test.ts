import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSPECTION_LIMITS, insightsRoutes, serviceInsightsRoutes } from '../../src/modules/insights.js';
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

const memberSeat = { workspaceId: 1, userId: 7, role: 'member' };

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

// r711: creating a service needs a `member` seat somewhere; the analysis
// clone was open to any signed-in account, seatless or viewer-only.
describe('analysis seat floor (r711)', () => {
  async function analyzeAs(seats: Array<{ workspaceId: number; userId: number; role: string }>) {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: baseService }, findMany: { workspaceMembers: seats } }),
    });
    await app.register(insightsRoutes);
    const res = await app.inject({
      method: 'POST', url: '/', headers: asUser({ id: 7, isOperator: false }),
      payload: { repoUrl: 'https://github.com/octocat/Hello-World.git', branch: 'main' },
    });
    await app.close();
    return res;
  }

  it('refuses an account with no seat and never clones', async () => {
    const res = await analyzeAs([]);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/\\"member\\" role/);
    expect(gitMocks.checkoutCommit).not.toHaveBeenCalled();
  });

  it('refuses a viewer-only account', async () => {
    expect((await analyzeAs([{ workspaceId: 1, userId: 7, role: 'viewer' }])).statusCode).toBe(403);
    expect(gitMocks.checkoutCommit).not.toHaveBeenCalled();
  });

  it('allows a member seat in any workspace', async () => {
    expect((await analyzeAs([memberSeat])).statusCode).toBe(200);
    expect(gitMocks.checkoutCommit).toHaveBeenCalledTimes(1);
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

// r657: the analysis clone ran on the request path for any signed-in user as a
// full clone (all branches, history, submodules) with no time or size bound.
describe('inspection clone limits (r657)', () => {
  const saved = { ...INSPECTION_LIMITS };
  afterAll(() => Object.assign(INSPECTION_LIMITS, saved));

  async function analyze() {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: baseService }, findMany: { workspaceMembers: [memberSeat] } }),
    });
    await app.register(insightsRoutes);
    const res = await app.inject({
      method: 'POST', url: '/', headers: asUser({ id: 7, isOperator: false }),
      payload: { repoUrl: 'https://example.com/big.git', branch: 'main' },
    });
    await app.close();
    return res;
  }

  it('asks git for a shallow, abortable checkout on both routes', async () => {
    expect((await analyze()).statusCode).toBe(200);
    const limits = gitMocks.checkoutCommit.mock.calls[0]![6] as { shallow: boolean; signal: AbortSignal };
    expect(limits.shallow).toBe(true);
    expect(limits.signal).toBeInstanceOf(AbortSignal);

    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: baseService } }) });
    await app.register(serviceInsightsRoutes);
    await app.inject({ method: 'POST', url: '/1/insights/refresh', headers: asUser() });
    await app.close();
    expect((gitMocks.checkoutCommit.mock.calls[1]![6] as { shallow: boolean }).shallow).toBe(true);
  });

  it('aborts a clone that outgrows the size cap and says what to do instead', async () => {
    Object.assign(INSPECTION_LIMITS, { maxBytes: 1024, pollMs: 10, timeoutMs: 10_000 });
    gitMocks.checkoutCommit.mockImplementationOnce((async (...args: unknown[]) => {
      const dir = args[3] as string;
      const signal = (args[6] as { signal: AbortSignal }).signal;
      const { mkdirSync, writeFileSync: write } = await import('node:fs');
      mkdirSync(dir, { recursive: true });
      write(path.join(dir, 'blob.bin'), Buffer.alloc(4096));
      // Behaves like git under simple-git's abort plugin.
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return 'never';
    }) as never);
    const res = await analyze();
    Object.assign(INSPECTION_LIMITS, saved);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('inspection_limit');
    expect(res.json().error.message).toMatch(/larger than/);
    expect(frameworkMocks.analyzeRepo).not.toHaveBeenCalled();
  });

  it('aborts a clone that runs past the time limit', async () => {
    Object.assign(INSPECTION_LIMITS, { timeoutMs: 20, pollMs: 1_000 });
    gitMocks.checkoutCommit.mockImplementationOnce((async (...args: unknown[]) => {
      const signal = (args[6] as { signal: AbortSignal }).signal;
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return 'never';
    }) as never);
    const res = await analyze();
    Object.assign(INSPECTION_LIMITS, saved);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/stopped after/);
  });
});
