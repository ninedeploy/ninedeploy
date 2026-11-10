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

const emptyOid=createHash('sha256').digest('hex');
const emptyPointer=`version https://git-lfs.github.com/spec/v1\noid sha256:${emptyOid}\nsize 0\n`;
function emptyFile(index:number){writeFileSync(path.join(root!,`${index}.bin`),emptyPointer);}
for(const count of [1,2,3])it(`hydrates ${count} empty references without HTTP`,async()=>{setup(Array(count).fill(size));for(let i=0;i<count;i++)emptyFile(i);h.fetch.mockRejectedValue(new Error('No remote transfer allowed'));expect(await fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).toEqual({files:count,bytes:0});expect(h.fetch).not.toHaveBeenCalled();for(let i=0;i<count;i++)expect(readFileSync(path.join(root!,`${i}.bin`)).length).toBe(0);});
it('excludes empty objects from mixed batch requests',async()=>{setup([size,size]);emptyFile(0);expect(await fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).toEqual({files:2,bytes:size});expect(h.fetch).toHaveBeenCalledTimes(2);const request=JSON.parse(String(h.fetch.mock.calls[0]![1].body));expect(request.objects).toEqual([{oid,size}]);expect(readFileSync(path.join(root!,'0.bin')).length).toBe(0);expect(readFileSync(path.join(root!,'1.bin'),'utf8')).toBe(content);});
it('leaves all pointers intact when a mixed transfer fails',async()=>{setup([size,size]);emptyFile(0);h.fetch.mockResolvedValue(new Response('offline',{status:503}));await expect(fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).rejects.toThrow('answered 503');expect(readFileSync(path.join(root!,'0.bin'),'utf8')).toBe(emptyPointer);expect(readFileSync(path.join(root!,'1.bin'),'utf8')).toBe(pointer(size));});
it('does not trust size zero with a different hash',async()=>{setup([0]);h.fetch.mockImplementation(async(url:string,init?:RequestInit)=>url.endsWith('/objects/batch')?new Response(JSON.stringify({objects:JSON.parse(String(init?.body)).objects.map((o:unknown)=>({...o as object,actions:{download:{href:'https://objects.example.test/shared'}}}))})):new Response(''));await expect(fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).rejects.toThrow('does not match its pointer');expect(h.fetch).toHaveBeenCalledTimes(2);expect(readFileSync(path.join(root!,'0.bin'),'utf8')).toBe(pointer(0));});
it('does not bypass a nonzero empty-hash declaration',async()=>{setup([1]);writeFileSync(path.join(root!,'0.bin'),emptyPointer.replace('size 0','size 1'));h.fetch.mockResolvedValue(new Response('offline',{status:503}));await expect(fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).rejects.toThrow('answered 503');expect(h.fetch).toHaveBeenCalledTimes(1);});
it('still rejects conflicting sizes for the empty hash',async()=>{setup([size,size]);emptyFile(0);writeFileSync(path.join(root!,'1.bin'),emptyPointer.replace('size 0','size 1'));await expect(fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).rejects.toThrow('conflicting pointer sizes');expect(h.fetch).not.toHaveBeenCalled();});
it('retains normal nonempty verification and deduplication',async()=>{setup([size,size]);expect(await fetchLfsObjects(root!,'https://repo.example.test/a/b',null,()=>{})).toEqual({files:2,bytes:size});expect(h.fetch).toHaveBeenCalledTimes(2);});
