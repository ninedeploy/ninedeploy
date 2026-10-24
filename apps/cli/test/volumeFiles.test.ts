import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({error:vi.fn(()=>{process.exitCode=1;}),success:vi.fn(),info:vi.fn(),table:vi.fn(),prompt:vi.fn()}));
vi.mock('../src/lib/format.js',()=>({error:h.error,success:h.success,info:h.info,table:h.table}));
vi.mock('../src/prompts.js',()=>({prompt:h.prompt}));
const {volumeFilesList,volumeFileRead,volumeFileWrite,volumeFileMkdir,volumeFileDelete}=await import('../src/commands/volumeFiles.js');
const root=mkdtempSync(path.join(os.tmpdir(),'nd-cli-volume-files-')),owned=new Set<string>();
const file=(name:string,bytes?:Buffer)=>{const p=path.join(root,name);owned.add(p);if(bytes!==undefined)writeFileSync(p,bytes);return p;};
const makeClient=()=>({volumes:{listFiles:vi.fn(async()=>({path:'',entries:[]})),readFile:vi.fn(async()=>({content:Buffer.from([0,255,128]).toString('base64'),encoding:'base64'})),writeFile:vi.fn(async()=>({ok:true})),mkdir:vi.fn(async()=>({ok:true})),deleteFile:vi.fn(async()=>undefined)}});
beforeEach(()=>{vi.clearAllMocks();process.exitCode=0;h.prompt.mockResolvedValue('file');});
afterEach(()=>{vi.restoreAllMocks();process.exitCode=0;});
afterAll(()=>{const resolved=path.resolve(root);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('nd-cli-volume-files-'))throw Error('Unexpected owned test directory');for(const p of owned){if(!path.resolve(p).startsWith(resolved+path.sep))throw Error('Unsafe test path');if(existsSync(p))unlinkSync(p);}rmdirSync(resolved);});
describe('volume CLI file operations',()=>{
  it('lists the selected host and preserves local argument compatibility',async()=>{
    const c=makeClient();await volumeFilesList(c as never,'nd-svc-data','dir',{server:'7'});expect(c.volumes.listFiles).toHaveBeenCalledWith('nd-svc-data','dir',{serverId:7});
    await volumeFilesList(c as never,'nd-svc-data');expect(c.volumes.listFiles).toHaveBeenLastCalledWith('nd-svc-data','');expect(h.info).toHaveBeenCalledWith('Empty directory.');
  });
  it('can return raw listing JSON without table decorations',async()=>{
    const c=makeClient(),log=vi.spyOn(console,'log').mockImplementation(()=>{});await volumeFilesList(c as never,'nd-svc-data','',{json:true});expect(log).toHaveBeenCalledWith('{"path":"","entries":[]}');expect(h.table).not.toHaveBeenCalled();
  });
  it('prints exact binary bytes to stdout instead of corrupting them through UTF-8',async()=>{
    const c=makeClient(),out=vi.spyOn(process.stdout,'write').mockReturnValue(true);await volumeFileRead(c as never,'nd-svc-data','binary',{server:'7'});expect(out).toHaveBeenCalledWith(Buffer.from([0,255,128]));expect(c.volumes.readFile).toHaveBeenCalledWith('nd-svc-data','binary',{serverId:7});
  });
  it('refuses an existing output file unless overwrite was explicit',async()=>{
    const c=makeClient(),output=file('output.bin',Buffer.from('KEEP'));await volumeFileRead(c as never,'nd-svc-data','binary',{output});expect(readFileSync(output).toString()).toBe('KEEP');expect(process.exitCode).toBe(1);
    process.exitCode=0;await volumeFileRead(c as never,'nd-svc-data','binary',{output,force:true});expect(readFileSync(output)).toEqual(Buffer.from([0,255,128]));expect(process.exitCode).toBe(0);
  });
  it('writes an exact local binary file through its selected node',async()=>{
    const c=makeClient(),bytes=Buffer.from([0,255,128,10,13]);await volumeFileWrite(c as never,'nd-svc-data','dir/file',{server:'7',file:file('input.bin',bytes)});expect(c.volumes.writeFile).toHaveBeenCalledWith('nd-svc-data',{path:'dir/file',contentBase64:bytes.toString('base64')},{serverId:7});
  });
  it('accepts exactly 1 MiB and rejects larger local files before HTTP',async()=>{
    const c=makeClient(),one=Buffer.alloc(1024*1024,234);await volumeFileWrite(c as never,'nd-svc-data','one',{file:file('one.bin',one)});expect(c.volumes.writeFile).toHaveBeenCalledTimes(1);
    c.volumes.writeFile.mockClear();await volumeFileWrite(c as never,'nd-svc-data','large',{file:file('large.bin',Buffer.alloc(one.length+1))});expect(c.volumes.writeFile).not.toHaveBeenCalled();expect(process.exitCode).toBe(1);
  });
  it('requires a local input file and handles a filesystem failure without an API write',async()=>{
    const c=makeClient();await volumeFileWrite(c as never,'nd-svc-data','file');expect(c.volumes.writeFile).not.toHaveBeenCalled();expect(h.error).toHaveBeenCalledWith('--file <local-file> is required');
    await volumeFileWrite(c as never,'nd-svc-data','file',{file:path.join(root,'missing-file')});expect(c.volumes.writeFile).not.toHaveBeenCalled();
  });
  it('creates directories on the explicit node',async()=>{
    const c=makeClient();await volumeFileMkdir(c as never,'nd-svc-data','dir',{server:'7'});expect(c.volumes.mkdir).toHaveBeenCalledWith('nd-svc-data',{path:'dir'},{serverId:7});
  });
  it('confirms a recursive path delete and allows an explicit noninteractive confirmation',async()=>{
    const c=makeClient();h.prompt.mockResolvedValueOnce('other');await volumeFileDelete(c as never,'nd-svc-data','file',{server:'7'});expect(c.volumes.deleteFile).not.toHaveBeenCalled();
    process.exitCode=0;await volumeFileDelete(c as never,'nd-svc-data','file',{server:'7'});expect(c.volumes.deleteFile).toHaveBeenCalledWith('nd-svc-data','file',{serverId:7});
    c.volumes.deleteFile.mockClear();h.prompt.mockClear();await volumeFileDelete(c as never,'nd-svc-data','file',{server:'7',yes:true});expect(h.prompt).not.toHaveBeenCalled();expect(c.volumes.deleteFile).toHaveBeenCalledTimes(1);
  });
  it.each(['0','07','1e1','0x7','9007199254740992'])('rejects ambiguous node id %s before HTTP or confirmation',async server=>{
    const c=makeClient();await volumeFileDelete(c as never,'nd-svc-data','file',{server});expect(c.volumes.deleteFile).not.toHaveBeenCalled();expect(h.prompt).not.toHaveBeenCalled();expect(process.exitCode).toBe(1);
  });
  it.each(['','/','..','../escape','file\nname'])('rejects invalid delete path %j before HTTP or confirmation',async value=>{
    const c=makeClient();await volumeFileDelete(c as never,'nd-svc-data',value,{yes:true});expect(c.volumes.deleteFile).not.toHaveBeenCalled();expect(h.prompt).not.toHaveBeenCalled();expect(process.exitCode).toBe(1);
  });
  it('keeps an offline-node error as a failure with no local retry',async()=>{
    const c=makeClient();c.volumes.readFile.mockRejectedValue(Error('Node unavailable'));await volumeFileRead(c as never,'nd-svc-data','file',{server:'7'});expect(c.volumes.readFile).toHaveBeenCalledTimes(1);expect(h.error).toHaveBeenCalledWith('Node unavailable');expect(process.exitCode).toBe(1);
  });
});
