import { beforeEach, describe, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({node:vi.fn(),cap:vi.fn(),agent:vi.fn()}));
vi.mock('../../src/lib/agentCapabilities.js',()=>({assertNodeCapability:h.cap}));
vi.mock('../../src/lib/agentClient.js',()=>({agentOp:h.agent}));
const {nodeVolumeFileTool}=await import('../../src/lib/nodeVolumeFiles.js');
const db={query:{servers:{findFirst:h.node}}} as never;
beforeEach(()=>{h.node.mockReset().mockResolvedValue({id:7});h.cap.mockReset().mockResolvedValue(undefined);h.agent.mockReset().mockResolvedValue({exitCode:0,lines:['{"ok":true,"result":{"content":"eA==","encoding":"base64"}}']});});
describe('explicit-node volume file transport',()=>{
  it('negotiates a sealed volume capability and only calls the named node',async()=>{
    expect(await nodeVolumeFileTool(db,7,'nd-svc-same','read',{path:'file'})).toEqual({content:'eA==',encoding:'base64'});
    expect(h.cap).toHaveBeenCalledWith(db,7,expect.objectContaining({cap:'volume.files',sealedRequired:true}));
    expect(h.agent).toHaveBeenCalledWith(db,7,'volume.fileTool',{volume:'nd-svc-same',action:'read',path:'file'},expect.any(Function),{tolerateExit:true});
  });
  it('does not call a missing node or fall back locally',async()=>{
    h.node.mockResolvedValue(undefined);await expect(nodeVolumeFileTool(db,7,'nd-svc-same','list')).rejects.toMatchObject({statusCode:404});expect(h.agent).not.toHaveBeenCalled();expect(h.cap).not.toHaveBeenCalled();
  });
  it('preserves capability refusal before sending any volume operation',async()=>{
    h.cap.mockRejectedValue(Error('Update the agent'));await expect(nodeVolumeFileTool(db,7,'nd-svc-same','list')).rejects.toThrow('Update the agent');expect(h.agent).not.toHaveBeenCalled();
  });
  it.each([{exitCode:0,lines:[]},{exitCode:0,lines:['{}','{}']},{exitCode:0,lines:['null']},{exitCode:0,lines:['bad JSON']},{exitCode:0,lines:['{}']},{exitCode:1,lines:['{"ok":true,"result":{}}']},{exitCode:0,lines:['{"ok":true,"result":{"content":"invalid!","encoding":"base64"}}']},{exitCode:0,lines:['{"ok":true,"result":{"content":"text","encoding":"utf8"}}']}])('rejects malformed output without usable file content: %j',async reply=>{
    h.agent.mockResolvedValue(reply);await expect(nodeVolumeFileTool(db,7,'nd-svc-same','read')).rejects.toMatchObject({statusCode:502,code:'node_volume_files_unconfirmed'});
  });
  it.each([409,413,422,504])('preserves known node refusal %s',async status=>{
    h.agent.mockResolvedValue({exitCode:1,lines:[JSON.stringify({ok:false,error:{status,code:'known_refusal',message:'Known refusal'}})]});
    await expect(nodeVolumeFileTool(db,7,'nd-svc-same','read')).rejects.toMatchObject({statusCode:status,code:'known_refusal'});
  });
  it('redacts raw transport errors and oversized decoded reads',async()=>{
    h.agent.mockRejectedValueOnce(Error('fixture-secret'));await expect(nodeVolumeFileTool(db,7,'nd-svc-same','read')).rejects.toThrow('no local fallback');
    h.agent.mockResolvedValue({exitCode:0,lines:[JSON.stringify({ok:true,result:{content:Buffer.alloc(1024*1024+1).toString('base64'),encoding:'base64'}})]});
    await expect(nodeVolumeFileTool(db,7,'nd-svc-same','read')).rejects.toMatchObject({statusCode:502});
  });
});
