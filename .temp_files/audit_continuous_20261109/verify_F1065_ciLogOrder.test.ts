import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ciAttempts, ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
import { appendLog, cancelJob, readLog } from '../../apps/server/src/lib/ci.js';
import { closeMigratedDb, migratedDb } from '../../apps/server/test/lib/githubAppKit.js';
let db: DB; let jobId = 700_000;
beforeEach(async () => {
  jobId++; db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'independent', slug: 'independent', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'fixture' });
  await db.insert(ciJobs).values({ id: jobId, serviceId: 1, image: 'alpine', script: 'true', status: 'running', attempts: 1, currentAttemptId: 1 });
  await db.insert(ciAttempts).values({ id: 1, jobId, runnerId: 1, number: 1, leaseHash: 'fixture', leaseExpiresAt: 1_800_000_000_000 });
});
afterEach(() => closeMigratedDb(db));
const snapshot = async () => (await db.query.ciAttempts.findFirst())!;
function holdFirstMetadata() {
  let enter!: () => void; let release!: () => void; let used = false;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = db.$client.execute.bind(db.$client);
  const spy = vi.spyOn(db.$client,'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
    const stmt = args[0]; const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    const held = !used && /update "ci_attempts" set "log_(bytes|seq)"/i.test(sql); if (held) used = true;
    const result = await original(...args); if (held) { enter(); await gate; } return result;
  }) as typeof original);
  return { ready, release, close: () => { release(); spy.mockRestore(); } };
}
async function checked(expected: string, seq: number) {
  const actual = readLog(jobId,1); expect(actual).toBe(expected);
  expect(await snapshot()).toMatchObject({ logSeq: seq, logBytes: Buffer.byteLength(expected) });
  console.log('EXPECTED:', JSON.stringify(expected), 'ACTUAL:', JSON.stringify(actual), 'FIX VERIFIED');
}
it('five overlapping copies acknowledge one append and four replays', async () => {
  const row = await snapshot();
  const results = await Promise.all(Array.from({ length: 5 }, () => appendLog(db,row,1,'once\n')));
  expect(results.filter(r => r.stored)).toHaveLength(1); await checked('once\n',1);
});
it('ordered different sequences may use the same pre-request snapshot', async () => {
  const row = await snapshot();
  expect(await Promise.all([appendLog(db,row,1,'a'),appendLog(db,row,2,'b')])).toEqual([{stored:true},{stored:true}]);
  await checked('ab',2);
});
it('gated first completion preserves file order and accounting', async () => {
  const gate = holdFirstMetadata(); const first = appendLog(db,await snapshot(),1,'alpha\n');
  let second: Promise<unknown> | undefined;
  try {
    await gate.ready; second = appendLog(db,await snapshot(),2,'beta\n');
    for (let i=0;i<10;i++) await snapshot();
    gate.release(); await Promise.all([first,second]); await checked('alpha\nbeta\n',2);
  } finally { gate.release(); await first.catch(() => undefined); await second?.catch(() => undefined); gate.close(); }
});
it('another file can complete while the first file writer is gated', async () => {
  await db.insert(ciJobs).values({ id: jobId+1000, serviceId: 1, image: 'alpine', script: 'true', status: 'running', attempts: 1, currentAttemptId: 2 });
  await db.insert(ciAttempts).values({ id: 2, jobId: jobId+1000, runnerId: 1, number: 1, leaseHash: 'other', leaseExpiresAt: 1_800_000_000_000 });
  const rows = await db.query.ciAttempts.findMany(); const row1 = rows.find(r=>r.id===1)!; const row2 = rows.find(r=>r.id===2)!;
  const gate = holdFirstMetadata(); const first = appendLog(db,row1,1,'first');
  try {
    await gate.ready; expect(await appendLog(db,row2,1,'other')).toEqual({stored:true});
    expect(readLog(jobId+1000,1)).toBe('other'); gate.release(); await first; await checked('first',1);
  } finally { gate.release(); await first.catch(() => undefined); gate.close(); }
});
it('a gap rejection releases the same file for the proper next chunk', async () => {
  const row = await snapshot(); await expect(appendLog(db,row,2,'gap')).rejects.toMatchObject({status:409});
  await appendLog(db,row,1,'good'); await checked('good',1);
});
it('a fresh-state read failure releases the file queue', async () => {
  const row = await snapshot(); const spy = vi.spyOn(db.query.ciAttempts,'findFirst').mockRejectedValueOnce(new Error('synthetic read failure'));
  try { await expect(appendLog(db,row,1,'ignored')).rejects.toThrow('synthetic read failure'); } finally { spy.mockRestore(); }
  await appendLog(db,row,1,'retry'); await checked('retry',1);
});
it('a queued writer rereads cancellation and appends no late second chunk', async () => {
  const gate = holdFirstMetadata(); const first = appendLog(db,await snapshot(),1,'admitted');
  let second: Promise<unknown> | undefined;
  try {
    await gate.ready; second = appendLog(db,await snapshot(),2,'late').then(()=> 'accepted',err=> (err as {status:number}).status);
    expect(await cancelJob(db,jobId,null)).toBe(true); gate.release(); await first;
    expect(await second).toBe(409); await checked('admitted',1);
  } finally { gate.release(); await first.catch(() => undefined); await second?.catch(() => undefined); gate.close(); }
});
it('a previously captured running snapshot does not append after cancellation', async () => {
  const row = await snapshot(); await cancelJob(db,jobId,null);
  await expect(appendLog(db,row,1,'late')).rejects.toMatchObject({status:409}); await checked('',0);
});
it('empty chunk and duplicate still advance once without bytes', async () => {
  const row = await snapshot(); expect(await appendLog(db,row,1,'')).toEqual({stored:true});
  expect(await appendLog(db,row,1,'')).toEqual({stored:false}); await checked('',1);
});
