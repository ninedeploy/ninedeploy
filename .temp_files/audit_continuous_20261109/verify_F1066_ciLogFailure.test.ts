import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ciAttempts, ciJobs, ciRunners, services, type DB } from '@ninedeploy/db';
const fault = vi.hoisted(() => ({ append: 'none' as 'none'|'before'|'partial'|'replace', truncate: false, handles: new Map<number,string>() }));
vi.mock('node:fs',async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args); if (String(args[0]).endsWith('.log')) fault.handles.set(fd,String(args[0])); return fd;
    },
    closeSync: (fd: number) => { try { return fs.closeSync(fd); } finally { fault.handles.delete(fd); } },
    ftruncateSync: (...args: Parameters<typeof fs.ftruncateSync>) => { if(fault.truncate) throw new Error('synthetic truncate failure'); return fs.ftruncateSync(...args); },
    appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
      const mode = fault.append; fault.append = 'none';
      if(mode==='before') throw new Error('synthetic write failure');
      if(mode==='partial' || mode==='replace') {
        const bytes=Buffer.from(args[1] as string); fs.appendFileSync(args[0],bytes.subarray(0,Math.floor(bytes.length/2)));
        if(mode==='replace') { const file=fault.handles.get(args[0] as number)!; fs.renameSync(file,file+'.retained'); fs.writeFileSync(file,'foreign sentinel'); }
        throw new Error('synthetic partial write');
      }
      return fs.appendFileSync(...args);
    },
  };
});
const { appendLog, cancelJob, logFile, readLog } = await import('../../apps/server/src/lib/ci.js');
const { closeMigratedDb, migratedDb } = await import('../../apps/server/test/lib/githubAppKit.js');
let db: DB; let jobId=1_100_000;
beforeEach(async () => {
  fault.append='none'; fault.truncate=false; expect(fault.handles.size).toBe(0); jobId++; db=await migratedDb();
  await db.insert(services).values({id:1,name:'independent',slug:'independent',type:'docker'});
  await db.insert(ciRunners).values({id:1,name:'runner',tokenHash:'fixture'});
  await db.insert(ciJobs).values({id:jobId,serviceId:1,image:'alpine',script:'true',status:'running',attempts:1,currentAttemptId:1});
  await db.insert(ciAttempts).values({id:1,jobId,runnerId:1,number:1,leaseHash:'fixture',leaseExpiresAt:1_800_000_000_000});
});
afterEach(() => { fault.append='none';fault.truncate=false;closeMigratedDb(db);expect(fault.handles.size).toBe(0); });
const row=async()=>(await db.query.ciAttempts.findFirst())!;
async function checked(bytes:string,seq:number) {
  expect(readLog(jobId,1)).toBe(bytes); expect(await row()).toMatchObject({logSeq:seq,logBytes:Buffer.byteLength(bytes)});
  expect(fault.handles.size).toBe(0); console.log('EXPECTED:',seq,JSON.stringify(bytes),'ACTUAL:',(await row()).logSeq,JSON.stringify(readLog(jobId,1)),'FIX VERIFIED');
}
function holdMetadata(rollback=false, fail=false) {
  let enter!:()=>void;let release!:()=>void;let used=false;
  const ready=new Promise<void>(resolve=>{enter=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  const original=db.$client.execute.bind(db.$client);
  const spy=vi.spyOn(db.$client,'execute').mockImplementation((async(...args:Parameters<typeof original>)=>{
    const stmt=args[0];const sql=typeof stmt==='string'?stmt:stmt.sql;
    const metadata=/update "ci_attempts" set "log_(bytes|seq)"/i.test(sql);
    const literal=sql.includes('"log_bytes" = ?')&&!sql.includes(' + ');
    const held=!used&&metadata&&(rollback?literal:!literal);if(held){used=true;enter();await gate;if(fail)throw new Error('synthetic database failure');}
    return original(...args);
  }) as typeof original);
  return {ready,release,close:()=>{release();spy.mockRestore();}};
}
it('first append failure leaves sequence zero and permits retry',async()=>{
  fault.append='before';await expect(appendLog(db,await row(),1,'retry')).rejects.toThrow('synthetic write failure');await checked('',0);
  await appendLog(db,await row(),1,'retry');await checked('retry',1);
});
it('repeated partial UTF8 writes preserve byte boundaries and retry once',async()=>{
  let expected='ğ🚀\n';await appendLog(db,await row(),1,expected);
  for(let seq=2;seq<=4;seq++){
    fault.append='partial';await expect(appendLog(db,await row(),seq,'é🧪\n')).rejects.toThrow('synthetic partial write');await checked(expected,seq-1);
    await appendLog(db,await row(),seq,'é🧪\n');expected+='é🧪\n';await checked(expected,seq);
  }
});
it('real parent blocker fails before metadata reservation',async()=>{
  const directory=dirname(logFile(jobId,1));mkdirSync(dirname(directory),{recursive:true});writeFileSync(directory,'blocker');
  try{await expect(appendLog(db,await row(),1,'good')).rejects.toThrow();await checked('',0);}finally{unlinkSync(directory);}
  await appendLog(db,await row(),1,'good');await checked('good',1);
});
it('database admission failure closes the opened file without appending',async()=>{
  await appendLog(db,await row(),1,'prefix');const gate=holdMetadata(false,true);const pending=appendLog(db,await row(),2,'ignored').catch(err=>err);
  try{await gate.ready;gate.release();expect(await pending).toMatchObject({cause:expect.any(Error)});await checked('prefix',1);}finally{gate.release();await pending;gate.close();}
  await appendLog(db,await row(),2,'retry');await checked('prefixretry',2);
});
it('cancellation before admission CAS closes the descriptor without bytes',async()=>{
  await appendLog(db,await row(),1,'prefix');const gate=holdMetadata();const pending=appendLog(db,await row(),2,'late').catch(err=>err);
  try{await gate.ready;await cancelJob(db,jobId,null);gate.release();expect(await pending).toMatchObject({status:409});await checked('prefix',1);}finally{gate.release();await pending;gate.close();}
});
it('a queued retry waits for failed append rollback before rereading sequence',async()=>{
  await appendLog(db,await row(),1,'prefix');const gate=holdMetadata(true);fault.append='partial';
  const failed=appendLog(db,await row(),2,'badbad').catch(err=>err);let retry:Promise<unknown>|undefined;
  try{await gate.ready;retry=appendLog(db,await row(),2,'good');gate.release();expect(await failed).toBeInstanceOf(Error);expect(await retry).toEqual({stored:true});await checked('prefixgood',2);}
  finally{gate.release();await failed;await retry?.catch(()=>undefined);gate.close();}
});
it('truncate failure is surfaced with the write failure and closes all handles',async()=>{
  await appendLog(db,await row(),1,'prefix');fault.append='partial';fault.truncate=true;
  const error=await appendLog(db,await row(),2,'broken').catch(err=>err);
  expect(error).toBeInstanceOf(AggregateError);expect(error.errors).toHaveLength(2);expect(fault.handles.size).toBe(0);
  console.log('FIX VERIFIED: rollback error surfaced; partial bytes remain a dual-failure boundary');
});
it('database rollback failure is surfaced and closes all handles',async()=>{
  await appendLog(db,await row(),1,'prefix');const gate=holdMetadata(true,true);fault.append='partial';const pending=appendLog(db,await row(),2,'broken').catch(err=>err);
  try{await gate.ready;gate.release();const error=await pending;expect(error).toBeInstanceOf(AggregateError);expect(error.errors).toHaveLength(2);expect(fault.handles.size).toBe(0);console.log('FIX VERIFIED: database rollback failure surfaced; reservation may remain');}
  finally{gate.release();await pending;gate.close();}
});
it('rollback never truncates a replacement file at the same path',async()=>{
  await appendLog(db,await row(),1,'prefix');fault.append='replace';const error=await appendLog(db,await row(),2,'broken').catch(err=>err);
  expect(error).toBeInstanceOf(AggregateError);expect(String(error.errors[1])).toContain('file changed');
  expect(readFileSync(logFile(jobId,1),'utf8')).toBe('foreign sentinel');expect(fault.handles.size).toBe(0);console.log('FIX VERIFIED: replacement file preserved');
});
it('an empty chunk does not need the blocked directory to be writable',async()=>{
  const directory=dirname(logFile(jobId,1));mkdirSync(dirname(directory),{recursive:true});writeFileSync(directory,'blocker');
  try{expect(await appendLog(db,await row(),1,'')).toEqual({stored:true});await checked('',1);}finally{unlinkSync(directory);}
});
