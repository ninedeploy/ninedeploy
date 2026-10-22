import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployments, serviceGithubLinks, services, type DB } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return { fetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>() };
});
vi.mock('../../src/lib/egressGuard.js', async (original) => ({
  ...await original<typeof import('../../src/lib/egressGuard.js')>(), guardedFetch: h.fetch,
}));
const { holdForCiIfNeeded, pollCiGates, assertCiGateForBuild } = await import('../../src/lib/ciGate.js');
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const { asUser, buildTestApp } = await import('../helpers.js');
const { deploysRoutes } = await import('../../src/modules/deploys.js');
const { closeMigratedDb, fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');
const key = rsaKeyPair();
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const WORKFLOW = '.github/workflows/ci.yml';
let db: DB;
let gh: ReturnType<typeof fakeGithub>;
let now: number;
let runs: Record<string, unknown>[];
let branchSha: string;
const dep = () => db.query.deployments.findFirst({ where: eq(deployments.id, 1) });
const run = (over: Record<string, unknown> = {}) => ({
  id: 10, run_attempt: 1, path: WORKFLOW, head_sha: SHA, status: 'completed', conclusion: 'success', event: 'push', ...over,
});
beforeEach(async () => {
  now = Date.now();
  db = await migratedDb();
  clearGithubAppCaches();
  gh = fakeGithub();
  h.fetch.mockImplementation(gh.handler);
  const app = await seedApp(db, key.privateKey);
  const { inst } = await seedInstallation(db, app);
  await db.insert(services).values({ id: 1, name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/app.git', branch: 'main' });
  await db.insert(serviceGithubLinks).values({ serviceId: 1, installationRowId: inst.id, repoId: 555, repoFullName: 'acme/app', requiredWorkflows: [WORKFLOW] });
  await db.insert(deployments).values({ id: 1, serviceId: 1, status: 'queued', trigger: 'webhook' });
  branchSha = SHA;
  runs = [];
  gh.on('GET', /^\/repos\/acme\/app$/, () => json(200, { id: 555 }));
  gh.on('GET', /^\/repos\/acme\/app\/commits\//, () => json(200, { sha: branchSha }));
  gh.on('GET', /^\/repos\/acme\/app\/actions\/runs$/, () => json(200, { workflow_runs: runs }));
});
afterEach(() => { closeMigratedDb(db); vi.restoreAllMocks(); });

describe('durable required GitHub workflows', () => {
  it('requires target CI for a pinned artifact promotion and preserves its image identity', async () => {
    const artifact = { version: 1 as const, imageId: `sha256:${'c'.repeat(64)}`, repoUrl: 'https://github.com/acme/app.git', commitSha: SHA, originDeploymentId: 99, builtWithNixpacks: true, builtStatic: false };
    await db.update(deployments).set({ commitSha: SHA, artifact, promotionSourceDeploymentId: 99 });
    expect(await holdForCiIfNeeded(db, 1, now)).toBe(true);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'awaiting_ci', commitSha: SHA, artifact });
    runs = [run()];
    await pollCiGates(db, { now: now + 30_000 });
    expect(await dep()).toMatchObject({ status: 'queued', artifact, promotionSourceDeploymentId: 99, ciGate: { state: 'passed', headSha: SHA } });
  });
  it('preserves the legacy queue response and exposes CI only to clients that opt in', async () => {
    await holdForCiIfNeeded(db, 1, now);
    const app = await buildTestApp({ db });
    await app.register(deploysRoutes, { prefix: '/services' });
    try {
      const oldClient = await app.inject({ method: 'GET', url: '/services/queue', headers: asUser() });
      expect(oldClient.json()).toEqual({ items: [], count: 0, byStatus: { queued: 0, building: 0, deploying: 0 } });
      const current = await app.inject({ method: 'GET', url: '/services/queue?includeCi=true', headers: asUser() });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({ items: [{ id: 1, status: 'awaiting_ci' }], count: 1, byStatus: { awaiting_ci: 1 } });
    } finally { await app.close(); }
  });
  it('is opt-in and does no network work in the claim path', async () => {
    await db.update(serviceGithubLinks).set({ requiredWorkflows: [] });
    expect(await holdForCiIfNeeded(db, 1, now)).toBe(false);
    expect(gh.calls).toHaveLength(0);
    expect((await dep())?.status).toBe('queued');
  });

  it('pins the branch once, waits across a new poller, and only admits that SHA', async () => {
    expect(await holdForCiIfNeeded(db, 1, now)).toBe(true);
    expect(gh.calls).toHaveLength(0);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'awaiting_ci', commitSha: SHA });
    branchSha = OTHER_SHA;
    runs = [run()];
    await pollCiGates(db, { now: now + 31_000 });
    expect(await dep()).toMatchObject({ status: 'queued', commitSha: SHA, ciGate: { state: 'passed', headSha: SHA } });
    expect(await holdForCiIfNeeded(db, 1, now + 31_001)).toBe(false);
    const src = await db.query.services.findFirst({ where: eq(services.id, 1) });
    await expect(assertCiGateForBuild(db, (await dep())!, src!)).resolves.toBeUndefined();
    expect(gh.calls.filter((c) => c.path.includes('/commits/'))).toHaveLength(1);
    expect(gh.calls.filter((c) => c.path.endsWith('/actions/runs')).every((c) => new URL(c.url).searchParams.get('head_sha') === SHA)).toBe(true);
    expect(gh.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ repository_ids: [555], permissions: { actions: 'read', contents: 'read' } });
  });

  it.each(['queued', 'in_progress'])('does not treat %s as success or reuse a previous successful run', async (status) => {
    runs = [run(), run({ id: 11, status, conclusion: null })];
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'awaiting_ci', ciGate: { checks: [{ state: 'pending', runId: 11 }] } });
  });

  it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required'])('refuses a completed %s workflow', async (conclusion) => {
    runs = [run({ conclusion })];
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'failed', ciGate: { state: 'failed' } });
  });

  it('does not accept another SHA, another workflow, or pull_request_target runs', async () => {
    runs = [run({ head_sha: OTHER_SHA }), run({ id: 11, path: '.github/workflows/fake.yml' }), run({ id: 12, event: 'pull_request_target' })];
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'awaiting_ci', ciGate: { checks: [{ state: 'missing' }] } });
  });

  it('keeps the captured policy when a link is disabled or the policy changes', async () => {
    await holdForCiIfNeeded(db, 1, now);
    await db.update(serviceGithubLinks).set({ requiredWorkflows: [], enabled: false });
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'awaiting_ci', ciGate: { workflows: [WORKFLOW] } });
  });

  it('fails closed on permission errors and expires missing checks', async () => {
    gh.on('GET', /^\/repos\/acme\/app\/actions\/runs$/, () => json(403, { message: 'private detail ghs_SECRET' }));
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect((await dep())?.status).toBe('awaiting_ci');
    expect(JSON.stringify((await dep())?.ciGate)).not.toContain('ghs_SECRET');
    await pollCiGates(db, { now: now + 2 * 60 * 60_000 + 1 });
    expect(await dep()).toMatchObject({ status: 'failed', ciGate: { state: 'failed', reason: expect.stringContaining('timed out') } });
  });

  it('cannot resurrect a deployment cancelled while GitHub answers', async () => {
    gh.on('GET', /^\/repos\/acme\/app\/actions\/runs$/, async () => {
      await db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 1));
      return json(200, { workflow_runs: [run()] });
    });
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect((await dep())?.status).toBe('cancelled');
  });

  it('does not build another repository after the captured source changes', async () => {
    runs = [run()];
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    await db.update(services).set({ repoUrl: 'https://github.com/acme/other.git' }).where(eq(services.id, 1));
    const src = await db.query.services.findFirst({ where: eq(services.id, 1) });
    await expect(assertCiGateForBuild(db, (await dep())!, src!)).rejects.toThrow(/source changed/i);
  });

  it('clears an early approval when a mutable ref is pinned, but preserves approval of an exact SHA', async () => {
    await db.update(deployments).set({ reviewedAt: new Date(now) });
    await holdForCiIfNeeded(db, 1, now);
    expect((await dep())?.reviewedAt).toBeNull();
    await db.insert(deployments).values({ id: 2, serviceId: 1, commitSha: SHA, reviewedAt: new Date(now) });
    await holdForCiIfNeeded(db, 2, now);
    expect((await db.query.deployments.findFirst({ where: and(eq(deployments.id, 2), eq(deployments.status, 'awaiting_ci')) }))?.reviewedAt).not.toBeNull();
  });

  it('checks every required workflow and the latest attempt, including subsequent pages', async () => {
    const security = '.github/workflows/security.yml';
    await db.update(serviceGithubLinks).set({ requiredWorkflows: [WORKFLOW, security] });
    gh.on('GET', /^\/repos\/acme\/app\/actions\/runs$/, (call) => new URL(call.url).searchParams.get('page') === '1'
      ? json(200, { workflow_runs: [run(), run({ id: 20, path: security })] }, { link: '<https://github.com/unused>; rel="next"' })
      : json(200, { workflow_runs: [run({ id: 20, run_attempt: 2, path: security, status: 'in_progress', conclusion: null })] }));
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'awaiting_ci', ciGate: { checks: [
      { path: WORKFLOW, state: 'success' }, { path: security, state: 'pending', runId: 20, attempt: 2 },
    ] } });
  });

  it('never admits a success from truncated run history', async () => {
    gh.on('GET', /^\/repos\/acme\/app\/actions\/runs$/, () => json(200, { workflow_runs: [run()] }, { link: '<https://github.com/unused>; rel="next"' }));
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect((await dep())?.status).toBe('awaiting_ci');
    expect(gh.calls.filter((call) => call.path.endsWith('/actions/runs'))).toHaveLength(10);
  });

  it('uses a persisted lease so concurrent pollers make only one check', async () => {
    runs = [run()];
    await holdForCiIfNeeded(db, 1, now);
    await Promise.all([pollCiGates(db, { now }), pollCiGates(db, { now })]);
    expect((await dep())?.status).toBe('queued');
    expect(gh.calls.filter((call) => call.path.endsWith('/actions/runs'))).toHaveLength(1);
  });

  it('rechecks a receipt that aged while awaiting human approval', async () => {
    runs = [run()];
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    await db.update(deployments).set({ reviewedAt: new Date(now) });
    expect(await holdForCiIfNeeded(db, 1, now + 61_000)).toBe(true);
    runs = [run({ run_attempt: 2, conclusion: 'failure' })];
    await pollCiGates(db, { now: now + 61_000 });
    expect(await dep()).toMatchObject({ status: 'failed', commitSha: SHA, reviewedAt: new Date(Math.floor(now / 1000) * 1000) });
  });

  it('applies the parent policy to a pinned fork preview without sending a token to the fork', async () => {
    await db.insert(services).values({ id: 2, name: 'pr-1', slug: 'pr-1', type: 'docker', repoUrl: 'https://github.com/contributor/fork.git', branch: 'feature', previewParentServiceId: 1, previewFromFork: true });
    await db.update(deployments).set({ serviceId: 2, commitSha: SHA }).where(eq(deployments.id, 1));
    runs = [run({ event: 'pull_request' })];
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'queued', commitSha: SHA, ciGate: { state: 'passed', ownerServiceId: 1 } });
    expect(gh.calls.every((call) => !call.path.includes('/contributor/'))).toBe(true);
    expect(gh.calls.some((call) => call.path.includes('/commits/'))).toBe(false);
  });

  it('refuses source changes made while GitHub is answering', async () => {
    gh.on('GET', /^\/repos\/acme\/app\/actions\/runs$/, async () => {
      await db.update(services).set({ branch: 'other' }).where(eq(services.id, 1));
      return json(200, { workflow_runs: [run()] });
    });
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'failed', ciGate: { reason: expect.stringContaining('source changed') } });
  });

  it('does not release an old CI candidate after a newer deployment has served', async () => {
    runs = [run()];
    await holdForCiIfNeeded(db, 1, now);
    await db.insert(deployments).values({ serviceId: 1, status: 'running', commitSha: OTHER_SHA });
    await pollCiGates(db, { now });
    expect((await dep())?.status).toBe('cancelled');
  });

  it('polls fairly when older candidates become due again before a later candidate was checked', async () => {
    const primary = await db.query.serviceGithubLinks.findFirst();
    for (let id = 2; id <= 5; id++) {
      await db.insert(services).values({ id, name: `web-${id}`, slug: `web-${id}`, type: 'docker', repoUrl: 'https://github.com/acme/app.git', branch: 'main' });
      await db.insert(serviceGithubLinks).values({ serviceId: id, installationRowId: primary!.installationRowId, repoId: 555, repoFullName: 'acme/app', requiredWorkflows: [WORKFLOW] });
      await db.insert(deployments).values({ id, serviceId: id });
    }
    for (let id = 1; id <= 5; id++) await holdForCiIfNeeded(db, id, now);
    await pollCiGates(db, { now });
    expect((await db.query.deployments.findFirst({ where: eq(deployments.id, 5) }))?.commitSha).toBeNull();
    await pollCiGates(db, { now: now + 31_000 });
    expect((await db.query.deployments.findFirst({ where: eq(deployments.id, 5) }))?.commitSha,
      'An unchecked candidate must not starve behind older retrying candidates').toBe(SHA);
  });

  it('cancels a queued CI receipt if a newer deployment started after the poll released it', async () => {
    runs = [run()];
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect((await dep())?.status).toBe('queued');
    await db.insert(deployments).values({ serviceId: 1, status: 'running', commitSha: OTHER_SHA });
    expect(await holdForCiIfNeeded(db, 1, now + 1)).toBe(true);
    expect((await dep())?.status).toBe('cancelled');
  });
});
