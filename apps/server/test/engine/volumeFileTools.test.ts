import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn(), nonce: '', volume: {} as any, daemon: { root: '/var/lib/docker', os: 'linux', id: 'owned-daemon' }, mutateOnStart: false, mutateAfterRead: false, outside: false, huge: false, cleanupOwner: true, replacementInode: false }));
vi.mock('../../src/lib/exec.js', async original => ({ ...await original<typeof import('../../src/lib/exec.js')>(), capture: h.capture, run: h.run }));
const { volumeFileTool } = await import('../../src/engine/volumeFileTools.js');
const CID = 'c'.repeat(64), IMAGE = `sha256:${'a'.repeat(64)}`, VOLUME = 'nd-svc-owned';
const entries = ['ND_FILES_V1', '81a4|0|644|1792774000', './empty.txt', '81a4|4|644|1792774000', './data.txt', 'ND_FILES_END', ''].join('\0');
beforeEach(() => {
  h.volume = { Name: VOLUME, Driver: 'local', Mountpoint: '/var/lib/docker/volumes/'+VOLUME+'/_data', CreatedAt: '2026-10-23T00:00:00.000000001Z', Scope: 'local', Labels: { 'ninedeploy.managed': 'volume' }, Options: null };
  h.daemon = { root: '/var/lib/docker', os: 'linux', id: 'owned-daemon' };
  h.nonce = ''; h.mutateOnStart = false; h.mutateAfterRead = false; h.outside = false; h.huge = false; h.cleanupOwner = true; h.replacementInode = false;
  h.run.mockReset().mockResolvedValue(undefined);
  h.capture.mockReset().mockImplementation(async (_exe, args: string[]) => {
    if (args[0] === 'info') return JSON.stringify(h.daemon);
    if (args[0] === 'volume') return JSON.stringify(h.volume);
    if (args[0] === 'image') return IMAGE;
    if (args[0] === 'run') {
      h.nonce = args[args.indexOf('--label')+1]!.split('=').at(-1)!;
      if (args.includes('--read-only') && args.some(a=>a.includes('readonly'))) return 'd'.repeat(64);
      if (h.mutateOnStart) h.volume.CreatedAt = '2026-10-23T00:00:01.000000001Z';
      return CID;
    }
    if (args[0] === 'inspect') return JSON.stringify({ id: /^[a-f0-9]{64}$/.test(args.at(-1)!) ? args.at(-1) : CID, owner: h.cleanupOwner ? h.nonce : 'another-owner' });
    if (args[0] === 'exec') {
      if (args[2] === 'stat') return h.replacementInode && args[1] !== CID ? '1:200' : '1:100';
      if (args.some(a => a.startsWith('set -f; target='))) return h.outside ? '/etc/passwd' : args.at(-2);
      if (args.some(a => a.includes('ND_FILES_V1'))) {
        if (h.mutateAfterRead) h.volume.CreatedAt = '2026-10-23T00:00:01.000000001Z';
        return entries;
      }
      if (args.some(a => a.includes('head -c'))) return h.huge ? Buffer.alloc(1024*1024+1).toString('base64') : Buffer.from('binary\0fixture').toString('base64');
      return '';
    }
    throw Error('Unexpected Docker command '+args.slice(0,2).join(' '));
  });
});
const starts = () => h.capture.mock.calls.filter(c => c[1][0] === 'run');
const operations = () => h.capture.mock.calls.filter(c => c[1][0] === 'exec');
describe('pinned existing local volume helpers', () => {
  it('binds the known existing mountpoint, pins the helper image and uses only its immutable container ID', async () => {
    const result = await volumeFileTool(VOLUME, 'list');
    expect(result.map(e => [e.name,e.sizeBytes])).toEqual([['data.txt',4],['empty.txt',0]]);
    const args = starts()[0]![1];
    expect(args).toContain(`type=bind,source=${h.volume.Mountpoint},target=/v,bind-propagation=rslave`);
    expect(args).not.toContain('-v'); expect(args).toContain('--read-only'); expect(args).toContain('none'); expect(args).toContain(IMAGE); expect(args.slice(-2)).toEqual(['sleep','150']);
    expect(operations().filter(c => c[1][2] !== 'stat').every(c => c[1][1] === CID)).toBe(true);
    expect(h.run).toHaveBeenLastCalledWith('docker', ['rm','-f',CID], { timeoutMs: 10000 }, expect.any(Function));
  });
  it('never auto-creates a missing volume or starts a helper for it', async () => {
    const original = h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (exe, args, opts) => { if (args[0] === 'volume') throw Error('No such volume: fixture'); return original(exe,args,opts); });
    await expect(volumeFileTool(VOLUME,'list')).rejects.toMatchObject({ statusCode: 404 });
    expect(starts()).toEqual([]); expect(operations()).toEqual([]); expect(h.run).not.toHaveBeenCalled();
  });
  it.each([{ Driver: 'nfs' }, { Options: { device: '/host/path', type: 'none', o: 'bind' } }, { Mountpoint: '/etc' }, { Name: 'nd-svc-replaced' }, { Scope: 'global' }])('refuses unconfirmed storage metadata: %j', async patch => {
    Object.assign(h.volume,patch);
    await expect(volumeFileTool(VOLUME,'read',{path:'file'})).rejects.toBeInstanceOf(Error); expect(starts()).toEqual([]); expect(operations()).toEqual([]);
  });
  it('refuses delete/recreate between initial inspection and helper mount before accessing files', async () => {
    h.mutateOnStart = true;
    await expect(volumeFileTool(VOLUME,'write',{path:'file',contentBase64:'eA=='})).rejects.toMatchObject({ statusCode: 409, code: 'volume_identity_changed' });
    expect(operations().filter(c => c[1][2] !== 'stat')).toEqual([]); expect(h.run.mock.calls.every(c => c[1][0] === 'rm')).toBe(true);
  });
  it('does not return a stale read after volume replacement during the operation', async () => {
    h.mutateAfterRead = true;
    await expect(volumeFileTool(VOLUME,'list')).rejects.toMatchObject({ statusCode:409 });
    expect(h.run).toHaveBeenCalledWith('docker',['rm','-f',CID],expect.anything(),expect.any(Function));
  });
  it('refuses a path resolved outside the volume before reading or writing content', async () => {
    h.outside = true;
    await expect(volumeFileTool(VOLUME,'read',{path:'escape'})).rejects.toMatchObject({ code:'volume_path_escape' });
    expect(operations().filter(c => c[1][2] !== 'stat')).toHaveLength(1);
  });
  it('captures binary reads as host-side base64 and refuses oversized content without returning a partial file', async () => {
    expect(await volumeFileTool(VOLUME,'read',{path:'binary'})).toEqual({content:Buffer.from('binary\0fixture').toString('base64'),encoding:'base64'});
    expect(operations().find(c => c[1].some((a:string)=>a.includes('head -c')))?.[2]).toMatchObject({captureEncoding:'base64',maxOutputBytes:1024*1024+1,timeoutMs:30000});
    h.huge = true; await expect(volumeFileTool(VOLUME,'read',{path:'huge'})).rejects.toMatchObject({statusCode:413});
  });
  it('normalizes wrapped base64 and sends content only through stdin', async () => {
    const contentBase64 = Buffer.from('fixture-secret\nü').toString('base64');
    expect(await volumeFileTool(VOLUME,'write',{path:"quote'file",contentBase64:contentBase64.slice(0,4)+'\n'+contentBase64.slice(4)})).toEqual({ok:true});
    const write = h.run.mock.calls.find(c=>c[1][0]==='exec')!;
    expect(write[1]).toContain(CID); expect(JSON.stringify(write[1])).not.toContain(contentBase64); expect(write[4]).toEqual(Buffer.from(contentBase64,'utf8'));
  });
  it.each(['mkdir','delete'] as const)('runs bounded %s only inside the pinned helper', async action => {
    expect(await volumeFileTool(VOLUME,action,{path:'dir/file'})).toEqual({ok:true});
    expect(starts()).toHaveLength(3);
    expect(h.capture.mock.calls.every(c=>c[2]?.timeoutMs>0&&c[2]?.timeoutMs<=30000)).toBe(true);
  });
  it.each([{path:'../escape'}, {path:'/'}, {path:'a\nfile'}, {path:'a\rfile'}, {path:'x',contentBase64:'invalid!'}])('refuses invalid write input before Docker: %j', async operands => {
    await expect(volumeFileTool(VOLUME,'write',operands)).rejects.toBeInstanceOf(Error); expect(h.capture).not.toHaveBeenCalled();
  });
  it('refuses oversized writes before touching Docker', async () => {
    await expect(volumeFileTool(VOLUME,'write',{path:'file',contentBase64:Buffer.alloc(1024*1024+1).toString('base64')})).rejects.toMatchObject({statusCode:413});
    expect(h.capture).not.toHaveBeenCalled();
  });
  it('refuses an inode replacement even when all Docker volume metadata is identical', async () => {
    h.replacementInode=true;
    const original=structuredClone(h.volume);
    await expect(volumeFileTool(VOLUME,'list')).rejects.toMatchObject({statusCode:409,code:'volume_identity_changed'});
    expect(h.volume).toEqual(original);
  });
  it('does not return a stale result when only the inode changes after reading', async () => {
    const original=h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (exe,args,opts)=>{const value=await original(exe,args,opts);if(args.some((a:string)=>a.includes('ND_FILES_V1')))h.replacementInode=true;return value;});
    await expect(volumeFileTool(VOLUME,'list')).rejects.toMatchObject({statusCode:409});
    expect(h.run.mock.calls.filter(c=>c[1][0]==='rm')).toHaveLength(3);
  });
  it('refuses a changed daemon and never removes containers from the replacement daemon', async () => {
    const original=h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (exe,args,opts)=>{const value=await original(exe,args,opts);if(args.some((a:string)=>a.includes('ND_FILES_V1')))h.daemon.id='replacement-daemon';return value;});
    await expect(volumeFileTool(VOLUME,'list')).rejects.toMatchObject({statusCode:409});
    expect(h.run).not.toHaveBeenCalled();
  });
  it('cleans up a helper by nonce and immutable ID when its startup reply is lost', async () => {
    const original=h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (exe,args,opts)=>{const value=await original(exe,args,opts);if(args[0]==='run')throw Error('reply lost');return value;});
    await expect(volumeFileTool(VOLUME,'list')).rejects.toMatchObject({statusCode:502,code:'volume_file_tool_failed'});
    expect(h.capture.mock.calls.find(c=>c[1][0]==='inspect')?.[1].at(-1)).toMatch(/^nd-volume-tool-/);
    expect(h.run).toHaveBeenCalledWith('docker',['rm','-f',CID],expect.anything(),expect.any(Function));
  });
  it('refuses an unconfirmed inode before running a file command', async () => {
    const original=h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (exe,args,opts)=>args[0]==='exec'&&args[2]==='stat'?'unconfirmed':original(exe,args,opts));
    await expect(volumeFileTool(VOLUME,'list')).rejects.toMatchObject({statusCode:502});
    expect(operations().some(c=>c[1].some((a:string)=>a.includes('ND_FILES_V1')))).toBe(false);
  });
  it('preserves an operation refusal when cleanup also cannot be confirmed', async () => {
    h.outside=true;h.cleanupOwner=false;
    await expect(volumeFileTool(VOLUME,'read',{path:'escape'})).rejects.toMatchObject({statusCode:400,code:'volume_path_escape'});
  });
  it('never exposes subprocess diagnostics or file content in an unknown failure', async () => {
    h.run.mockImplementation(async (_exe,args)=>{if(args[0]==='exec')throw Error('private fixture content');});
    await expect(volumeFileTool(VOLUME,'write',{path:'file',contentBase64:'eA=='})).rejects.toMatchObject({statusCode:502,code:'volume_file_tool_failed',message:'Volume file operation could not be confirmed'});
    expect(h.run.mock.calls.some(c=>c[1][0]==='rm')).toBe(true);
  });
  it('never deletes a helper whose owner nonce cannot be confirmed', async () => {
    h.cleanupOwner=false;
    await expect(volumeFileTool(VOLUME,'list')).rejects.toMatchObject({code:'volume_helper_cleanup_unconfirmed'});
    expect(h.run).not.toHaveBeenCalled();
  });
});
