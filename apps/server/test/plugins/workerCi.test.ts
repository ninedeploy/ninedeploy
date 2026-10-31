import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployments, environments, serviceGithubLinks, services, users, workspaces, type DB } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return { fetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(), pipeline: vi.fn(async (..._args: unknown[]) => undefined) };
});
vi.mock('../../src/lib/egressGuard.js', async (original) => ({ ...await original<typeof import('../../src/lib/egressGuard.js')>(), guardedFetch: h.fetch }));
vi.mock('../../src/engine/pipeline.js', () => ({ runDeployment: h.pipeline }));
vi.mock('../../src/config.js', () => ({ config: { deployConcurrency: 1 } }));
vi.mock('../../src/lib/exec.js', () => ({ capture: vi.fn(async () => ''), run: vi.fn(async () => undefined) }));
vi.mock('../../src/engine/logs.js', () => ({ logBus: { publish: vi.fn(), beginRun: vi.fn(), end: vi.fn() } }));

const { default: workerPlugin } = await import('../../src/plugins/worker.js');
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const { closeMigratedDb, fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('../lib/githubAppKit.js');
const key = rsaKeyPair();
const SHA = 'a'.repeat(40);
let db: DB;
let app: ReturnType<typeof Fastify> | undefined;
let gh: ReturnType<typeof fakeGithub>;
let success: boolean;
const row = () => db.query.deployments.findFirst({ where: eq(deployments.id, 1) });
async function until(check: () => Promise<boolean>) {
  const deadline = performance.now() + 12_000;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error('Worker did not reach the expected state within 12s');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function boot() {
  app = Fastify({ logger: false });
  app.decorate('db', db);
  await app.register(workerPlugin);
  await app.ready();
}
beforeEach(async () => {
  db = await migratedDb();
  clearGithubAppCaches();
  h.pipeline.mockClear();
  success = false;
  gh = fakeGithub();
  h.fetch.mockImplementation(gh.handler);
  const github = await seedApp(db, key.privateKey);
  const { inst } = await seedInstallation(db, github);
  await db.insert(services).values([
    { id: 1, name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/app.git', branch: 'main' },
    { id: 2, name: 'ungated', slug: 'ungated', type: 'docker' },
  ]);
  await db.insert(serviceGithubLinks).values({ serviceId: 1, installationRowId: inst.id, repoId: 555, repoFullName: 'acme/app', requiredWorkflows: ['.github/workflows/ci.yml'] });
  await db.insert(deployments).values({ id: 1, serviceId: 1, trigger: 'webhook' });
  gh.on('GET', /^\/repos\/acme\/app$/, () => json(200, { id: 555 }));
  gh.on('GET', /^\/repos\/acme\/app\/commits\//, () => json(200, { sha: SHA }));
  gh.on('GET', /^\/repos\/acme\/app\/actions\/runs$/, () => json(200, { workflow_runs: success ? [{
    id: 10, run_attempt: 1, path: '.github/workflows/ci.yml', head_sha: SHA, status: 'completed', conclusion: 'success', event: 'push',
  }] : [] }));
});
afterEach(async () => { await app?.close(); closeMigratedDb(db); vi.useRealTimers(); });

describe('required CI in the real deploy worker', () => {
  it('keeps build slots free, resumes the persisted candidate after restart, and builds its exact commit', async () => {
    await db.insert(deployments).values({ id: 2, serviceId: 2 });
    await boot();
    await until(async () => h.pipeline.mock.calls.some((call) => call[1] === 2));
    expect((await row())?.status).toBe('awaiting_ci');
    expect(h.pipeline.mock.calls.some((call) => call[1] === 1)).toBe(false);
    await until(async () => (await row())?.commitSha === SHA);
    await app!.close();
    success = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    await boot();
    await until(async () => h.pipeline.mock.calls.some((call) => call[1] === 1));
    expect(await row()).toMatchObject({ status: 'building', commitSha: SHA, ciGate: { state: 'passed' } });
  }, 25_000);

  it('pins and verifies CI before requesting a human review', async () => {
    success = true;
    await db.insert(users).values({ id: 1, email: 'owner@example.test', passwordHash: 'x' });
    await db.insert(workspaces).values({ id: 1, name: 'Acme', slug: 'acme', ownerId: 1 });
    await db.insert(environments).values({ id: 1, workspaceId: 1, name: 'prod', slug: 'prod', requireApproval: true });
    await db.update(services).set({ environmentId: 1, ownerUserId: 1 }).where(eq(services.id, 1));
    await db.update(deployments).set({ reviewedBy: 1, reviewedAt: new Date() }).where(eq(deployments.id, 1));
    await boot();
    await until(async () => (await row())?.status === 'awaiting_approval');
    expect(await row()).toMatchObject({ commitSha: SHA, reviewedAt: null, ciGate: { state: 'passed' } });
    expect(h.pipeline).not.toHaveBeenCalled();
    await db.update(deployments).set({ status: 'queued', reviewedBy: 1, reviewedAt: new Date() }).where(eq(deployments.id, 1));
    await until(async () => h.pipeline.mock.calls.length > 0);
    expect(h.pipeline.mock.calls[0]?.[1]).toBe(1);
  }, 25_000);

  it('R5: holds a deploy for its NineDeploy CI job and builds the commit the job passed', async () => {
    const { setPipeline } = await import('../../src/lib/ci.js');
    const { ciJobs } = await import('@ninedeploy/db');
    await db.insert(services).values({ id: 3, name: 'gated', slug: 'gated', type: 'docker', repoUrl: 'https://github.com/acme/gated.git', branch: 'main' });
    await setPipeline(db, 3, {
      image: 'node:24-alpine', script: 'npm test', labels: [], secrets: [], timeoutMinutes: 10, maxAttempts: 1,
      requireApproval: false, runOnPush: false, gateDeploys: true,
    });
    await db.insert(deployments).values({ id: 3, serviceId: 3, trigger: 'webhook' });
    const gated = () => db.query.deployments.findFirst({ where: eq(deployments.id, 3) });
    await boot();
    await until(async () => (await gated())?.status === 'awaiting_ci');
    const job = await db.query.ciJobs.findFirst({ where: eq(ciJobs.deploymentId, 3) });
    expect(job).toMatchObject({ status: 'queued', trigger: 'deploy' });
    expect(h.pipeline.mock.calls.some((call) => call[1] === 3)).toBe(false);
    await db.update(ciJobs).set({ status: 'succeeded', commitSha: SHA, finishedAt: new Date() }).where(eq(ciJobs.id, job!.id));
    await until(async () => h.pipeline.mock.calls.some((call) => call[1] === 3));
    expect(await gated()).toMatchObject({ commitSha: SHA });
  }, 25_000);

  it('aborts a pending GitHub request on stop and leaves a resumable wait', async () => {
    let requestStarted = false;
    const http = gh.handler;
    h.fetch.mockImplementation(async (url, init) => {
      if (String(url).includes('/actions/runs')) {
        requestStarted = true;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new Error('aborted'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return http(url, init);
    });
    await boot();
    await until(async () => requestStarted);
    const start = performance.now();
    await app!.worker.stop();
    expect(performance.now() - start).toBeLessThan(2000);
    expect(await row()).toMatchObject({ status: 'awaiting_ci', commitSha: SHA });
    expect(h.pipeline).not.toHaveBeenCalled();
  }, 20_000);
});
