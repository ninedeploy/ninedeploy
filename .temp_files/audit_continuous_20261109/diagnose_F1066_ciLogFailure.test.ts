import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ciAttempts, ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
const fault = vi.hoisted(() => ({ mode: 'none' as 'none' | 'before' | 'partial' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
    const mode = fault.mode; fault.mode = 'none';
    if (mode === 'before') throw new Error('synthetic append failure');
    if (mode === 'partial') {
      const bytes = Buffer.from(args[1] as string);
      fs.appendFileSync(args[0], bytes.subarray(0, Math.floor(bytes.length / 2)));
      throw new Error('synthetic partial append');
    }
    return fs.appendFileSync(...args);
  } };
});
const { appendLog, logFile, readLog } = await import('../../apps/server/src/lib/ci.js');
const { closeMigratedDb, migratedDb } = await import('../../apps/server/test/lib/githubAppKit.js');
let db: DB; let jobId = 900_000;
beforeEach(async () => {
  fault.mode = 'none'; jobId++; db = await migratedDb();
  await db.insert(services).values({ id: 1, name: 'failure fixture', slug: 'failure-fixture', type: 'docker' });
  await db.insert(ciRunners).values({ id: 1, name: 'runner', tokenHash: 'fixture' });
  await db.insert(ciJobs).values({ id: jobId, serviceId: 1, image: 'alpine', script: 'true', status: 'running', attempts: 1, currentAttemptId: 1 });
  await db.insert(ciAttempts).values({ id: 1, jobId, runnerId: 1, number: 1, leaseHash: 'fixture', leaseExpiresAt: 1_800_000_000_000 });
});
afterEach(() => { fault.mode = 'none'; closeMigratedDb(db); });
const row = async () => (await db.query.ciAttempts.findFirst())!;
it('accepted file bytes and sequential metadata agree', async () => {
  await appendLog(db,await row(),1,'prefix\n');
  expect(await row()).toMatchObject({logSeq:1,logBytes:7}); expect(readLog(jobId,1)).toBe('prefix\n');
});
for (const mode of ['before','partial'] as const) it(`${mode} append failure preserves prior bytes and sequence for retry`, async () => {
  await appendLog(db,await row(),1,'prefix\n'); fault.mode = mode;
  try { await appendLog(db,await row(),2,'chunk\n'); } catch (err) { console.log('ROLLBACK_DIAGNOSTIC:', err); throw err; }
  const failed = await row(); const beforeRetry = readLog(jobId,1);
  const retry = await appendLog(db,await row(),2,'chunk\n');
  console.log('EXPECTED: seq1 / prefix / retry stored; ACTUAL:', failed.logSeq, '/', JSON.stringify(beforeRetry), '/', retry.stored);
  console.log(failed.logSeq === 1 && beforeRetry === 'prefix\n' && retry.stored ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
  expect(failed).toMatchObject({logSeq:1,logBytes:7}); expect(beforeRetry).toBe('prefix\n'); expect(retry).toEqual({stored:true});
  expect(readLog(jobId,1)).toBe('prefix\nchunk\n'); expect(await row()).toMatchObject({logSeq:2,logBytes:13});
});
it('a real directory-path blocker does not consume the first sequence', async () => {
  const directory = dirname(logFile(jobId,1)); mkdirSync(dirname(directory),{recursive:true}); writeFileSync(directory,'synthetic blocker');
  try { await expect(appendLog(db,await row(),1,'retry\n')).rejects.toThrow(); } finally { unlinkSync(directory); }
  const failed = await row(); const retry = await appendLog(db,await row(),1,'retry\n');
  console.log('EXPECTED: seq0 / retry stored; ACTUAL:', failed.logSeq, '/', retry.stored);
  console.log(failed.logSeq === 0 && retry.stored ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
  expect(failed).toMatchObject({logSeq:0,logBytes:0}); expect(retry).toEqual({stored:true}); expect(readLog(jobId,1)).toBe('retry\n');
});
