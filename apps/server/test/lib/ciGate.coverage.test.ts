import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployments, githubAppInstallations, serviceGithubLinks, services, type DB, type DeploymentCiGate } from '@ninedeploy/db';

/** ciGate: the refusal and edge paths ciGate.test.ts does not reach. Same seams (fake GitHub behind guardedFetch, migrated in-memory DB). */

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return { fetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>() };
});
vi.mock('../../src/lib/egressGuard.js', async (original) => ({
  ...await original<typeof import('../../src/lib/egressGuard.js')>(), guardedFetch: h.fetch,
}));
const { holdForCiIfNeeded, pollCiGates, assertCiGateForBuild, ciSummary } = await import('../../src/lib/ciGate.js');
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const { closeMigratedDb, fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');
const key = rsaKeyPair();
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const WORKFLOW = '.github/workflows/ci.yml';
let db: DB;
let gh: ReturnType<typeof fakeGithub>;
let now: number;
let instId: number;
const dep = (id = 1) => db.query.deployments.findFirst({ where: eq(deployments.id, id) });
const svc = (id = 1) => db.query.services.findFirst({ where: eq(services.id, id) });
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
  instId = inst.id;
  await db.insert(services).values({ id: 1, name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/app.git', branch: 'main' });
  await db.insert(serviceGithubLinks).values({ serviceId: 1, installationRowId: inst.id, repoId: 555, repoFullName: 'acme/app', requiredWorkflows: [WORKFLOW] });
  await db.insert(deployments).values({ id: 1, serviceId: 1, status: 'queued', trigger: 'webhook' });
  gh.on('GET', /^\/repos\/acme\/app$/, () => json(200, { id: 555 }));
  gh.on('GET', /^\/repos\/acme\/app\/commits\//, () => json(200, { sha: SHA }));
  gh.on('GET', /^\/repos\/acme\/app\/actions\/runs$/, () => json(200, { workflow_runs: [run()] }));
});
afterEach(() => { closeMigratedDb(db); vi.restoreAllMocks(); });

/** Hold deployment 1, run one poll, and return the row. */
const holdAndPoll = async () => {
  expect(await holdForCiIfNeeded(db, 1, now)).toBe(true);
  await pollCiGates(db, { now });
  return dep();
};

describe('ciSummary', () => {
  it('is null without a gate and exposes only safe evidence', () => {
    expect(ciSummary(null)).toBeNull();
    expect(ciSummary(undefined)).toBeNull();
    const gate = { state: 'passed', reason: 'ok', headSha: SHA, deadlineAt: 0, checkedAt: 1000, checks: [], linkId: 1 } as unknown as DeploymentCiGate;
    expect(ciSummary(gate)).toEqual({ state: 'passed', reason: 'ok', headSha: SHA, deadlineAt: new Date(0).toISOString(), checkedAt: new Date(1000).toISOString(), checks: [] });
    expect(ciSummary({ ...gate, checkedAt: null })?.checkedAt).toBeNull();
  });
});

describe('holdForCiIfNeeded edges', () => {
  it('lets missing and non-queued deployments through untouched', async () => {
    expect(await holdForCiIfNeeded(db, 999, now)).toBe(true);
    await db.update(deployments).set({ status: 'building' }).where(eq(deployments.id, 1));
    expect(await holdForCiIfNeeded(db, 1, now)).toBe(true);
    expect((await dep())?.status).toBe('building');
  });

  it('holds again (renewing the deadline) when a fresh receipt no longer matches the source', async () => {
    expect((await holdAndPoll())?.status).toBe('queued');
    await db.update(services).set({ branch: 'release' }).where(eq(services.id, 1));
    expect(await holdForCiIfNeeded(db, 1, now + 1)).toBe(true);
    expect(await dep()).toMatchObject({ status: 'awaiting_ci', ciGate: { state: 'waiting', deadlineAt: now + 1 + 2 * 60 * 60_000 } });
  });
});

describe('assertCiGateForBuild edges', () => {
  it('refuses an unverified build when a policy exists and allows it when none does', async () => {
    await expect(assertCiGateForBuild(db, (await dep())!, (await svc())!)).rejects.toThrow('Required CI has not been verified');
    await db.update(serviceGithubLinks).set({ requiredWorkflows: [] });
    await expect(assertCiGateForBuild(db, (await dep())!, (await svc())!)).resolves.toBeUndefined();
  });

  it('refuses a gate that has not passed for this exact commit', async () => {
    await holdForCiIfNeeded(db, 1, now);
    await expect(assertCiGateForBuild(db, (await dep())!, (await svc())!)).rejects.toThrow('Required CI has not passed for this exact commit');
  });

  it('refuses a passed gate once a newer deployment has started', async () => {
    expect((await holdAndPoll())?.status).toBe('queued');
    await db.insert(deployments).values({ serviceId: 1, status: 'building' });
    await expect(assertCiGateForBuild(db, (await dep())!, (await svc())!)).rejects.toThrow('CI candidate was replaced by a newer deployment');
  });
});

describe('pollCiGates refusals', () => {
  it('fails when the service switched to an image source', async () => {
    await holdForCiIfNeeded(db, 1, now);
    await db.update(services).set({ image: 'nginx:1' }).where(eq(services.id, 1));
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'failed', ciGate: { state: 'failed', reason: expect.stringContaining('repository builds only') } });
  });

  it('fails when the repository link changed after the hold', async () => {
    await holdForCiIfNeeded(db, 1, now);
    await db.update(serviceGithubLinks).set({ repoId: 777 });
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'failed', ciGate: { reason: 'CI repository link changed; cancel and deploy again' } });
  });

  it('keeps waiting (no verdict) while the installation is removed', async () => {
    await holdForCiIfNeeded(db, 1, now);
    await db.update(githubAppInstallations).set({ removedAt: new Date(now) }).where(eq(githubAppInstallations.id, instId));
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'awaiting_ci', ciGate: { state: 'waiting', reason: expect.stringContaining('GitHub could not verify CI') } });
  });

  it('fails when the link names a different repository than the service URL', async () => {
    await db.update(serviceGithubLinks).set({ repoFullName: 'acme/other' });
    await holdForCiIfNeeded(db, 1, now);
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'failed', ciGate: { reason: 'CI source changed; cancel and deploy again' } });
  });

  it('fails an invalid captured policy', async () => {
    await holdForCiIfNeeded(db, 1, now);
    const gate = (await dep())!.ciGate!;
    await db.update(deployments).set({ ciGate: { ...gate, workflows: [] } }).where(eq(deployments.id, 1));
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'failed', ciGate: { reason: 'Invalid CI policy; cancel and deploy again' } });
  });

  it('fails when GitHub reports another repository id', async () => {
    gh.on('GET', /^\/repos\/acme\/app$/, () => json(200, { id: 999 }));
    expect(await holdAndPoll()).toMatchObject({ status: 'failed', ciGate: { reason: 'CI repository identity changed; deploy again' } });
  });

  it('fails when the branch does not resolve to an exact SHA', async () => {
    gh.on('GET', /^\/repos\/acme\/app\/commits\//, () => json(200, { sha: 'not-a-sha' }));
    expect(await holdAndPoll()).toMatchObject({ status: 'failed', ciGate: { reason: 'GitHub did not return an exact commit SHA' } });
    gh.on('GET', /^\/repos\/acme\/app\/commits\//, () => json(200, {}));
    await db.update(deployments).set({ status: 'queued', ciGate: null }).where(eq(deployments.id, 1));
    expect(await holdAndPoll()).toMatchObject({ status: 'failed', ciGate: { reason: 'GitHub did not return an exact commit SHA' } });
  });

  it('fails when the deployment commit moved away from the resolved SHA', async () => {
    await holdForCiIfNeeded(db, 1, now);
    await db.update(deployments).set({ commitSha: OTHER_SHA }).where(eq(deployments.id, 1));
    await pollCiGates(db, { now });
    expect(await dep()).toMatchObject({ status: 'failed', ciGate: { reason: 'CI commit changed; deploy again' } });
  });

  it('refuses a fork preview that arrived without an exact SHA', async () => {
    await db.insert(services).values({ id: 2, name: 'pr-1', slug: 'pr-1', type: 'docker', repoUrl: 'https://github.com/contributor/fork.git', branch: 'feature', previewParentServiceId: 1, previewFromFork: true });
    await db.update(deployments).set({ serviceId: 2 }).where(eq(deployments.id, 1));
    expect(await holdAndPoll()).toMatchObject({ status: 'failed', ciGate: { reason: 'A CI-gated preview requires an exact commit SHA' } });
  });
});

