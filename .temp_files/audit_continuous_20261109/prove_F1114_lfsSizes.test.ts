import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../../apps/server/src/lib/egressGuard.js',()=>({guardedFetch:h.fetch}));
const {fetchLfsObjects}=await import('../../apps/server/src/lib/gitLfs.js');
const content='verified shared content',oid=createHash('sha256').update(content).digest('hex'),size=Buffer.byteLength(content);
const pointer=(n:number)=>`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${n}\n`;
let root:string|undefined;
afterEach(()=>{h.fetch.mockReset();if(root){const full=path.resolve(root);if(!full.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(full).startsWith('nd-lfs-size-'))throw Error('Unowned cleanup');rmSync(full,{recursive:true,force:true});}root=undefined;});
function setup(sizes:number[]){root=mkdtempSync(path.join(tmpdir(),'nd-lfs-size-'));execFileSync('git',['-C',root,'init','-q'],{stdio:'ignore'});const attrs=path.join(root,'.empty-attrs');writeFileSync(attrs,'');for(let i=0;i<sizes.length;i++)writeFileSync(path.join(root,`${i}.bin`),pointer(sizes[i]!));execFileSync('git',['-C',root,'-c','core.autocrlf=false','-c',`core.attributesFile=${attrs}`,'add','--',...sizes.map((_,i)=>`${i}.bin`)],{stdio:'ignore'});h.fetch.mockImplementation(async(url:string,init?:RequestInit)=>url.endsWith('/objects/batch')?new Response(JSON.stringify({objects:JSON.parse(String(init?.body)).objects.map((o:{oid:string;size:number})=>({...o,actions:{download:{href:'https://objects.example.test/shared'}}}))})):new Response(content));}
it('rejects conflicting duplicate sizes before hydration',async()=>{setup([size-1,size]);let error:unknown;try{await fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{});}catch(e){error=e;}console.log('EXPECTED: conflicting declarations rejected, pointers unchanged; ACTUAL:',{error:String(error),first:readFileSync(path.join(root!,'0.bin'),'utf8'),requests:h.fetch.mock.calls.length});if(!error)console.log('PROBLEM CONFIRMED');else console.log('PROBLEM NOT REPRODUCED');expect(error).toBeInstanceOf(Error);expect(h.fetch).not.toHaveBeenCalled();expect(readFileSync(path.join(root!,'0.bin'),'utf8')).toBe(pointer(size-1));});
it('control: matching duplicate sizes hydrate once',async()=>{setup([size,size]);expect(await fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).toEqual({files:2,bytes:size});expect(h.fetch).toHaveBeenCalledTimes(2);expect(readFileSync(path.join(root!,'0.bin'),'utf8')).toBe(content);console.log('CONTROL PASSED');});
