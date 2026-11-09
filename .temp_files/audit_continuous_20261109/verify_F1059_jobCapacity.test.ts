import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployments, scheduledJobs, services, users, type DB } from '@ninedeploy/db';
const audit = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit }));
vi.mock('../../apps/server/src/modules/volumeBackups.js', () => ({ backupServiceVolumes: vi.fn() }));
const { runJob } = await import('../../apps/server/src/lib/jobRunner.js');
const { enqueueUserDeploy } = await import('../../apps/server/src/lib/deployQueue.js');
const { closeMigratedDb, migratedDb } = await import('../../apps/server/test/lib/githubAppKit.js');
let db: DB;
beforeEach(async () => {
  audit.mockClear(); db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'independent@example.com', passwordHash: 'synthetic', isInstanceOperator: true });
  await db.insert(services).values([1, 2].map(id => ({ id, name: `service-${id}`, slug: `service-${id}`, type: 'docker' as const, ownerUserId: 1 })));
  await db.insert(scheduledJobs).values([1, 2, 3, 4, 5].map(id => ({ id, serviceId: 1, name: `job-${id}`, cron: '* * * * *', kind: 'deploy' as const, enabled: true })));
});
afterEach(() => closeMigratedDb(db));
async function seed(queued: number, waiting: number, serviceId = 1) {
  const statuses = [...Array(queued).fill('queued'), ...Array(waiting).fill('awaiting_ci')];
  if (statuses.length) await db.insert(deployments).values(statuses.map(status => ({ serviceId, status, trigger: 'user' as const })));
}
async function checked(count: number, scheduled: number) {
  const rows = (await db.select().from(deployments)).filter(row => row.serviceId === 1);
  expect(rows).toHaveLength(count);
  expect(rows.filter(row => row.trigger === 'schedule')).toHaveLength(scheduled);
  console.log('EXPECTED:', count, 'ACTUAL:', rows.length, 'FIX VERIFIED');
}
for (const [queued, waiting] of [[50, 0], [0, 50], [25, 25], [0, 0], [24, 25]]) {
  it(`mixed capacity ${queued}+${waiting}`, async () => {
    await seed(queued!, waiting!); await runJob(db, 1, { scheduled: true });
    const accepted = queued! + waiting! < 50;
    await checked(queued! + waiting! + Number(accepted), Number(accepted));
  });
}
it('another service and terminal/running rows do not consume this capacity', async () => {
  await seed(50, 0, 2);
  await db.insert(deployments).values(['running', 'success', 'failed', 'cancelled'].map(status => ({ serviceId: 1, status: status as 'running', trigger: 'user' as const })));
  await runJob(db, 1, { scheduled: true }); await checked(5, 1);
});
for (const contenders of [2, 5]) it(`${contenders} jobs share the last slot`, async () => {
  await seed(25, 24);
  let arrived!: () => void; let release!: () => void; let reads = 0;
  const all = new Promise<void>(resolve => { arrived = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.query.deployments.findMany.bind(db.query.deployments);
  const spy = vi.spyOn(db.query.deployments, 'findMany').mockImplementation(((...args: Parameters<typeof original>) => (async () => {
    const rows = await original(...args); if (++reads === contenders) arrived(); await gate; return rows;
  })()) as typeof original);
  const pending = Promise.all(Array.from({ length: contenders }, (_, i) => runJob(db, i + 1, { scheduled: true })));
  try {
    await Promise.race([all, pending.then(() => { throw new Error('barrier not reached'); })]);
    release(); await pending; await checked(50, 1);
    expect(audit.mock.calls.filter(call => call[2] === 'job.deploy_skipped')).toHaveLength(contenders - 1);
  } finally { release(); await pending.catch(() => undefined); spy.mockRestore(); }
});
it('user admission fills the slot while a scheduled capacity read is suspended', async () => {
  await seed(49, 0);
  let arrived!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { arrived = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.query.deployments.findMany.bind(db.query.deployments);
  const spy = vi.spyOn(db.query.deployments, 'findMany').mockImplementationOnce(((...args: Parameters<typeof original>) => (async () => {
    const rows = await original(...args); arrived(); await gate; return rows;
  })()) as typeof original);
  const pending = runJob(db, 1, { scheduled: true });
  try {
    await entered;
    await enqueueUserDeploy(db, { id: 1, isOperator: true }, { id: 1, type: 'docker' }, { message: 'user wins' });
    release(); await pending; await checked(50, 0);
    expect(audit.mock.calls.some(call => call[2] === 'job.deploy_skipped')).toBe(true);
  } finally { release(); await pending.catch(() => undefined); spy.mockRestore(); }
});
it('an unrelated insertion failure propagates and releases the job for retry', async () => {
  await db.$client.execute("CREATE TRIGGER fail_scheduled BEFORE INSERT ON deployments BEGIN SELECT RAISE(ABORT, 'synthetic unrelated failure'); END");
  await expect(runJob(db, 1, { scheduled: true })).rejects.toThrow();
  expect(audit.mock.calls.some(call => call[2] === 'job.deploy_skipped')).toBe(false);
  await db.$client.execute('DROP TRIGGER fail_scheduled');
  await runJob(db, 1, { scheduled: true }); await checked(1, 1);
});
