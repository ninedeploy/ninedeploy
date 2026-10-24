import {beforeEach,describe,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({agent:vi.fn(),sealed:vi.fn(),refusal:vi.fn()}));
vi.mock('../../src/lib/agentClient.js',()=>({agentOp:h.agent,agentTransportSealed:h.sealed}));
vi.mock('../../src/lib/agentCapabilities.js',()=>({capabilityRefusal:h.refusal,nodeLabel:async()=> '"owned" (#7)'}));
const {prepareNodeDatabaseClient,assertNodeDatabaseClientSupport}=await import('../../src/lib/nodeDatabaseClient.js');
const db={} as never,container='nd-db-owned',containerId='d'.repeat(64),databaseId=7;
beforeEach(()=>{h.sealed.mockReset().mockResolvedValue(true);h.refusal.mockReset().mockResolvedValue(null);h.agent.mockReset().mockResolvedValue({exitCode:0,lines:['ND-DB-CLIENT '+JSON.stringify({container,containerId,databaseId})]});});
describe('explicit node database client preparation',()=>{
  it('negotiates fresh sealed support and prepares only the recorded node/container without credentials',async()=>{
    expect(await prepareNodeDatabaseClient(db,7,container,databaseId)).toEqual({container,containerId,databaseId});
    expect(h.refusal).toHaveBeenCalledWith(expect.any(Function),'"owned" (#7)',true,expect.objectContaining({cap:['db.manage','db.client'],sealedRequired:true,persist:{db,serverId:7}}));
    expect(h.agent).toHaveBeenCalledExactlyOnceWith(db,7,'db.client.prepare',{container,databaseId},expect.any(Function),{timeoutMs:20_000,tolerateExit:true});
    await assertNodeDatabaseClientSupport(db,7);expect(h.refusal).toHaveBeenCalledTimes(2);
  });
  it.each([{status:422,code:'node_agent_outdated',message:'Update to 0.18.0'},{status:422,code:'node_transport_unsealed',message:'Sealed transport required'},{status:403,code:'node_feature_disabled',message:'Disabled by owner'}])('preserves a known refusal before preparing or opening anything',async refusal=>{
    h.refusal.mockResolvedValue(refusal);await expect(prepareNodeDatabaseClient(db,7,container,databaseId)).rejects.toMatchObject({statusCode:refusal.status,code:refusal.code});expect(h.agent).not.toHaveBeenCalled();
  });
  it.each([{exitCode:0,lines:[]},{exitCode:0,lines:['ND-DB-CLIENT {}','ND-DB-CLIENT {}']},{exitCode:0,lines:['wrong prefix']},{exitCode:0,lines:['ND-DB-CLIENT invalid']},{exitCode:1,lines:['ND-DB-CLIENT '+JSON.stringify({container,containerId,databaseId})]},{exitCode:0,lines:['ND-DB-CLIENT '+JSON.stringify({container:'nd-db-other',containerId,databaseId})]},{exitCode:0,lines:['ND-DB-CLIENT '+JSON.stringify({container,containerId:'short',databaseId})]},{exitCode:0,lines:['ND-DB-CLIENT '+JSON.stringify({container,containerId,databaseId,password:'must-not-return'})]}])('refuses ambiguous/unconfirmed target replies',async reply=>{
    h.agent.mockResolvedValue(reply);await expect(prepareNodeDatabaseClient(db,7,container,databaseId)).rejects.toMatchObject({statusCode:502,code:'node_database_client_unconfirmed'});
  });
  it.each([{status:403,code:'node_database_client_disabled',message:'Disabled by the node owner'},{status:409,code:'database_identity_changed',message:'Open a new session'},{status:422,code:'node_database_client_transport',message:'Docker Engine API required'}])('preserves a confirmed node refusal without preparing a usable target',async error=>{
    h.agent.mockResolvedValue({exitCode:1,lines:['ND-DB-CLIENT '+JSON.stringify({error})]});
    await expect(prepareNodeDatabaseClient(db,7,container,databaseId)).rejects.toMatchObject({statusCode:error.status,code:error.code,message:error.message});
  });
  it('redacts raw preparation transport diagnostics',async()=>{
    h.agent.mockRejectedValueOnce(Error('private fixture diagnostic'));await expect(prepareNodeDatabaseClient(db,7,container,databaseId)).rejects.toMatchObject({statusCode:502,message:'The node database client target could not be confirmed'});
  });
});
