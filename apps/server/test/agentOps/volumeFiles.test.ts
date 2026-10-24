import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(()=>({tool:vi.fn()}));
vi.mock('../../src/engine/volumeFileTools.js',()=>({volumeFileTool:h.tool}));
const { volumeFileOps } = await import('../../src/agentOps/volumeFiles.js');
const { HttpError } = await import('../../src/lib/errors.js');
const { capabilityKillSwitch, advertisedCapabilities } = await import('../../src/agentOps/index.js');
const { agentRequestTimeoutMs, SEALED_ONLY_AGENT_OPS } = await import('../../src/lib/agentClient.js');
const op = volumeFileOps.ops['volume.fileTool']!;
beforeEach(()=>{h.tool.mockReset().mockResolvedValue({ok:true});});
describe('sealed volume files agent operation',()=>{
  it('advertises a separate sealed capability with an owner kill switch and bounded request budget',()=>{
    expect(volumeFileOps.caps).toEqual(['volume.files']);expect(op.sealedOnly).toBe(true);
    expect(capabilityKillSwitch('volume.files',{NINEDEPLOY_AGENT_VOLUME_FILES:'off'})).toBe('NINEDEPLOY_AGENT_VOLUME_FILES');
    expect(advertisedCapabilities({NINEDEPLOY_AGENT_VOLUME_FILES:'off'})).not.toContain('volume.files');
    expect(SEALED_ONLY_AGENT_OPS.has('volume.fileTool')).toBe(true);expect(agentRequestTimeoutMs('volume.fileTool')).toBe(145000);
  });
  it.each(['list','read','write','mkdir','delete'])('passes validated %s through its volume helper',async action=>{
    const lines:string[]=[];const payload={action,volume:'nd-svc-data',path:'file',...(action==='write'?{contentBase64:'eA=='}:{})};
    expect(await op.run(payload,l=>lines.push(l),{sealed:true})).toBe(0);
    expect(h.tool).toHaveBeenCalledWith('nd-svc-data',action,{path:'file',...(action==='write'?{contentBase64:'eA=='}:{})});
    expect(lines).toEqual(['{"ok":true,"result":{"ok":true}}']);
  });
  it.each([{volume:'/host'}, {volume:'--help'}, {action:'exec'}, {command:'host-shell'}, {path:'a'.repeat(2049)}])('rejects invalid operands before helper execution: %j',async patch=>{
    await expect(op.run({action:'list',volume:'nd-svc-data',...patch},()=>{},{sealed:true})).rejects.toThrow('Invalid volume');expect(h.tool).not.toHaveBeenCalled();
  });
  it('preserves a known volume replacement refusal while redacting unknown errors',async()=>{
    const lines:string[]=[];h.tool.mockRejectedValueOnce(new HttpError(409,'volume_identity_changed','Volume changed'));
    expect(await op.run({action:'read',volume:'nd-svc-data',path:'file'},l=>lines.push(l),{sealed:true})).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({ok:false,error:{status:409,code:'volume_identity_changed',message:'Volume changed'}});
    lines.length=0;h.tool.mockRejectedValueOnce(Error('fixture-secret-from-daemon'));
    await op.run({action:'list',volume:'nd-svc-data'},l=>lines.push(l),{sealed:true});expect(lines.join('')).not.toContain('fixture-secret');
  });
  it('refuses an oversized result instead of producing a truncated editable response',async()=>{
    h.tool.mockResolvedValue('x'.repeat(2*1024*1024));const lines:string[]=[];
    expect(await op.run({action:'list',volume:'nd-svc-data'},l=>lines.push(l),{sealed:true})).toBe(1);
    expect(JSON.parse(lines[0]!).error.status).toBe(413);expect(JSON.parse(lines[0]!).result).toBeUndefined();
  });
});
