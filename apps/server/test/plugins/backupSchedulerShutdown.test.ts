import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
interface Gate { entered: () => void; wait: Promise<void> }
const state=vi.hoisted(()=>({calls:[] as number[],gates:new Map<string,Gate>()}));
async function waitAt(site:string){const gate=state.gates.get(site);if(gate){state.gates.delete(site);gate.entered();await gate.wait;}}
vi.mock('../../src/lib/databaseRuntime.js',()=>({databaseRuntime:(_db:unknown,row:{id:number})=>({backup:async()=>{state.calls.push(row.id);await waitAt('dump');}})}));
vi.mock('../../src/lib/audit.js',()=>({audit:vi.fn(async()=>{})}));
const {default:plugin}=await import('../../src/plugins/backupScheduler.js');
let app:FastifyInstance|undefined;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']});vi.setSystemTime(new Date(2026,10,10,0,0));});
afterEach(async()=>{if(app)await app.close();app=undefined;state.calls=[];state.gates.clear();vi.useRealTimers();});
const turn=()=>new Promise<void>(done=>setImmediate(done));
function block(site:string){let enter!:()=>void,release!:()=>void;const reached=new Promise<void>(done=>enter=done),wait=new Promise<void>(done=>release=done);state.gates.set(site,{entered:enter,wait});return {reached,async finish(){release();await turn();}};}
async function boot(policy=true,count=1){
 const rows=Array.from({length:count},(_,i)=>({id:i+5,name:`Fixture${i}`,slug:`fixture-${i}`,engine:'postgres',status:'running',serverId:null,createdAt:new Date(2026,10,9)}));
 const db={
  select:()=>({from:async()=>{await waitAt('select');return rows;}}),
  insert:()=>({values:()=>({returning:async()=>[{id:1}]})}),
  delete:()=>({where:async()=>undefined}),
  query:{
   databaseBackupPolicies:{findMany:async()=>{await waitAt('policy');return policy?[{databaseId:5,cron:'*/2 * * * *',enabled:true,localOnly:true,retainCount:7,retainRemoteCount:null,destinationId:null}]:[];}},
   databases:{findFirst:async()=>{await waitAt('database');return rows[0];}},
   backups:{findMany:async()=>[]},
  },
 };
 app=Fastify({logger:false});app.decorate('db',db as never);await app.register(plugin);await app.ready();return app;
}
it('control: open policy scheduler admits its due backup',async()=>{await boot();await vi.advanceTimersByTimeAsync(2*60_000);expect(state.calls).toEqual([5]);});
it('control: open daily scheduler admits its due backup',async()=>{await boot(false);await vi.advanceTimersByTimeAsync(5*60_000);expect(state.calls).toEqual([5]);});
for(const site of ['policy','database'])it(`close while awaiting ${site} prevents later policy backup admission`,async()=>{const server=await boot(),gate=block(site);try{await vi.advanceTimersByTimeAsync(2*60_000);await gate.reached;await server.close();await gate.finish();expect(state.calls).toEqual([]);}finally{await gate.finish();}});
it('close while daily database enumeration waits prevents later backup admission',async()=>{const server=await boot(false),gate=block('select');try{await vi.advanceTimersByTimeAsync(5*60_000);await gate.reached;await server.close();await gate.finish();expect(state.calls).toEqual([]);}finally{await gate.finish();}});
it('close during the first daily dump does not admit the next database',async()=>{const server=await boot(false,2),gate=block('dump');try{await vi.advanceTimersByTimeAsync(5*60_000);await gate.reached;expect(state.calls).toEqual([5]);await server.close();await gate.finish();expect(state.calls).toEqual([5]);}finally{await gate.finish();}});
it('an already-admitted policy backup may settle after close without another admission',async()=>{const server=await boot(),gate=block('dump');try{await vi.advanceTimersByTimeAsync(2*60_000);await gate.reached;await server.close();await gate.finish();await vi.advanceTimersByTimeAsync(4*60_000);expect(state.calls).toEqual([5]);}finally{await gate.finish();}});
it('the existing in-flight guard prevents overlapping policy dumps',async()=>{await boot();const gate=block('dump');try{await vi.advanceTimersByTimeAsync(2*60_000);await gate.reached;await vi.advanceTimersByTimeAsync(2*60_000);expect(state.calls).toEqual([5]);await gate.finish();await vi.advanceTimersByTimeAsync(2*60_000);expect(state.calls).toEqual([5,5]);}finally{await gate.finish();}});
it('close before a due timer admits no backup',async()=>{const server=await boot();await server.close();await vi.advanceTimersByTimeAsync(10*60_000);expect(state.calls).toEqual([]);});
