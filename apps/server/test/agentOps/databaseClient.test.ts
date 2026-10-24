import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({inspect:vi.fn(),transport:vi.fn()}));
vi.mock('../../src/lib/dockerTty.js',async original=>({...await original<typeof import('../../src/lib/dockerTty.js')>(),inspectContainer:h.inspect,dockerTransport:h.transport}));
const {databaseClientOps,inspectDatabaseClientTarget}=await import('../../src/agentOps/databaseClient.js');
const ID='a'.repeat(64),NAME='nd-db-owned';
beforeEach(()=>{h.transport.mockReset().mockReturnValue({kind:'socket',socketPath:'/owned.sock'});h.inspect.mockReset().mockResolvedValue({id:ID,running:true,hostname:null,labels:{'ninedeploy.managed':'database','ninedeploy.database.id':'7','ninedeploy.database.slug':'owned'}});});
afterEach(()=>vi.unstubAllEnvs());
describe('sealed database client target preparation',()=>{
  it('returns only the confirmed managed container name and full immutable ID',async()=>{
    const lines:string[]=[];await databaseClientOps.ops['db.client.prepare']!.run({container:NAME,databaseId:7},line=>lines.push(line),{sealed:true});
    expect(lines).toEqual(['ND-DB-CLIENT '+JSON.stringify({container:NAME,containerId:ID,databaseId:7})]);expect(databaseClientOps.ops['db.client.prepare']!.sealedOnly).toBe(true);
  });
  it('rechecks the exact prepared ID instead of accepting a reused name',async()=>{
    await expect(inspectDatabaseClientTarget(NAME,7,'b'.repeat(64))).rejects.toMatchObject({statusCode:409,code:'database_identity_changed'});
  });
  it.each([null,{id:ID,running:false,labels:{'ninedeploy.managed':'database','ninedeploy.database.id':'7','ninedeploy.database.slug':'owned'}}])('refuses a stopped or missing target',async summary=>{
    h.inspect.mockResolvedValue(summary);await expect(inspectDatabaseClientTarget(NAME,7)).rejects.toMatchObject({statusCode:409,code:'not_running'});
  });
  it('refuses a managed service or an unlabelled container at a database name',async()=>{
    h.inspect.mockResolvedValue({id:ID,running:true,labels:{'ninedeploy.managed':'service'}});await expect(inspectDatabaseClientTarget(NAME,7)).rejects.toMatchObject({statusCode:409,code:'database_identity_changed'});
  });
  it.each([{'ninedeploy.database.id':'8'},{'ninedeploy.database.slug':'other'},{'ninedeploy.database.id':undefined}])('refuses a different database resource at the expected name',async labels=>{
    h.inspect.mockResolvedValue({id:ID,running:true,labels:{'ninedeploy.managed':'database','ninedeploy.database.id':'7','ninedeploy.database.slug':'owned',...labels}});
    await expect(inspectDatabaseClientTarget(NAME,7)).rejects.toMatchObject({statusCode:409,code:'database_identity_changed'});
  });
  it('requires a full confirmed immutable ID',async()=>{
    h.inspect.mockResolvedValue({id:'short',running:true,labels:{'ninedeploy.managed':'database','ninedeploy.database.id':'7','ninedeploy.database.slug':'owned'}});await expect(inspectDatabaseClientTarget(NAME,7)).rejects.toBeInstanceOf(Error);
  });
  it.each(['NINEDEPLOY_AGENT_DATABASES','NINEDEPLOY_AGENT_DATABASE_CLIENTS'])('honors owner switch %s before any inspection',async key=>{
    vi.stubEnv(key,'off');await expect(inspectDatabaseClientTarget(NAME,7)).rejects.toMatchObject({statusCode:403});expect(h.inspect).not.toHaveBeenCalled();
  });
  it('refuses a CLI-only Docker transport before inspection',async()=>{
    h.transport.mockReturnValue({kind:'cli',reason:'unsupported'});await expect(inspectDatabaseClientTarget(NAME,7)).rejects.toMatchObject({statusCode:422});expect(h.inspect).not.toHaveBeenCalled();
  });
  it.each([{container:'service'},{container:'nd-db-unsafe;value'},{container:NAME,password:'must-not-be-forwarded'},{container:NAME,cmd:['sh']}])('refuses invalid or unexpected preparation operands',async params=>{
    await expect(databaseClientOps.ops['db.client.prepare']!.run({...params,databaseId:7},()=>undefined,{sealed:true})).rejects.toBeInstanceOf(Error);expect(h.inspect).not.toHaveBeenCalled();
  });
});
