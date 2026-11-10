import {createServer} from 'node:http';
import {once} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
import {logDrainBatches,logDrains} from '@ninedeploy/db';
vi.hoisted(()=>{process.env['NINEDEPLOY_MASTER_KEY']='ab'.repeat(32);});
const {observabilityDb}=await import('../../apps/server/test/fixtures/observability.js');
const {encrypt}=await import('../../apps/server/src/lib/crypto.js');
const {shipLogsOnce,logDrainBinding}=await import('../../apps/server/src/engine/logShipper.js');
const {dispatchLogBatch}=await import('../../apps/server/src/engine/logDrainManager.js');
const fixtures:Array<Awaited<ReturnType<typeof observabilityDb>>>=[];
afterEach(()=>{fixtures.splice(0).forEach(f=>f.close());});
const at=new Date('2026-11-10T12:00:00Z'),entries=[{timestamp:at.toISOString(),service:'web',container:'web-7',line:'owned durable fixture'}];
async function queue(fetchImpl:(url:string,init?:RequestInit)=>Promise<Response>,url='https://elastic.example.test/logs-fixture'){const f=await observabilityDb();fixtures.push(f);const [drain]=await f.db.insert(logDrains).values({name:'elastic fixture',type:'elasticsearch',url}).returning();const payload=encrypt(JSON.stringify(entries));await f.db.insert(logDrainBatches).values({drainId:drain!.id,serviceId:1,runtimeKey:'owned-fixture',binding:logDrainBinding(drain!),payloadEncrypted:payload,payloadBytes:Buffer.byteLength(payload),entryCount:1,nextAttemptAt:at,createdAt:at});const result=await shipLogsOnce(f.db,{readLogs:async()=>[],dispatch:(target,batch)=>dispatchLogBatch(target,batch,fetchImpl),now:()=>at});return {result,rows:await f.db.select().from(logDrainBatches)};}
it('retains filtered bulk failures without a top-level errors flag',async()=>{const outcome=await queue(async url=>{expect(new URL(url).searchParams.get('filter_path')).toBe('items.*.error');return new Response(JSON.stringify({items:[{create:{error:{type:'mapper_parsing_exception',reason:'owned fixture mapping failure'}}}]}));},'https://elastic.example.test/logs-fixture?filter_path=items.*.error');console.log('EXPECTED: filtered item error keeps one queued batch, shipped0; ACTUAL:',{pending:outcome.rows.length,result:outcome.result});const bad=outcome.rows.length!==1||outcome.result.shipped!==0;console.log(bad?'PROBLEM CONFIRMED':'PROBLEM NOT REPRODUCED');expect(outcome.rows).toHaveLength(1);expect(outcome.result).toMatchObject({shipped:0,failed:1});});
it('control: explicit errors true is already refused',async()=>{const outcome=await queue(async()=>new Response(JSON.stringify({errors:true,items:[{create:{error:{reason:'owned control rejection'}}}]})));expect(outcome.rows).toHaveLength(1);expect(outcome.result).toMatchObject({shipped:0,failed:1});});
