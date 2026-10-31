/**
 * R5 CI jobs on enrolled runners (`modules/ci.ts`, `lib/ci.ts`), end to end on
 * a migrated SQLite with the real auth plugin: enrolment and revocation,
 * claims under capacity and labels, secrets for the lease holder, ordered
 * log chunks, one counted result per job, lost runners and requeues,
 * cancellation, approval, and a panel restart.
 */
import { rmSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ciAttempts, ciJobs, envVars, services, users, type DB } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import authPlugin from '../../src/plugins/auth.js';
import { issueSessionTokens } from '../../src/lib/sessions.js';
import { encrypt } from '../../src/lib/crypto.js';
import { extendLeasesAfterRestart, LEASE_MS, pruneCiJobs, sweepLostAttempts } from '../../src/lib/ci.js';
import { ciRunnerAdminRoutes, ciRunnerProtocolRoutes, ciServiceRoutes } from '../../src/modules/ci.js';
import { closeMigratedDb, migratedDb } from '../lib/githubAppKit.js';

const dataDir = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  process.env['JWT_SECRET'] ??= 'x'.repeat(64);
  const dir = `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/nd-ci-test-${process.pid}`;
  process.env['NINEDEPLOY_DATA_DIR'] = dir;
  return dir;
});

let db: DB;
let app: FastifyInstance;
let session: string;
const SECRET = ['s3cr', 'et-value'].join('');

beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 4, email: 'ops@example.com', passwordHash: 'x', isInstanceOperator: true } as never);
  session = (await issueSessionTokens(db, { id: 4, tokenVersion: 0 })).accessToken;
  await db.insert(services).values({ id: 7, name: 'Web', slug: 'web', type: 'docker', image: 'nginx:1.27', ownerUserId: 4 } as never);
  await db.insert(envVars).values([
    { serviceId: 7, key: 'API_KEY', valueEncrypted: encrypt(SECRET), isSecret: true },
    { serviceId: 7, key: 'OTHER', valueEncrypted: encrypt('not-for-ci'), isSecret: true },
  ] as never);
  app = Fastify({ logger: false });
  app.decorate('db', db as never);
  await app.register(authPlugin);
  await app.register(
    async (api) => {
      await api.register(ciRunnerAdminRoutes, { prefix: '/ci/runners' });
      await api.register(ciRunnerProtocolRoutes, { prefix: '/ci/runner' });
      await api.register(ciServiceRoutes, { prefix: '/services' });
    },
    { prefix: '/v1' },
  );
});
afterEach(async () => {
  await app.close();
  closeMigratedDb(db);
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const user = () => ({ authorization: `Bearer ${session}` });
const as = (token: string, lease?: string) => ({ authorization: `Bearer ${token}`, ...(lease ? { 'x-nd-lease': lease } : {}) });

async function enrol(name = 'r1', extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/ci/runners', headers: user(), payload: { name, ...extra } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}
async function pipeline(extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/services/7/ci',
    headers: user(),
    payload: { image: 'node:24-alpine', script: 'npm test', secrets: ['API_KEY'], ...extra },
  });
  expect(res.statusCode).toBe(200);
}
async function newJob(): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/v1/services/7/ci/jobs', headers: user(), payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json().id as number;
}
async function claim(token: string, running = 0) {
  return app.inject({ method: 'POST', url: '/v1/ci/runner/claim', headers: as(token), payload: { running } });
}
const post = (token: string, attemptId: number, lease: string, what: string, payload?: unknown) =>
  app.inject({ method: 'POST', url: `/v1/ci/runner/attempts/${attemptId}/${what}`, headers: as(token, lease), ...(payload ? { payload } : {}) });
const jobRow = async (id: number) => (await db.query.ciJobs.findFirst({ where: eq(ciJobs.id, id) }))!;

