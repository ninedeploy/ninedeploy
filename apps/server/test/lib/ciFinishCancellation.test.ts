import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciAttempts, ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { cancelJob, finishAttempt } from '../../src/lib/ci.js';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';
let db: DB;
const NOW = 1_800_000_000_000;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'finish fixture', slug: 'finish-fixture', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'fixture' });
  await db.insert(ciJobs).values({ id: 1, serviceId: 1, image: 'alpine', script: 'true', status: 'running', attempts: 1, currentAttemptId: 1 });
  await db.insert(ciAttempts).values({ id: 1, jobId: 1, runnerId: 1, number: 1, leaseHash: 'fixture', leaseExpiresAt: NOW + 60_000 });
});
afterEach(() => closeMigratedDb(db));
function holdAfter(pattern: RegExp) {
  let enter!: () => void; let release!: () => void; let used = false;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.$client.execute.bind(db.$client);
  const spy = vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
    const statement = args[0]; const sql = typeof statement === 'string' ? statement : statement.sql;
    const held = !used && pattern.test(sql); if (held) used = true;
    const result = await original(...args); if (held) { enter(); await gate; } return result;
  }) as typeof original);
  return { ready, release, close: () => { release(); spy.mockRestore(); } };
}
async function snapshots() { return { attempt: (await db.query.ciAttempts.findFirst())!, job: (await db.query.ciJobs.findFirst())! }; }
const result = { status: 'succeeded' as const, exitCode: 0 };
it('a completed finish stays terminal and cannot be cancelled', async () => {
  const { attempt, job } = await snapshots(); await finishAttempt(db, attempt, job, result, NOW);
  expect(await cancelJob(db, 1, null)).toBe(false);
  expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'succeeded' });
  expect(await db.query.ciAttempts.findFirst()).toMatchObject({ status: 'succeeded' });
});
for (const order of ['cancel-first', 'attempt-result-first'] as const) it(`${order}: cancellation winning the job rejects the finish`, async () => {
  const { attempt, job } = await snapshots();
  const gate = holdAfter(order === 'cancel-first' ? /update "ci_jobs" set "status".*"cancelled_by"/i : /update "ci_attempts" set "status".*"exit_code"/i);
  let cancellation: Promise<boolean> | undefined;
  let finish: Promise<string> | undefined;
  const finishNow = () => finishAttempt(db, attempt, job, result, NOW).then(() => 'accepted', (err: unknown) => {
    if ((err as { status?: number }).status === 409) return 'conflict'; throw err;
  });
  try {
    if (order === 'cancel-first') {
      cancellation = cancelJob(db, 1, null); await gate.ready;
      finish = finishNow();
    } else {
      finish = finishNow(); await gate.ready;
      cancellation = cancelJob(db, 1, null); expect(await cancellation).toBe(true); gate.release();
    }
    const outcome = await finish;
    console.log('EXPECTED: conflict; ACTUAL:', outcome);
    console.log(outcome === 'conflict' ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    gate.release(); expect(await cancellation).toBe(true);
    console.log('EXPECTED: cancelled job/attempt; ACTUAL:', (await db.query.ciJobs.findFirst())?.status, '/', (await db.query.ciAttempts.findFirst())?.status);
    expect(outcome).toBe('conflict');
    expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'cancelled' });
    expect(await db.query.ciAttempts.findFirst()).toMatchObject({ status: 'cancelled' });
  } finally { gate.release(); await cancellation?.catch(() => undefined); await finish?.catch(() => undefined); gate.close(); }
});
