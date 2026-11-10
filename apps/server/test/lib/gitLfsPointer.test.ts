import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {afterEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({fetch:vi.fn()}));vi.mock('../../src/lib/egressGuard.js',()=>({guardedFetch:h.fetch}));const {fetchLfsObjects,findLfsPointers}=await import('../../src/lib/gitLfs.js');const body='verified fixture object',oid=createHash('sha256').update(body).digest('hex'),canonical=`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(body)}\n`;let root:string|undefined;
afterEach(()=>{h.fetch.mockReset();if(root){const absolute=path.resolve(root);if(!absolute.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(absolute).startsWith('nd-lfs-pointer-'))throw Error('Unowned cleanup');rmSync(absolute,{recursive:true,force:true});}root=undefined;});
function checkout(candidate:string){root=mkdtempSync(path.join(tmpdir(),'nd-lfs-pointer-'));execFileSync('git',['-C',root,'init','-q'],{stdio:'ignore'});const attrs=path.join(root,'.empty-attributes');writeFileSync(attrs,'');writeFileSync(path.join(root,'control.bin'),canonical);writeFileSync(path.join(root,'candidate.bin'),candidate);execFileSync('git',['-C',root,'-c','core.autocrlf=false','-c',`core.attributesFile=${attrs}`,'add','--','control.bin','candidate.bin'],{stdio:'ignore'});h.fetch.mockImplementation(async(url:string,init?:RequestInit)=>{if(url.endsWith('/objects/batch')){const request=JSON.parse(String(init?.body));return new Response(JSON.stringify({objects:request.objects.map((object:{oid:string;size:number})=>({...object,actions:{download:{href:'https://objects.example.test/fixture'}}}))}));}if(url!=='https://objects.example.test/fixture')throw Error('Unscripted request');return new Response(body);});}
// Native Git LFS 3.8.1 check/smudge oracle: basic current-v1 records only.
const cases=[
 ['canonical',canonical,true],
 ['trailing prose',`${canonical}This is explanatory text.\n`,false],
 ['trailing unknown field',`${canonical}z-note explanation\n`,false],
 ['trailing blank',`${canonical}\n`,true],
 ['trailing spaces',`${canonical}  \n`,true],
 ['missing final LF',canonical.trimEnd(),true],
 ['CRLF',canonical.replaceAll('\n','\r\n'),true],
 ['duplicate size',`${canonical}size ${Buffer.byteLength(body)}\n`,false],
 ['NUL suffix',`${canonical}\0not a pointer\n`,false],
 ['leading whitespace',` \t${canonical}`,true],
 ['NBSP suffix',`${canonical}\u00a0\n`,true],
 ['NEL suffix',`${canonical}\u0085\n`,true],
 ['BOM suffix',`${canonical}\ufeff\n`,false],
 ['1023 byte wrapper',canonical+' '.repeat(1023-Buffer.byteLength(canonical)),true],
 ['1024 byte wrapper',canonical+' '.repeat(1024-Buffer.byteLength(canonical)),true],
 // Local policy controls, without claiming every legacy/extension format.
 ['unknown version',canonical.replace('git-lfs.github.com','unknown.example.test'),false],
 ['over local pointer cap',canonical+' '.repeat(1025-Buffer.byteLength(canonical)),false],
] as const;
for(const[name,candidate,valid]of cases)it(`classifies and hydrates complete basic-v1 input: ${name}`,async()=>{checkout(candidate);const found=await findLfsPointers(root!);expect(found.map(pointer=>pointer.path).sort()).toEqual(valid?['candidate.bin','control.bin']:['control.bin']);const result=await fetchLfsObjects(root!,'https://repo.example.test/acme/app',null,()=>{});expect(result).toEqual({files:valid?2:1,bytes:Buffer.byteLength(body)});expect(readFileSync(path.join(root!,'control.bin'),'utf8')).toBe(body);expect(readFileSync(path.join(root!,'candidate.bin'),'utf8')).toBe(valid?body:candidate);expect(h.fetch).toHaveBeenCalledTimes(2);});
