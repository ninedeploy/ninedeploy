import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciAttempts, ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { extendLeasesAfterRestart, finishAttempt, heartbeat, revokeRunner, sweepLostAttempts } from '../../apps/server/src/lib/ci.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
let db: DB;
const NOW = 1_800_000_100_000;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'CI independent', slug: 'ci-independent', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'independent runner', tokenHash: 'fixture' });
  await db.insert(ciJobs).values({ id: 1, serviceId: 1, image: 'alpine', script: 'true', status: 'running', attempts: 1, maxAttempts: 2, currentAttemptId: 1 });
  await db.insert(ciAttempts).values({ id: 1, jobId: 1, runnerId: 1, number: 1, leaseHash: 'fixture', leaseExpiresAt: NOW - 1 });
});
afterEach(() => closeMigratedDb(db));
async function state(expectedAttempt: string, expectedJob: string) {
  const attempt = (await db.query.ciAttempts.findFirst())!;
  const job = (await db.query.ciJobs.findFirst())!;
  expect(attempt.status).toBe(expectedAttempt); expect(job.status).toBe(expectedJob);
  console.log('EXPECTED:', expectedAttempt, expectedJob, 'ACTUAL:', attempt.status, job.status, 'FIX VERIFIED');
}
async function suspended(n = 1) {
  let entered!: () => void; let release!: () => void; let reads = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.query.ciAttempts.findMany.bind(db.query.ciAttempts);
  const spy = vi.spyOn(db.query.ciAttempts, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => (async () => {
    const rows = await original(...args); if (++reads <= n) { if (reads === n) entered(); await gate; } return rows;
  })()) as typeof original);
  const pending = Promise.all(Array.from({ length: n }, () => sweepLostAttempts(db, NOW)));
  await Promise.race([ready, pending.then(() => { throw new Error('barrier missed'); })]);
  return { release, pending, close: async () => { release(); await pending.catch(() => undefined); spy.mockRestore(); } };
}
for (const limit of [1, 2]) for (const kind of ['heartbeat', 'restart'] as const) it(`${kind} wins before stale loss with maxAttempts=${limit}`, async () => {
  await db.$client.execute(`UPDATE ci_jobs SET max_attempts=${limit}`);
  const gate = await suspended();
  try {
    if (kind === 'restart') await extendLeasesAfterRestart(db, NOW);
    else expect(await heartbeat(db, (await db.query.ciRunners.findFirst())!, (await db.query.ciAttempts.findFirst())!, (await db.query.ciJobs.findFirst())!, NOW)).toEqual({ action: 'continue' });
    gate.release(); expect(await gate.pending).toEqual([0]); await state('running', 'running');
    expect((await db.query.ciJobs.findFirst())?.currentAttemptId).toBe(1);
  } finally { await gate.close(); }
});
for (const limit of [1, 2]) it(`two sweeps count one transition with maxAttempts=${limit}`, async () => {
  await db.$client.execute(`UPDATE ci_jobs SET max_attempts=${limit}`);
  const gate = await suspended(2);
  try {
    gate.release(); const counts = await gate.pending;
    expect(counts.reduce((a,b) => a+b, 0)).toBe(1);
    await state('lost', limit === 1 ? 'failed' : 'queued');
    expect(await sweepLostAttempts(db, NOW)).toBe(0);
  } finally { await gate.close(); }
});
for (const delta of [0, 1]) it(`lease cutoff delta ${delta} is not expired`, async () => {
  await db.$client.execute(`UPDATE ci_attempts SET lease_expires_at=${NOW + delta}`);
  expect(await sweepLostAttempts(db, NOW)).toBe(0); await state('running', 'running');
});
it('revocation still loses a freshly renewed lease', async () => {
  await extendLeasesAfterRestart(db, NOW);
  expect(await revokeRunner(db, 1)).toBe(true); await state('lost', 'queued');
});
it('revocation during a suspended sweep is not double-counted', async () => {
  const gate = await suspended();
  try {
    expect(await revokeRunner(db, 1)).toBe(true);
    gate.release(); expect(await gate.pending).toEqual([0]); await state('lost', 'queued');
  } finally { await gate.close(); }
});
it('a successful finish before the sweep update remains terminal', async () => {
  const gate = await suspended();
  try {
    // The request's own supplied time precedes expiration; the sweep has a later cutoff.
    await finishAttempt(db, (await db.query.ciAttempts.findFirst())!, (await db.query.ciJobs.findFirst())!, { status: 'succeeded', exitCode: 0 }, NOW - 2);
    gate.release(); expect(await gate.pending).toEqual([0]); await state('succeeded', 'succeeded');
  } finally { await gate.close(); }
});
it('renewal survives the stale sweep but a later real expiry is still lost', async () => {
  const gate = await suspended();
  try {
    await extendLeasesAfterRestart(db, NOW);
    gate.release(); expect(await gate.pending).toEqual([0]);
    expect(await sweepLostAttempts(db, NOW + 60_001)).toBe(1); await state('lost', 'queued');
  } finally { await gate.close(); }
});
