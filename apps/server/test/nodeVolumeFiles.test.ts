import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';
const h=vi.hoisted(()=>({tool:vi.fn(),audit:vi.fn()}));
vi.mock('../src/lib/nodeVolumeFiles.js',()=>({nodeVolumeFileTool:h.tool}));
vi.mock('../src/lib/audit.js',()=>({audit:h.audit}));
const {nodeVolumeFileRoutes}=await import('../src/modules/nodeVolumeFiles.js');
let app: Awaited<ReturnType<typeof buildTestApp>>;
beforeEach(()=>{h.audit.mockReset().mockResolvedValue(undefined);h.tool.mockReset().mockResolvedValue([]);});
afterEach(async()=>{await app?.close();});
async function boot(){app=await buildTestApp({db:createFakeDb()});await app.register(nodeVolumeFileRoutes,{prefix:'/servers/:serverId/volumes'});}
describe('operator node volume file namespace',()=>{
  it.each([
    {method:'GET',suffix:'/content?path=dir%2Ffile',action:'read'},
    {method:'PUT',suffix:'',action:'write',payload:{path:'dir/file',contentBase64:'cHJpdmF0ZS1maWxlLWNvbnRlbnQ='}},
    {method:'POST',suffix:'/dir',action:'mkdir',payload:{path:'dir/file'}},
    {method:'DELETE',suffix:'?path=dir%2Ffile',action:'delete'},
  ] as const)('audits the node, actor and path without file content for $action',async request=>{
    await boot();h.tool.mockResolvedValue({ok:true});
    const res=await app.inject({method:request.method,url:'/servers/7/volumes/nd-svc-same/files'+request.suffix,headers:asUser(),payload:'payload' in request?request.payload:undefined});
    expect(res.statusCode).toBe(200);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(app.db,1,`volume.file.${request.action}`,'node #7 nd-svc-same:dir/file');
    expect(JSON.stringify(h.audit.mock.calls[0]!.slice(1))).not.toContain('cHJpdmF0ZS1maWxlLWNvbnRlbnQ=');
  });
  it('uses the URL host for listing without a local-name fallback',async()=>{
    await boot();const res=await app.inject({url:'/servers/7/volumes/nd-svc-same/files?path=dir%20name',headers:asUser()});
    expect(res.statusCode).toBe(200);expect(res.json()).toEqual({path:'dir name',entries:[]});
    expect(h.tool).toHaveBeenCalledWith(app.db,7,'nd-svc-same','list',{path:'dir name'});
  });
  it('requires an instance operator even when the caller has a workspace admin role',async()=>{
    await boot();const res=await app.inject({url:'/servers/7/volumes/nd-svc-same/files',headers:asUser({role:'admin',isOperator:false})});
    expect(res.statusCode).toBe(403);expect(h.tool).not.toHaveBeenCalled();
  });
  it('requires authentication before volume inspection',async()=>{
    await boot();expect((await app.inject({url:'/servers/7/volumes/nd-svc-same/files'})).statusCode).toBe(401);expect(h.tool).not.toHaveBeenCalled();
  });
  it.each(['/servers/07/volumes/nd-svc-same/files','/servers/0/volumes/nd-svc-same/files','/servers/7/volumes/foreign/files','/servers/7/volumes/nd-svc-same/files?serverId=8','/servers/7/volumes/nd-svc-same/files?path=..%2Fescape'])('refuses ambiguous/invalid selection before a node operation: %s',async url=>{
    await boot();const res=await app.inject({url,headers:asUser()});expect(res.statusCode).toBe(400);expect(h.tool).not.toHaveBeenCalled();
  });
  it('reads with no-store and preserves a known node refusal',async()=>{
    await boot();h.tool.mockResolvedValueOnce({content:'eA==',encoding:'base64'});
    const res=await app.inject({url:'/servers/7/volumes/nd-svc-same/files/content?path=file',headers:asUser()});
    expect(res.statusCode).toBe(200);expect(res.headers['cache-control']).toBe('no-store');expect(res.json().content).toBe('eA==');
    const {HttpError}=await import('../src/lib/errors.js');h.tool.mockRejectedValueOnce(new HttpError(422,'node_agent_outdated','Update the agent'));
    const old=await app.inject({url:'/servers/7/volumes/nd-svc-same/files',headers:asUser()});expect(old.statusCode).toBe(422);expect(old.json().error.code).toBe('node_agent_outdated');
  });
  it('normalizes wrapped exact 1 MiB writes before sealed transport',async()=>{
    await boot();h.tool.mockResolvedValue({ok:true});const b64=Buffer.alloc(1024*1024,234).toString('base64'),wrapped=b64.match(/.{1,76}/g)!.join('\n');
    const res=await app.inject({method:'PUT',url:'/servers/7/volumes/nd-svc-same/files',headers:asUser(),payload:{path:'file',contentBase64:wrapped}});
    expect(res.statusCode).toBe(200);expect(h.tool).toHaveBeenCalledWith(app.db,7,'nd-svc-same','write',{path:'file',contentBase64:b64});
  });
  it('refuses oversized decoded writes before contacting the node',async()=>{
    await boot();const res=await app.inject({method:'PUT',url:'/servers/7/volumes/nd-svc-same/files',headers:asUser(),payload:{path:'file',contentBase64:Buffer.alloc(1024*1024+1).toString('base64')}});
    expect(res.statusCode).toBe(413);expect(h.tool).not.toHaveBeenCalled();
  });
  it('never permits root mutation or a conflicting write query',async()=>{
    await boot();for(const request of [{method:'DELETE' as const,url:'/servers/7/volumes/nd-svc-same/files?path=/'},{method:'POST' as const,url:'/servers/7/volumes/nd-svc-same/files/dir',payload:{path:'/'}},{method:'PUT' as const,url:'/servers/7/volumes/nd-svc-same/files?path=other',payload:{path:'file',contentBase64:'eA=='}}]){
      const res=await app.inject({...request,headers:asUser()});expect(res.statusCode).toBe(400);
    }expect(h.tool).not.toHaveBeenCalled();
  });
  it.each(['POST','DELETE'] as const)('sends a validated %s file mutation to the explicit node',async method=>{
    await boot();h.tool.mockResolvedValue({ok:true});const res=await app.inject({method,url:method==='POST'?'/servers/7/volumes/nd-svc-same/files/dir':'/servers/7/volumes/nd-svc-same/files?path=dir',payload:method==='POST'?{path:'dir'}:undefined,headers:asUser()});
    expect(res.statusCode).toBe(200);expect(h.tool).toHaveBeenCalledWith(app.db,7,'nd-svc-same',method==='POST'?'mkdir':'delete',{path:'dir'});
  });
});
