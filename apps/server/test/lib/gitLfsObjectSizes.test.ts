import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../../src/lib/egressGuard.js',()=>({guardedFetch:h.fetch}));
const {fetchLfsObjects}=await import('../../src/lib/gitLfs.js');
const content='verified shared content',oid=createHash('sha256').update(content).digest('hex'),size=Buffer.byteLength(content);
const pointer=(n:number)=>`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${n}\n`;
let root:string|undefined;
afterEach(()=>{h.fetch.mockReset();if(root){const full=path.resolve(root);if(!full.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(full).startsWith('nd-lfs-size-'))throw Error('Unowned cleanup');rmSync(full,{recursive:true,force:true});}root=undefined;});
function setup(sizes:number[]){root=mkdtempSync(path.join(tmpdir(),'nd-lfs-size-'));execFileSync('git',['-C',root,'init','-q'],{stdio:'ignore'});const attrs=path.join(root,'.empty-attrs');writeFileSync(attrs,'');for(let i=0;i<sizes.length;i++)writeFileSync(path.join(root,`${i}.bin`),pointer(sizes[i]!));execFileSync('git',['-C',root,'-c','core.autocrlf=false','-c',`core.attributesFile=${attrs}`,'add','--',...sizes.map((_,i)=>`${i}.bin`)],{stdio:'ignore'});h.fetch.mockImplementation(async(url:string,init?:RequestInit)=>url.endsWith('/objects/batch')?new Response(JSON.stringify({objects:JSON.parse(String(init?.body)).objects.map((o:{oid:string;size:number})=>({...o,actions:{download:{href:'https://objects.example.test/shared'}}}))})):new Response(content));}
for(const [name,sizes] of [
 ['wrong first',[size-1,size]],['wrong last',[size,size+1]],['zero first',[0,size]],['zero last',[size,0]],['three declarations',[size,size+1,size]],['over limit first',[2*1024**3+1,size]],
] as const)it(`rejects conflicting shared-object metadata before network: ${name}`,async()=>{setup([...sizes]);await expect(fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).rejects.toThrow('conflicting pointer sizes');expect(h.fetch).not.toHaveBeenCalled();for(let i=0;i<sizes.length;i++)expect(readFileSync(path.join(root!,`${i}.bin`),'utf8')).toBe(pointer(sizes[i]!));});
for(const count of [1,2,3])it(`hydrates ${count} consistent references with one download`,async()=>{setup(Array(count).fill(size));expect(await fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).toEqual({files:count,bytes:size});expect(h.fetch).toHaveBeenCalledTimes(2);for(let i=0;i<count;i++)expect(readFileSync(path.join(root!,`${i}.bin`),'utf8')).toBe(content);});
