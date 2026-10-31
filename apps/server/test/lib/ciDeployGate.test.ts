/**
 * R5: deploys gated on a NineDeploy CI job (`lib/ciDeployGate.ts`) and jobs
 * run on push. The worker's claim path holds a queued deploy, the settle step
 * moves it on when the job ends, and the pipeline's last guard builds only
 * the commit the job passed.
 */
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ciJobs, type DB, deployments, services, users } from '@ninedeploy/db';
import { setPipeline } from '../../src/lib/ci.js';
import { assertRunnerCiForBuild, holdForRunnerCiIfNeeded, runCiOnPush, settleRunnerCiGates } from '../../src/lib/ciDeployGate.js';
import { handlePush } from '../../src/lib/webhookDispatch.js';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';

const dataDir = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  const dir = `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/nd-ci-gate-test-${process.pid}`;
  process.env['NINEDEPLOY_DATA_DIR'] = dir;
  return dir;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const base = { image: 'node:24-alpine', script: 'npm test', labels: [], secrets: [], timeoutMinutes: 10, maxAttempts: 2, requireApproval: false, runOnPush: false, gateDeploys: true };

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'ops@example.com', passwordHash: 'x', isInstanceOperator: true } as never);
  await db.insert(services).values([
    { id: 1, name: 'Web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', ownerUserId: 1 },
    {
      id: 2, name: 'Web PR 5', slug: 'web-pr-5', type: 'docker', repoUrl: 'https://github.com/fork/web.git', branch: 'feature',
      ownerUserId: 1, previewParentServiceId: 1, previewFromFork: true, isEphemeralPreview: true,
    },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

async function queue(serviceId: number, commitSha: string | null): Promise<number> {
  const [dep] = await db.insert(deployments).values({ serviceId, status: 'queued', trigger: 'webhook', commitSha } as never).returning();
  return dep!.id;
}
const depRow = async (id: number) => (await db.query.deployments.findFirst({ where: eq(deployments.id, id) }))!;
const jobsFor = (deploymentId: number) => db.query.ciJobs.findMany({ where: eq(ciJobs.deploymentId, deploymentId) });
const finish = (jobId: number, status: 'succeeded' | 'failed', commitSha: string | null) =>
  db.update(ciJobs).set({ status, commitSha, finishedAt: new Date(), ...(status === 'failed' ? { error: 'Exited with 1' } : {}) }).where(eq(ciJobs.id, jobId));

describe('R5 deploy gate', () => {
  it('leaves deploys alone without a gating pipeline', async () => {
    const dep = await queue(1, null);
    expect(await holdForRunnerCiIfNeeded(db, dep)).toBe(false);
    await setPipeline(db, 1, { ...base, gateDeploys: false });
    expect(await holdForRunnerCiIfNeeded(db, dep)).toBe(false);
    expect(await jobsFor(dep)).toHaveLength(0);
  });

  it('holds the deploy, runs one job, and builds exactly the commit the job pinned', async () => {
    await setPipeline(db, 1, base);
    const dep = await queue(1, null);
    expect(await holdForRunnerCiIfNeeded(db, dep)).toBe(true);
    expect((await depRow(dep)).status).toBe('awaiting_ci');
    const [job] = await jobsFor(dep);
    expect(job).toMatchObject({ serviceId: 1, status: 'queued', trigger: 'deploy', ref: null });
    await expect(assertRunnerCiForBuild(db, await depRow(dep), (await db.query.services.findFirst({ where: eq(services.id, 1) }))!)).rejects.toThrow(/has not passed/);

    expect(await settleRunnerCiGates(db)).toEqual([]);
    await finish(job!.id, 'succeeded', SHA_A);
    const [moved] = await settleRunnerCiGates(db);
    expect(moved).toMatchObject({ deploymentId: dep, status: 'queued' });
    expect(moved!.reason).toContain('aaaaaaa');
    expect(await depRow(dep)).toMatchObject({ status: 'queued', commitSha: SHA_A });

    // The claim path lets it through now, and does not run a second job.
    expect(await holdForRunnerCiIfNeeded(db, dep)).toBe(false);
    expect(await jobsFor(dep)).toHaveLength(1);
    const service = (await db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    await assertRunnerCiForBuild(db, await depRow(dep), service);
    // Another commit on the same deploy is not what the job passed.
    await expect(assertRunnerCiForBuild(db, { ...(await depRow(dep)), commitSha: SHA_B }, service)).rejects.toThrow(/has not passed/);
  });

  it('fails the deploy when the job fails, or when the job tested another commit', async () => {
    await setPipeline(db, 1, base);
    const failing = await queue(1, SHA_A);
    await holdForRunnerCiIfNeeded(db, failing);
    const [job] = await jobsFor(failing);
    expect(job!.ref).toBe(SHA_A);
    expect(job!.commitSha).toBe(SHA_A);
    await finish(job!.id, 'failed', SHA_A);
    const [t] = await settleRunnerCiGates(db);
    expect(t).toMatchObject({ deploymentId: failing, status: 'failed' });
    expect(t!.reason).toContain('Exited with 1');
    expect((await depRow(failing)).status).toBe('failed');

    const other = await queue(1, SHA_A);
    await holdForRunnerCiIfNeeded(db, other);
    const [job2] = await jobsFor(other);
    await finish(job2!.id, 'succeeded', SHA_B);
    const [t2] = await settleRunnerCiGates(db);
    expect(t2).toMatchObject({ status: 'failed', reason: expect.stringContaining('another commit') });
  });

  it('cancels the job of a deploy that was cancelled or replaced', async () => {
    await setPipeline(db, 1, base);
    const dep = await queue(1, SHA_A);
    await holdForRunnerCiIfNeeded(db, dep);
    await db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, dep));
    await settleRunnerCiGates(db);
    expect((await jobsFor(dep))[0]!.status).toBe('cancelled');
  });

  it('lets a waiting deploy go and stops its job when the gate is removed', async () => {
    await setPipeline(db, 1, base);
    const dep = await queue(1, SHA_A);
    await holdForRunnerCiIfNeeded(db, dep);
    await setPipeline(db, 1, { ...base, gateDeploys: false });
    const [t] = await settleRunnerCiGates(db);
    expect(t).toMatchObject({ deploymentId: dep, status: 'queued', reason: 'The CI gate was removed' });
    expect((await jobsFor(dep))[0]!.status).toBe('cancelled');
    expect(await holdForRunnerCiIfNeeded(db, dep)).toBe(false);
  });

  it('requeues a deploy held without a job, so the claim path decides again', async () => {
    await setPipeline(db, 1, base);
    const dep = await queue(1, SHA_A);
    await db.update(deployments).set({ status: 'awaiting_ci' }).where(eq(deployments.id, dep));
    expect(await settleRunnerCiGates(db)).toEqual([]);
    expect((await depRow(dep)).status).toBe('queued');
  });

  it("gates a fork preview with its parent's pipeline, and its job waits for an admin", async () => {
    await setPipeline(db, 1, base);
    const dep = await queue(2, SHA_A);
    expect(await holdForRunnerCiIfNeeded(db, dep)).toBe(true);
    const [job] = await jobsFor(dep);
    expect(job).toMatchObject({ serviceId: 2, status: 'awaiting_approval', commitSha: SHA_A });
  });
});

describe('R5 jobs on push', () => {
  const push = { branch: 'main', sha: SHA_A, message: 'fix', author: 'dev', changedFiles: [], commitsListed: 1 };

  it('runs one job per pushed commit when the pipeline asks for it', async () => {
    expect(await runCiOnPush(db, 1, push)).toBeNull();
    await setPipeline(db, 1, { ...base, gateDeploys: false, runOnPush: true });
    const id = await runCiOnPush(db, 1, push);
    expect(id).toBeTypeOf('number');
    // A replayed delivery adds no second job.
    expect(await runCiOnPush(db, 1, push)).toBeNull();
    const job = await db.query.ciJobs.findFirst({ where: eq(ciJobs.id, id!) });
    expect(job).toMatchObject({ trigger: 'push', commitSha: SHA_A, deploymentId: null });
  });

  it('is wired into the push webhook, which still queues the deploy', async () => {
    await setPipeline(db, 1, { ...base, gateDeploys: false, runOnPush: true });
    const result = await handlePush(db, 1, push, { branch: 'main', watchPaths: null, provider: 'github' });
    expect(result).toMatchObject({ ok: true, ciJobId: expect.any(Number), deploymentId: expect.any(Number) });
    const skipped = await handlePush(db, 1, { ...push, sha: SHA_B, message: 'docs [skip ci]' }, { branch: 'main', watchPaths: null, provider: 'github' });
    expect(skipped).toEqual({ ok: 'skipped', reason: 'skip_marker' });
    expect(await db.query.ciJobs.findMany()).toHaveLength(1);
  });

  it('leaves a gating pipeline to the deploy the push queues', async () => {
    await setPipeline(db, 1, { ...base, runOnPush: true });
    expect(await runCiOnPush(db, 1, push)).toBeNull();
  });
});
