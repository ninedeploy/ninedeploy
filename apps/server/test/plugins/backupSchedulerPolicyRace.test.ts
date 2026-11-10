import Fastify,{type FastifyInstance} from 'fastify';import {afterEach,beforeEach,expect,it,vi} from 'vitest';import {databaseBackupPolicies,databases,type DB} from '@ninedeploy/db';import {eq} from 'drizzle-orm';import {migratedDb,closeMigratedDb} from '../lib/githubAppKit.js';
const state=vi.hoisted(()=>({backups:[] as number[]}));vi.mock('../../src/lib/databaseRuntime.js',()=>({databaseRuntime:(_db:unknown,row:{id:number})=>({backup:async()=>{state.backups.push(row.id);}})}));vi.mock('../../src/lib/audit.js',()=>({audit:vi.fn(async()=>{})}));
const {default:plugin}=await import('../../src/plugins/backupScheduler.js');const {notifyBackupPolicyChanged}=await import('../../src/lib/backupPolicy.js');let db:DB,app:FastifyInstance;
beforeEach(async()=>{db=await migratedDb();await db.insert(databases).values({id:5,name:'Fixture',slug:'fixture',engine:'postgres',passwordEncrypted:'fixture',status:'running'});await db.insert(databaseBackupPolicies).values({databaseId:5,cron:'*/10 * * * *',enabled:true,localOnly:true});vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']});vi.setSystemTime(new Date(2026,10,10,0,0,0));app=Fastify({logger:false});app.decorate('db',db);await app.register(plugin);await app.ready();});
afterEach(async()=>{if(app)await app.close();vi.useRealTimers();if(db)closeMigratedDb(db);state.backups=[];vi.restoreAllMocks();});
it('control: unchanged ten-minute policy does not run at minute two',async()=>{await vi.advanceTimersByTimeAsync(2*60_000);expect(state.backups).toEqual([]);});
it('F1106: an older gated policy snapshot cannot override the newer cron',async()=>{let release!:()=>void,reached!:()=>void;const blocked=new Promise<void>(done=>release=done),captured=new Promise<void>(done=>reached=done);const table=db.query.databaseBackupPolicies,read=table.findMany.bind(table);let block=true;const spy=vi.spyOn(table,'findMany').mockImplementation(async(...args:Parameters<typeof read>)=>{const rows=await read(...args);if(block){block=false;reached();await blocked;}return rows;});await db.update(databaseBackupPolicies).set({cron:'*/2 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5));notifyBackupPolicyChanged(5);await captured;await db.update(databaseBackupPolicies).set({cron:'*/10 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5));let published!:()=>void;const armed=new Promise<void>(done=>published=done);const info=vi.spyOn(app.log,'info').mockImplementation((...args:unknown[])=>{if(args[1]==='backup policy re-armed')published();});notifyBackupPolicyChanged(5);await armed;info.mockRestore();release();await new Promise<void>(done=>setImmediate(done));try{await vi.advanceTimersByTimeAsync(2*60_000);console.log('EXPECTED backups:[] ACTUAL:',state.backups);console.log(state.backups.length?'PROBLEM CONFIRMED':'PROBLEM NOT REPRODUCED');expect(state.backups).toEqual([]);}finally{release();spy.mockRestore();}});
function gateRead() {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(done => release = done), captured = new Promise<void>(done => reached = done);
  const table = db.query.databaseBackupPolicies, read = table.findMany.bind(table);
  let first = true;
  const spy = vi.spyOn(table, 'findMany').mockImplementation(async (...args: Parameters<typeof read>) => {
    const rows = await read(...args); if (first) { first = false; reached(); await gate; } return rows;
  });
  return { captured, spy, async finish() { release(); await new Promise<void>(done => setImmediate(done)); } };
}
async function save(cron: string, databaseId = 5, enabled = true) {
  await db.update(databaseBackupPolicies).set({ cron, enabled }).where(eq(databaseBackupPolicies.databaseId, databaseId));
  let published!: () => void; const done = new Promise<void>(resolve => published = resolve);
  const info = vi.spyOn(app.log, 'info').mockImplementation((...args: unknown[]) => {
    if (args[1] === 'backup policy re-armed' && (args[0] as {databaseId?: number})?.databaseId === databaseId) published();
  });
  try { notifyBackupPolicyChanged(databaseId); await done; } finally { info.mockRestore(); }
}
it('independent database changes do not cancel each other', async () => {
  await db.insert(databases).values({id:6,name:'Other',slug:'other',engine:'postgres',passwordEncrypted:'fixture',status:'running'});
  await db.insert(databaseBackupPolicies).values({databaseId:6,cron:'*/10 * * * *',enabled:true,localOnly:true});
  const gate = gateRead();
  try {
    await db.update(databaseBackupPolicies).set({cron:'*/2 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5)); notifyBackupPolicyChanged(5); await gate.captured;
    await save('*/2 * * * *',6); await gate.finish(); await vi.advanceTimersByTimeAsync(2*60_000); expect(state.backups.sort()).toEqual([5,6]);
  } finally { await gate.finish(); gate.spy.mockRestore(); }
});
it('a stale enabled snapshot cannot rearm a disabled policy', async () => {
  const gate = gateRead();
  try {
    await db.update(databaseBackupPolicies).set({cron:'*/2 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5)); notifyBackupPolicyChanged(5); await gate.captured;
    await save('*/10 * * * *',5,false); await gate.finish(); const reads = gate.spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2*60_000); expect(state.backups).toEqual([]); expect(gate.spy.mock.calls.length).toBe(reads);
  } finally { await gate.finish(); gate.spy.mockRestore(); }
});
it('an old periodic refresh cannot replace a newer saved cron', async () => {
  await save('*/20 * * * *');
  const gate = gateRead();
  try {
    // The callback starts before a newer save; no wall-clock sleep is used.
    await vi.advanceTimersByTimeAsync(15*60_000); await gate.captured;
    await save('*/30 * * * *'); await gate.finish(); state.backups=[];
    await vi.advanceTimersByTimeAsync(5*60_000); expect(state.backups).toEqual([]);
  } finally { await gate.finish(); gate.spy.mockRestore(); }
});
it('a pending changed-event read cannot publish after close', async () => {
  const gate = gateRead();
  try {
    await db.update(databaseBackupPolicies).set({cron:'*/2 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5)); notifyBackupPolicyChanged(5); await gate.captured;
    await app.close(); await gate.finish(); await vi.advanceTimersByTimeAsync(2*60_000); expect(state.backups).toEqual([]);
  } finally { await gate.finish(); gate.spy.mockRestore(); }
});
it('a failed save read leaves the existing cron armed until a successful refresh', async () => {
  const table=db.query.databaseBackupPolicies; const spy=vi.spyOn(table,'findMany').mockRejectedValueOnce(new Error('fixture unavailable'));
  notifyBackupPolicyChanged(5); await new Promise<void>(done=>setImmediate(done)); spy.mockRestore();
  await vi.advanceTimersByTimeAsync(10*60_000); expect(state.backups).toEqual([5]);
});
it('a boot snapshot cannot overwrite a save published while startup is waiting', async () => {
  await app.close();
  await db.update(databaseBackupPolicies).set({cron:'*/2 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5));
  app=Fastify({logger:false}); app.decorate('db',db); app.register(plugin);
  const gate=gateRead(), ready=app.ready();
  try {
    await gate.captured; await save('*/10 * * * *'); await gate.finish(); await ready;
    await vi.advanceTimersByTimeAsync(2*60_000); expect(state.backups).toEqual([]);
  } finally { await gate.finish(); await ready; gate.spy.mockRestore(); }
});
it('a newer completed periodic refresh fences an older changed-event read', async () => {
  await save('*/20 * * * *'); const gate=gateRead();
  let fresh!:()=>void; const refreshed=new Promise<void>(done=>fresh=done);
  const implementation=gate.spy.getMockImplementation()!; let reads=0;
  gate.spy.mockImplementation(async(...args:Parameters<typeof implementation>)=>{const later=reads++>0;const rows=await implementation(...args);if(later)fresh();return rows;});
  try {
    await db.update(databaseBackupPolicies).set({cron:'*/2 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5));notifyBackupPolicyChanged(5);await gate.captured;
    await db.update(databaseBackupPolicies).set({cron:'*/30 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5));
    await vi.advanceTimersByTimeAsync(15*60_000); await refreshed; await new Promise<void>(done=>setImmediate(done)); await gate.finish(); state.backups=[];
    await vi.advanceTimersByTimeAsync(60_000); expect(state.backups).toEqual([]);
  } finally {await gate.finish();gate.spy.mockRestore();}
});
it('removing a policy during a full refresh still fences its older pending read', async () => {
  await save('*/20 * * * *'); const gate=gateRead();
  let fresh!:()=>void;const refreshed=new Promise<void>(done=>fresh=done);const implementation=gate.spy.getMockImplementation()!;let reads=0;
  gate.spy.mockImplementation(async(...args:Parameters<typeof implementation>)=>{const later=reads++>0;const rows=await implementation(...args);if(later)fresh();return rows;});
  try {
    await db.update(databaseBackupPolicies).set({cron:'*/2 * * * *'}).where(eq(databaseBackupPolicies.databaseId,5));notifyBackupPolicyChanged(5);await gate.captured;
    await db.delete(databaseBackupPolicies).where(eq(databaseBackupPolicies.databaseId,5));
    await vi.advanceTimersByTimeAsync(15*60_000);await refreshed;await new Promise<void>(done=>setImmediate(done));await gate.finish();const count=gate.spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);expect(gate.spy.mock.calls.length).toBe(count);expect(state.backups).toEqual([]);
  } finally {await gate.finish();gate.spy.mockRestore();}
});
