import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { cancelJob, claimJob, finishAttempt, heartbeat } from '../../apps/server/src/lib/ci.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'independent', slug: 'independent', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'fixture' });
  await db.insert(ciJobs).values({ id: 1, serviceId: 1, image: 'alpine', script: 'true' });
});
afterEach(() => closeMigratedDb(db));
const runner = async () => (await db.query.ciRunners.findFirst())!;
const offer = async () => claimJob(db, await runner(), { running: 0 });
async function checked(status: string, attemptStatus: string) {
  expect((await db.query.ciJobs.findFirst())?.status).toBe(status);
  expect((await db.query.ciAttempts.findFirst())?.status).toBe(attemptStatus);
  console.log('EXPECTED:', status, attemptStatus, 'ACTUAL:', status, attemptStatus, 'FIX VERIFIED');
}
function gateSql(pattern: RegExp, after: boolean) {
  let entered!: () => void; let release!: () => void; let used = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = db.$client.execute.bind(db.$client);
  const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
    const statement = args[0]; const sql = typeof statement === 'string' ? statement : statement.sql;
    const held = !used && pattern.test(sql); if (held) used = true;
    if (held && !after) { entered(); await blocked; }
    const result = await original(...args);
    if (held && after) { entered(); await blocked; }
    return result;
  }) as typeof original);
  return { ready, release, close: () => { release(); spy.mockRestore(); } };
}
for (const [label, pattern, after] of [
  ['before insert', /insert into "ci_attempts"/i, false],
  ['after insert', /insert into "ci_attempts"/i, true],
  ['before assignment', /update "ci_jobs" set "current_attempt_id"/i, false],
] as const) it(`cancellation wins ${label}, retires the attempt, and frees capacity`, async () => {
  const gate = gateSql(pattern, after); const pending = offer();
  try {
    await Promise.race([gate.ready, pending.then(() => { throw new Error('barrier missed'); })]);
    expect(await cancelJob(db, 1, null)).toBe(true);
    gate.release(); expect(await pending).toBeNull(); await checked('cancelled', 'cancelled');
    expect((await db.query.ciJobs.findFirst())?.currentAttemptId).toBeNull();
    await db.insert(ciJobs).values({ id: 2, serviceId: 1, image: 'alpine', script: 'true' });
    expect(await offer()).toMatchObject({ jobId: 2, number: 1 });
  } finally { gate.release(); await pending.catch(() => undefined); gate.close(); }
});
it('a claim completed before the cancellation update is the attempt cancelled', async () => {
  const gate = gateSql(/update "ci_jobs" set "status" = .*"cancelled_by"/i, false);
  const cancellation = cancelJob(db, 1, null);
  try {
    await Promise.race([gate.ready, cancellation.then(() => { throw new Error('cancel barrier missed'); })]);
    expect(await offer()).toMatchObject({ jobId: 1 });
    gate.release(); expect(await cancellation).toBe(true); await checked('cancelled', 'cancelled');
  } finally { gate.release(); await cancellation.catch(() => undefined); gate.close(); }
});
it('an already cancelled queued job produces no attempt', async () => {
  expect(await cancelJob(db, 1, null)).toBe(true); expect(await offer()).toBeNull();
  expect(await db.query.ciAttempts.findMany()).toHaveLength(0); console.log('FIX VERIFIED');
});
for (const status of ['succeeded', 'failed'] as const) it(`terminal ${status} stays terminal and cancellation returns false`, async () => {
  const claim = (await offer())!;
  await finishAttempt(db, (await db.query.ciAttempts.findFirst())!, (await db.query.ciJobs.findFirst())!, { status, exitCode: status === 'failed' ? 1 : 0 });
  expect(await cancelJob(db, 1, null)).toBe(false); await checked(status, status);
  expect(claim.jobId).toBe(1);
});
it('concurrent cancellations have one winner and stop the current runner', async () => {
  await offer();
  const results = await Promise.all([cancelJob(db, 1, null), cancelJob(db, 1, null)]);
  expect(results.filter(Boolean)).toHaveLength(1); await checked('cancelled', 'cancelled');
  expect(await heartbeat(db, await runner(), (await db.query.ciAttempts.findFirst())!, (await db.query.ciJobs.findFirst())!)).toEqual({ action: 'stop', reason: 'cancelled' });
});
it('ordinary accepted work retains its live lease and capacity until cancellation', async () => {
  expect(await offer()).toMatchObject({ jobId: 1, number: 1 }); await checked('running', 'running');
  await db.insert(ciJobs).values({ id: 2, serviceId: 1, image: 'alpine', script: 'true' });
  expect(await offer()).toBeNull(); expect(await cancelJob(db, 1, null)).toBe(true);
  expect(await offer()).toMatchObject({ jobId: 2 });
});
