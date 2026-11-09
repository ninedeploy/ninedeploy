import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ciAttempts, ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
const audit = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit }));
const { cancelJob, hashToken } = await import('../../apps/server/src/lib/ci.js');
const { ciRunnerProtocolRoutes } = await import('../../apps/server/src/modules/ci.js');
const { closeMigratedDb, migratedDb } = await import('../../apps/server/test/lib/githubAppKit.js');
let db: DB; let app: FastifyInstance;
const NOW = 1_800_000_000_000;
const token = 'ndrun_disposable_fixture'; const lease = 'ndlease_disposable_fixture';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); audit.mockClear();
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'HTTP independent', slug: 'http-independent', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: hashToken(token) });
  await db.insert(ciJobs).values({ id: 1, serviceId: 1, image: 'alpine', script: 'true', status: 'running', attempts: 1, currentAttemptId: 1 });
  await db.insert(ciAttempts).values({ id: 1, jobId: 1, runnerId: 1, number: 1, leaseHash: hashToken(lease), leaseExpiresAt: NOW + 60_000 });
  app = Fastify({ logger: false }); app.decorate('db', db); await app.register(ciRunnerProtocolRoutes, { prefix: '/ci/runner' }); await app.ready();
});
afterEach(async () => { await app?.close(); closeMigratedDb(db); vi.useRealTimers(); });
const finish = (status: 'succeeded' | 'failed') => app.inject({ method: 'POST', url: '/ci/runner/attempts/1/finish',
  headers: { authorization: `Bearer ${token}`, 'x-nd-lease': lease }, payload: { status, exitCode: status === 'succeeded' ? 0 : 1 } });
function holdAfter(pattern: RegExp) {
  let enter!: () => void; let release!: () => void; let used = false;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.$client.execute.bind(db.$client);
  const spy = vi.spyOn(db.$client,'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
    const stmt = args[0]; const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    const held = !used && pattern.test(sql); if (held) used = true;
    const result = await original(...args); if (held) { enter(); await gate; } return result;
  }) as typeof original);
  return { ready, release, close: () => { release(); spy.mockRestore(); } };
}
for (const status of ['succeeded', 'failed'] as const) {
  it(`HTTP ${status} completes once and emits one result audit`, async () => {
    expect((await finish(status)).statusCode).toBe(200);
    expect((await finish(status)).statusCode).toBe(409);
    expect(await cancelJob(db,1,null)).toBe(false);
    expect(audit.mock.calls.filter(call => call[2] === `ci.job_${status}`)).toHaveLength(1);
    expect((await db.query.ciJobs.findFirst())?.status).toBe(status); console.log('FIX VERIFIED');
  });
  for (const order of ['cancel-first','attempt-first'] as const) it(`HTTP ${status}, ${order}: 409 and no result audit`, async () => {
    let releaseRead!: () => void; let read!: () => void;
    const readyRead = new Promise<void>(resolve => { read = resolve; });
    const blockedRead = new Promise<void>(resolve => { releaseRead = resolve; });
    let readSpy: { mockRestore(): void } | undefined;
    if (order === 'cancel-first') {
      const original = db.query.ciJobs.findFirst.bind(db.query.ciJobs);
      readSpy = vi.spyOn(db.query.ciJobs,'findFirst').mockImplementationOnce(((...args: Parameters<typeof original>) => (async () => {
        const row = await original(...args); read(); await blockedRead; return row;
      })()) as typeof original);
    }
    const gate = holdAfter(order === 'cancel-first' ? /update "ci_jobs" set "status".*"cancelled_by"/i : /update "ci_attempts" set "status".*"exit_code"/i);
    const pending = finish(status).then(response => response);
    let cancellation: Promise<boolean> | undefined;
    try {
      if (order === 'cancel-first') {
        await readyRead; cancellation = cancelJob(db,1,null); await gate.ready; releaseRead();
      } else {
        await gate.ready; cancellation = cancelJob(db,1,null); expect(await cancellation).toBe(true); gate.release();
      }
      const response = await pending;
      gate.release(); expect(await cancellation).toBe(true);
      console.log('EXPECTED: HTTP409; ACTUAL:', response.statusCode, 'FIX VERIFIED');
      expect(response.statusCode).toBe(409);
      expect(audit.mock.calls.some(call => call[2] === `ci.job_${status}`)).toBe(false);
      expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'cancelled' });
      expect(await db.query.ciAttempts.findFirst()).toMatchObject({ status: 'cancelled' });
    } finally { releaseRead(); gate.release(); await cancellation?.catch(() => undefined); await pending.catch(() => undefined); readSpy?.mockRestore(); gate.close(); }
  });
}
it('already cancelled work is a conflict without a result audit', async () => {
  await cancelJob(db,1,null); expect((await finish('succeeded')).statusCode).toBe(409);
  expect(audit).not.toHaveBeenCalled(); console.log('FIX VERIFIED');
});
it('an expired lease is a conflict without a result audit', async () => {
  await db.$client.execute(`UPDATE ci_attempts SET lease_expires_at=${NOW - 1}`);
  expect((await finish('succeeded')).statusCode).toBe(409); expect(audit).not.toHaveBeenCalled(); console.log('FIX VERIFIED');
});
it('a superseded attempt cannot finish the current job', async () => {
  await db.$client.execute('UPDATE ci_jobs SET current_attempt_id=2');
  expect((await finish('succeeded')).statusCode).toBe(409); expect(audit).not.toHaveBeenCalled();
  expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'running', currentAttemptId: 2 }); console.log('FIX VERIFIED');
});
