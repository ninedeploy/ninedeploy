import {stripVTControlCharacters} from 'node:util';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const NATIVE_CODE="import{readFileSync}from'node:fs';import{request}from'node:http';const p=JSON.parse(readFileSync(0,'utf8'));async function call(method,path,body){const text=body===undefined?'':JSON.stringify(body);return await new Promise((resolve,reject)=>{const req=request({host:p.host,port:2375,method,path,headers:text?{'content-type':'application/json','content-length':Buffer.byteLength(text)}:{}},res=>{const a=[];res.on('data',c=>a.push(c));res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(Error('Owned Docker API status '+res.statusCode));resolve(Buffer.concat(a));});});req.setTimeout(15000,()=>req.destroy(Error('Owned Docker API timeout')));req.on('error',reject);req.end(text);});}const created=JSON.parse((await call('POST','/containers/'+encodeURIComponent(p.container)+'/exec',{AttachStdout:true,AttachStderr:true,Tty:false,Cmd:p.cmd,Env:p.env})).toString());const bytes=await call('POST','/exec/'+created.Id+'/start',{Detach:false,Tty:false});const streams={stdout:[],stderr:[]};let offset=0;while(offset+8<=bytes.length){const n=bytes.readUInt32BE(offset+4),kind=bytes[offset];if(offset+8+n>bytes.length)throw Error('Invalid Docker stream frame');(kind===2?streams.stderr:streams.stdout).push(bytes.subarray(offset+8,offset+8+n));offset+=8+n;}if(offset!==bytes.length)throw Error('Incomplete Docker stream frame');const state=JSON.parse((await call('GET','/exec/'+created.Id+'/json')).toString());console.log(JSON.stringify({exitCode:state.ExitCode,stdout:Buffer.concat(streams.stdout).toString(),stderr:Buffer.concat(streams.stderr).toString()}));";