describe('R5 CI', () => {
  it('enrols a runner with a token shown once, and refuses unknown tokens', async () => {
    const token = await enrol('builder', { labels: ['linux', 'x64'], capacity: 2 });
    expect(token).toMatch(/^ndrun_/);
    const list = (await app.inject({ method: 'GET', url: '/v1/ci/runners', headers: user() })).json();
    expect(list).toEqual([expect.objectContaining({ name: 'builder', labels: ['linux', 'x64'], capacity: 2, online: false, running: 0 })]);
    expect(JSON.stringify(list)).not.toContain(token);
    expect((await claim('ndrun_nope')).statusCode).toBe(401);
    expect((await claim(session)).statusCode).toBe(401);
  });

  it('runs a job: claim with only the named secret, ordered logs, one counted result', async () => {
    const token = await enrol();
    await pipeline();
    const jobId = await newJob();
    const res = await claim(token);
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c).toMatchObject({ jobId, number: 1, image: 'node:24-alpine', script: 'npm test', env: { API_KEY: SECRET }, sourcePath: null });
    expect(c.env).not.toHaveProperty('OTHER');
    expect((await jobRow(jobId)).status).toBe('running');
    // Capacity 1: nothing more for this runner while it runs one.
    await newJob();
    expect((await claim(token, 0)).statusCode).toBe(204);

    expect((await post(token, c.attemptId, c.leaseToken, 'log', { seq: 1, data: 'hello\n' })).json()).toEqual({ stored: true });
    expect((await post(token, c.attemptId, c.leaseToken, 'log', { seq: 1, data: 'hello\n' })).json()).toEqual({ stored: false });
    expect((await post(token, c.attemptId, c.leaseToken, 'log', { seq: 3, data: 'gap' })).statusCode).toBe(409);
    expect((await post(token, c.attemptId, c.leaseToken, 'log', { seq: 2, data: 'world\n' })).statusCode).toBe(200);
    const log = await app.inject({ method: 'GET', url: `/v1/services/7/ci/jobs/${jobId}/attempts/1/log?offset=6`, headers: user() });
    expect(log.body).toBe('world\n');
    expect(log.headers['x-nd-log-size']).toBe('12');

    expect((await post(token, c.attemptId, c.leaseToken, 'heartbeat')).json()).toEqual({ action: 'continue' });
    expect((await post(token, c.attemptId, 'ndlease_wrong', 'heartbeat')).statusCode).toBe(401);
    expect((await post(token, c.attemptId, c.leaseToken, 'finish', { status: 'succeeded', exitCode: 0 })).statusCode).toBe(200);
    expect((await post(token, c.attemptId, c.leaseToken, 'finish', { status: 'failed', exitCode: 1 })).statusCode).toBe(409);
    const detail = (await app.inject({ method: 'GET', url: `/v1/services/7/ci/jobs/${jobId}`, headers: user() })).json();
    expect(detail.job.status).toBe('succeeded');
    expect(detail.attempts).toEqual([expect.objectContaining({ number: 1, status: 'succeeded', exitCode: 0, runnerName: 'r1', logBytes: 12 })]);
  });

  it('a lease is bound to its runner', async () => {
    const a = await enrol('a');
    const b = await enrol('b');
    await pipeline();
    await newJob();
    const c = (await claim(a)).json();
    expect((await post(b, c.attemptId, c.leaseToken, 'heartbeat')).statusCode).toBe(401);
    expect((await post(b, c.attemptId, c.leaseToken, 'finish', { status: 'succeeded', exitCode: 0 })).statusCode).toBe(401);
  });

  it('a lost runner requeues the job; its late result does not count and it is told to stop', async () => {
    const a = await enrol('a');
    const b = await enrol('b');
    await pipeline({ maxAttempts: 2 });
    const jobId = await newJob();
    const first = (await claim(a)).json();
    expect(await sweepLostAttempts(db, Date.now() + LEASE_MS + 1000)).toBe(1);
    expect((await jobRow(jobId)).status).toBe('queued');
    const second = (await claim(b)).json();
    expect(second).toMatchObject({ jobId, number: 2 });
    // The first runner comes back.
    expect((await post(a, first.attemptId, first.leaseToken, 'heartbeat')).json()).toEqual({ action: 'stop', reason: 'superseded' });
    expect((await post(a, first.attemptId, first.leaseToken, 'finish', { status: 'succeeded', exitCode: 0 })).statusCode).toBe(409);
    expect((await post(b, second.attemptId, second.leaseToken, 'finish', { status: 'failed', exitCode: 2 })).statusCode).toBe(200);
    const job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'failed', attempts: 2, error: 'Exited with 2' });
    const attempts = await db.query.ciAttempts.findMany({ where: eq(ciAttempts.jobId, jobId) });
    expect(attempts.map((x) => x.status).sort()).toEqual(['failed', 'lost']);
  });

  it('fails a job once its attempts are used up', async () => {
    const a = await enrol();
    await pipeline({ maxAttempts: 1 });
    const jobId = await newJob();
    await claim(a);
    await sweepLostAttempts(db, Date.now() + LEASE_MS + 1000);
    expect(await jobRow(jobId)).toMatchObject({ status: 'failed', error: expect.stringContaining('no attempts left') });
  });

  it('cancelling a running job stops its runner and voids its result', async () => {
    const a = await enrol();
    await pipeline();
    const jobId = await newJob();
    const c = (await claim(a)).json();
    expect((await app.inject({ method: 'POST', url: `/v1/services/7/ci/jobs/${jobId}/cancel`, headers: user() })).statusCode).toBe(200);
    expect((await post(a, c.attemptId, c.leaseToken, 'heartbeat')).json()).toEqual({ action: 'stop', reason: 'cancelled' });
    expect((await post(a, c.attemptId, c.leaseToken, 'finish', { status: 'succeeded', exitCode: 0 })).statusCode).toBe(409);
    expect((await post(a, c.attemptId, c.leaseToken, 'log', { seq: 1, data: 'late' })).statusCode).toBe(409);
    expect((await jobRow(jobId)).status).toBe('cancelled');
    expect((await app.inject({ method: 'POST', url: `/v1/services/7/ci/jobs/${jobId}/cancel`, headers: user() })).statusCode).toBe(409);
  });

  it('holds a job for approval, and matches runner labels', async () => {
    const plain = await enrol('plain');
    const gpu = await enrol('gpu', { labels: ['gpu', 'linux'] });
    await pipeline({ requireApproval: true, labels: ['gpu'] });
    const jobId = await newJob();
    expect((await jobRow(jobId)).status).toBe('awaiting_approval');
    expect((await claim(gpu)).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: `/v1/services/7/ci/jobs/${jobId}/approve`, headers: user() })).statusCode).toBe(200);
    expect((await claim(plain)).statusCode).toBe(204);
    expect((await claim(gpu)).json()).toMatchObject({ jobId });
  });

  it('revoking a runner shuts it out and requeues its work', async () => {
    const a = await enrol();
    await pipeline();
    const jobId = await newJob();
    const c = (await claim(a)).json();
    const runnerId = (await app.inject({ method: 'GET', url: '/v1/ci/runners', headers: user() })).json()[0].id;
    expect((await app.inject({ method: 'DELETE', url: `/v1/ci/runners/${runnerId}`, headers: user() })).statusCode).toBe(200);
    expect((await claim(a)).statusCode).toBe(401);
    expect((await post(a, c.attemptId, c.leaseToken, 'heartbeat')).statusCode).toBe(401);
    expect((await jobRow(jobId)).status).toBe('queued');
  });

  it('a panel restart gives running attempts a fresh lease instead of declaring them lost', async () => {
    const a = await enrol();
    await pipeline();
    const jobId = await newJob();
    await claim(a);
    const later = Date.now() + LEASE_MS + 5000;
    await extendLeasesAfterRestart(db, later);
    expect(await sweepLostAttempts(db, later + 1000)).toBe(0);
    expect((await jobRow(jobId)).status).toBe('running');
  });

  it('only admins choose the pipeline, and finished jobs are pruned with their logs', async () => {
    await db.insert(users).values({ id: 9, email: 'viewer@example.com', passwordHash: 'x' } as never);
    const viewer = (await issueSessionTokens(db, { id: 9, tokenVersion: 0 })).accessToken;
    const denied = await app.inject({ method: 'PUT', url: '/v1/services/7/ci', headers: { authorization: `Bearer ${viewer}` }, payload: { image: 'alpine', script: 'env' } });
    expect([403, 404]).toContain(denied.statusCode);
    expect((await app.inject({ method: 'POST', url: '/v1/services/7/ci/jobs', headers: user(), payload: {} })).json()).toMatchObject({ code: 'no_pipeline' });
    const bad = await app.inject({ method: 'PUT', url: '/v1/services/7/ci', headers: user(), payload: { image: '--privileged', script: 'x' } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    const a = await enrol();
    await pipeline();
    const jobId = await newJob();
    const c = (await claim(a)).json();
    await post(a, c.attemptId, c.leaseToken, 'log', { seq: 1, data: 'x' });
    await post(a, c.attemptId, c.leaseToken, 'finish', { status: 'succeeded', exitCode: 0 });
    expect(await pruneCiJobs(db, 30, Date.now() + 31 * 86_400_000)).toBe(1);
    expect(await db.query.ciJobs.findFirst({ where: eq(ciJobs.id, jobId) })).toBeUndefined();
  });
});
