import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployments, scheduledJobs, services, users, type DB } from '@ninedeploy/db';
const audit = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
vi.mock('../../src/lib/audit.js', () => ({ audit }));
vi.mock('../../src/modules/volumeBackups.js', () => ({ backupServiceVolumes: vi.fn() }));
const { runJob } = await import('../../src/lib/jobRunner.js');
const { MAX_QUEUED_PER_SERVICE: MAX } = await import('../../src/lib/deployQueue.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');
let db: DB;
beforeEach(async () => {
  audit.mockClear(); db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'queue-owner@example.com', passwordHash: 'synthetic', isInstanceOperator: true });
  await db.insert(services).values({ id: 1, name: 'queue fixture', slug: 'queue-fixture', type: 'docker', ownerUserId: 1 });
  await db.insert(scheduledJobs).values([1, 2].map(id => ({ id, serviceId: 1, name: `job-${id}`, cron: '* * * * *', kind: 'deploy' as const, enabled: true })));
});
afterEach(() => closeMigratedDb(db));
async function seed(status: 'queued' | 'awaiting_ci', count = MAX) {
  await db.insert(deployments).values(Array.from({ length: count }, () => ({ serviceId: 1, status, trigger: 'user' as const, message: 'capacity fixture' })));
}
for (const status of ['queued', 'awaiting_ci'] as const) {
  it(`a full ${status} service queue skips a scheduled deploy`, async () => {
    await seed(status); await runJob(db, 1, { scheduled: true });
    expect(await db.select().from(deployments)).toHaveLength(MAX);
    expect(audit.mock.calls.some(call => call[2] === 'job.deploy_skipped')).toBe(true);
  });
}
it('different jobs cannot both claim the last service slot', async () => {
  await seed('queued', MAX - 1);
  let enter!: () => void; let release!: () => void; let reads = 0;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const original = db.query.deployments.findMany.bind(db.query.deployments);
  const query = vi.spyOn(db.query.deployments, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => (async () => {
    const rows = await original(...args); if (++reads === 2) enter(); await blocked; return rows;
  })()) as typeof original);
  const pending = Promise.all([runJob(db, 1, { scheduled: true }), runJob(db, 2, { scheduled: true })]);
  try {
    await Promise.race([entered, pending.then(() => { throw new Error('jobs finished before both capacity reads'); })]);
    release(); await pending;
    const rows = await db.select().from(deployments);
    expect(rows).toHaveLength(MAX);
    expect(rows.filter(row => row.trigger === 'schedule')).toHaveLength(1);
    expect(audit.mock.calls.filter(call => call[2] === 'job.deploy_skipped')).toHaveLength(1);
  } finally { release(); await pending.catch(() => undefined); query.mockRestore(); }
});