export async function otherDatabaseClientProof(context){
const {api,request,m,w,docker,until,baseUrl,registration,proof,suffix,panel,worker}=context;
 const engines=['mysql','mariadb','redis','valkey','keydb','dragonfly'].filter(e=>!process.argv.some(a=>a.startsWith('--engine='))||process.argv.includes('--engine='+e));
 assert.ok(engines.length>0,'Select a known client engine');
 const results=[],failures=[];
 const nodeIp=docker(['inspect',worker,'--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).out;
 function nativeProbe(container,cmd,env){const r=docker(['exec','-i',panel,'node','--input-type=module','-e',NATIVE_CODE],{input:JSON.stringify({host:nodeIp,container,cmd,env})});return JSON.parse(r.out);}
 function attachCreated(s){const ws=new WebSocket(baseUrl.replace('http:','ws:')+s.attachPath,['ninedeploy.terminal.v1','ninedeploy.ticket.'+s.ticket]);ws.binaryType='arraybuffer';const c={ws,ready:false,closed:false,out:''};ws.addEventListener('message',({data})=>{if(typeof data==='string'){if(JSON.parse(data).t==='ready')c.ready=true;}else c.out+=Buffer.from(data).toString();});ws.addEventListener('close',()=>{c.closed=true;});return c;}
 for(const engine of engines){
   let database,connection,session,activeSecret;
   try{
     database=await api('/v1/databases',{method:'POST',body:{name:'Client '+engine+' '+suffix,engine,serverId:registration.id}});
     assert.equal(database.status,'running');assert.equal(database.serverId,registration.id);
     const container=database.containerName;
     assert.equal(m(['ps','-a','--filter','name=^'+container+'$','--format','{{.ID}}']).out,'');
     const imageId=w(['inspect',container,'--format','{{.Image}}']).out,imageRef=w(['inspect',container,'--format','{{.Config.Image}}']).out;
     const secret=(await api('/v1/databases/'+database.id+'/credentials')).password;assert.equal(typeof secret,'string');activeSecret=secret;
     const sqlFamily=engine==='mysql'||engine==='mariadb',binary=sqlFamily?engine:engine==='valkey'?'valkey-cli':engine==='keydb'?'keydb-cli':'redis-cli';
     const cmd=sqlFamily?[binary,'-h','127.0.0.1','-uroot','-N','-e','SELECT 1']:[binary,'--raw','PING'];
     const env=sqlFamily?['MYSQL_PWD='+secret]:['REDISCLI_AUTH='+secret,...(engine==='valkey'?['VALKEYCLI_AUTH='+secret]:[])];
     const nativeOkay=reply=>reply.exitCode===0&&reply.stdout.trim()===(sqlFamily?'1':'PONG');
     await until(()=>nativeOkay(nativeProbe(container,cmd,env)),'native authenticated '+engine+' readiness',120000);
     const wrongEnv=sqlFamily?['MYSQL_PWD=known-wrong-fixture-value']:['REDISCLI_AUTH=known-wrong-fixture-value',...(engine==='valkey'?['VALKEYCLI_AUTH=known-wrong-fixture-value']:[])];
     assert.equal(nativeOkay(nativeProbe(container,cmd,wrongEnv)),false,'Wrong password must not pass the native query control');
     const created=await api('/v1/terminals',{method:'POST',body:{target:{kind:'database',databaseId:database.id,mode:'client'}}});session=created.session.id;connection=attachCreated(created);
     await until(()=>connection.ready||connection.closed,'interactive '+engine+' client',90000);assert.equal(connection.ready,true);
     const n=100000+Math.floor(Math.random()*100000);
     if(sqlFamily){
       await until(()=>/mysql[^>\r\n]*>|MariaDB[^>\r\n]*>/i.test(connection.out),'actual SQL client prompt',30000);
       connection.out='';connection.ws.send(Buffer.from("SELECT CONCAT('nd-client-', "+n+"+1);\r"));
       await until(()=>stripVTControlCharacters(connection.out).includes('nd-client-'+(n+1)),'real authenticated SQL result',30000);
     }else{
       await until(()=>connection.out.includes('127.0.0.1:6379>'),'actual Redis-family client prompt',30000);
       connection.out='';connection.ws.send(Buffer.from('SET nd-client:'+suffix+' '+n+'\r'));
       await until(()=> /(?:^|\r?\n)OK\r?\n[\s\S]*127\.0\.0\.1:6379>/.test(stripVTControlCharacters(connection.out)),'SET reply before next interactive command',30000);
       connection.out='';connection.ws.send(Buffer.from('INCR nd-client:'+suffix+'\r'));
       const reply=new RegExp('(?:^|\\r?\\n)(?:\\(integer\\)\\s*)?'+(n+1)+'\\r?\\n');
       await until(()=>reply.test(stripVTControlCharacters(connection.out)),'actual authenticated INCR response',30000);
     }
     const argv=w(['top',container,'-eo','pid,args']).out.split('\n').filter(line=>new RegExp('(?:\\s|/)'+binary+'(?:\\s|$)').test(line));assert.ok(argv.length>0,'Actual client process must be present');assert.ok(argv.every(line=>!line.includes(secret)),'Client password must not enter argv');
     await api('/v1/terminals/'+session,{method:'DELETE'});await until(()=>connection.closed,'client terminated',15000);
     const row=await until(async()=>{const r=await api('/v1/terminals/'+session);return ['ended','failed'].includes(r.status)?r:null;},'terminal metadata end',15000),audit=(await api('/v1/activity?action=terminal.session.create')).entries;
     assert.ok(!JSON.stringify({row,audit}).includes(secret),'Client credentials must not enter terminal metadata/audit');
     const result={engine,imageRef,imageId,realDatabase:true,nativeAuthenticatedQuery:true,nativeWrongPasswordRefused:true,interactiveAuthenticatedQuery:true,recordedNodeOnly:true,clientArgvNoSecret:true,sessionAuditNoSecret:true,resizeAndTerminate:true};
     results.push(result);writeFileSync(proof+'/engines-progress.json',JSON.stringify({results,failures},null,2));console.log(JSON.stringify({engine,passed:true,imageId}));
   }catch(error){if(connection)writeFileSync(proof+'/'+engine+'-terminal-diagnostic.json',JSON.stringify({ready:connection.ready,closed:connection.closed,output:activeSecret?connection.out.split(activeSecret).join('[redacted]'):connection.out},null,2));failures.push({engine,message:error.message});writeFileSync(proof+'/engines-progress.json',JSON.stringify({results,failures},null,2));console.log(JSON.stringify({engine,passed:false,message:error.message}));}
   finally{
     if(connection&&!connection.closed){if(session)await request('/v1/terminals/'+session,{method:'DELETE',allow:true}).catch(()=>{});connection.ws.close();}
     if(database?.id)await request('/v1/databases/'+database.id,{method:'DELETE',allow:true}).catch(()=>{});
   }
 }
 writeFileSync(proof+'/engines-result.json',JSON.stringify({actualEngineImages:true,engines:results,failures,allPassed:failures.length===0,browser:false,releaseReady:false},null,2));assert.equal(failures.length,0,'Every requested engine must pass its real native and interactive controls');

 return {engines:results,failures};
}
