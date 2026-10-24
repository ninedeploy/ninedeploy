import {describe,it,expect} from 'vitest';
import {databaseClientCommand,databaseClientInput,DATABASE_CLIENT_ENGINES} from '../../src/lib/databaseClient.js';
const input={engine:'postgres',username:'nine',database:'app',password:'private-client-secret'};
describe('fixed database client commands',()=>{
  it.each([
    ['postgres',['psql','-U','nine','-d','app'],['PGPASSWORD=private-client-secret']],
    ['mysql',['mysql','-uroot'],['MYSQL_PWD=private-client-secret']],
    ['mariadb',['mariadb','-uroot'],['MYSQL_PWD=private-client-secret']],
    ['redis',['redis-cli'],['REDISCLI_AUTH=private-client-secret']],
    ['valkey',['valkey-cli'],['REDISCLI_AUTH=private-client-secret','VALKEYCLI_AUTH=private-client-secret']],
    ['keydb',['keydb-cli'],['REDISCLI_AUTH=private-client-secret']],
    ['dragonfly',['redis-cli'],['REDISCLI_AUTH=private-client-secret']],
  ])('preserves the existing local %s command and puts credentials only in exec Env', (engine,cmd,env)=>{
    const result=databaseClientCommand({...input,engine:engine as string});expect(result).toEqual({cmd,env});expect(JSON.stringify(result.cmd)).not.toContain(input.password);
  });
  it('keeps username/database operands separate from executables and flags',()=>{
    const result=databaseClientCommand({...input,username:'-user with spaces',database:'db with spaces'});
    expect(result.cmd).toEqual(['psql','-U','-user with spaces','-d','db with spaces']);
  });
  it.each(['mongo','sqlite','sh'])('refuses unsupported engine %s',engine=>{
    expect(()=>databaseClientCommand({...input,engine})).toThrowError(expect.objectContaining({statusCode:422,code:'client_mode_unsupported'}));
  });
  it.each(DATABASE_CLIENT_ENGINES)('accepts the fixed structured sealed operand for %s',engine=>{
    expect(databaseClientInput.parse({...input,engine})).toEqual({...input,engine});
  });
  it.each([{cmd:['sh']},{env:['OTHER=secret']},{password:'bad\0password'},{username:''},{database:''},{password:'x'.repeat(1025)},{engine:'mongo'}])('refuses unbounded or caller-controlled execution operands',extra=>{
    expect(databaseClientInput.safeParse({...input,...extra}).success).toBe(false);
  });
});