describe('pollCiGates bookkeeping', () => {
  it('skips an awaiting row without a gate', async () => {
    await db.update(deployments).set({ status: 'awaiting_ci' }).where(eq(deployments.id, 1));
    expect(await pollCiGates(db, { now })).toEqual([]);
    expect((await dep())?.status).toBe('awaiting_ci');
    expect(gh.calls).toHaveLength(0);
  });

  it('reports a released candidate as a transition, and records nothing once the caller aborted', async () => {
    await holdForCiIfNeeded(db, 1, now);
    expect(await pollCiGates(db, { now, signal: new AbortController().signal })).toEqual([
      { deploymentId: 1, serviceId: 1, status: 'queued', reason: 'All required GitHub workflows passed for this exact commit' },
    ]);

    await db.insert(deployments).values({ id: 2, serviceId: 1, status: 'queued', commitSha: SHA });
    await holdForCiIfNeeded(db, 2, now);
    const aborted = new AbortController();
    aborted.abort();
    expect(await pollCiGates(db, { now, signal: aborted.signal })).toEqual([]);
    expect(await dep(2)).toMatchObject({ status: 'awaiting_ci', ciGate: { state: 'waiting' } });
  });

  it('surfaces database failures as one AggregateError', async () => {
    await holdForCiIfNeeded(db, 1, now);
    vi.spyOn(db, 'update').mockImplementation(() => { throw new Error('database is locked'); });
    const err = await pollCiGates(db, { now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual(['database is locked']);
  });
});
