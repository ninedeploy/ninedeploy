import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciAttempts, ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { extendLeasesAfterRestart, heartbeat, sweepLostAttempts } from '../../apps/server/src/lib/ci.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';

let db: DB;
const NOW = 1_800_000_000_000;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'CI fixture', slug: 'ci-fixture', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'synthetic' });
  await db.insert(ciJobs).values({ id: 1, serviceId: 1, image: 'alpine', script: 'true', status: 'running', attempts: 1, maxAttempts: 2, currentAttemptId: 1 });
  await db.insert(ciAttempts).values({ id: 1, jobId: 1, runnerId: 1, number: 1, leaseHash: 'synthetic', leaseExpiresAt: NOW - 1 });
});
afterEach(() => closeMigratedDb(db));

it('a still-expired lease is lost and its job requeued', async () => {
  expect(await sweepLostAttempts(db, NOW)).toBe(1);
  expect(await db.query.ciAttempts.findFirst()).toMatchObject({ status: 'lost' });
  expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'queued', currentAttemptId: null });
});

for (const renewal of ['heartbeat', 'restart'] as const) {
  it(`${renewal} after the sweep read preserves the renewed lease`, async () => {
    let entered!: () => void; let release!: () => void;
    const read = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = db.query.ciAttempts.findMany.bind(db.query.ciAttempts);
    const spy = vi.spyOn(db.query.ciAttempts, 'findMany').mockImplementationOnce(((...args: Parameters<typeof original>) => (async () => {
      const rows = await original(...args); entered(); await gate; return rows;
    })()) as typeof original);
    const sweep = sweepLostAttempts(db, NOW);
    try {
      await read;
      if (renewal === 'restart') await extendLeasesAfterRestart(db, NOW);
      else {
        const runner = (await db.query.ciRunners.findFirst())!;
        const attempt = (await db.query.ciAttempts.findFirst())!;
        const job = (await db.query.ciJobs.findFirst())!;
        expect(await heartbeat(db, runner, attempt, job, NOW)).toEqual({ action: 'continue' });
      }
      release();
      const count = await sweep;
      const attempt = await db.query.ciAttempts.findFirst();
      console.log('EXPECTED: running / 0 lost; ACTUAL:', attempt?.status, '/', count);
      console.log(attempt?.status === 'running' && count === 0 ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
      expect(attempt).toMatchObject({ status: 'running', leaseExpiresAt: NOW + 60_000 });
      expect(await db.query.ciJobs.findFirst()).toMatchObject({ status: 'running', currentAttemptId: 1 });
      expect(count).toBe(0);
    } finally { release(); await sweep.catch(() => undefined); spy.mockRestore(); }
  });
}
