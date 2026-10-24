import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
export async function postgresClientProof(context){
const {api,request,m,w,docker,until,pause,replaceAgent,connected,baseUrl,token,registration,image,proof,label,suffix,panel,agent}=context;
 const created=await api('/v1/databases',{method:'POST',body:{name:'Node client proof '+suffix,engine:'postgres',serverId:registration.id}});
 assert.equal(created.status,'running');const database=await api('/v1/databases/'+created.id),container=database.containerName;
 assert.equal(database.serverId,registration.id);
 assert.equal(m(['ps','-a','--filter','name=^'+container+'$','--format','{{.ID}}']).out,'');
 await until(()=>w(['exec',container,'psql','-U','nine','-d','app','-tAc','SELECT 1'],{allow:true}).status===0,'real PostgreSQL ready');
 const runtimeId=w(['inspect',container,'--format','{{.Id}}']).out;
 const labels=JSON.parse(w(['inspect',container,'--format','{{json .Config.Labels}}']).out);assert.equal(labels['ninedeploy.database.id'],String(database.id));assert.equal(labels['ninedeploy.database.slug'],database.slug);
 const old=await request('/v1/terminals',{method:'POST',body:{target:{kind:'database',databaseId:database.id,mode:'client'}},allow:true});
 assert.equal(old.status,422);assert.equal(old.body.error.code,'node_agent_outdated');writeFileSync(proof+'/old-agent-refusal.json',JSON.stringify(old,null,2));
 replaceAgent(image);await connected();const node=(await api('/v1/servers')).find(s=>s.id===registration.id);assert.equal(node.features.databaseClients,true);
 const pgImage=w(['inspect',container,'--format','{{.Config.Image}}']).out;
 m(['run','-d','--name',container,'--label','ninedeploy.proof='+label,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=nine','-e','POSTGRES_DB=app',pgImage]);
 await until(()=>m(['exec',container,'psql','-U','nine','-d','app','-tAc','SELECT 1'],{allow:true}).status===0,'same-name local PostgreSQL ready');
 for(const [daemon,marker]of[[m,'LOCAL_ONLY'],[w,'REMOTE_ONLY']])daemon(['exec',container,'psql','-U','nine','-d','app','-v','ON_ERROR_STOP=1','-c',"CREATE TABLE owner_marker(value text);INSERT INTO owner_marker VALUES ('"+marker+"');"]);
 // Require actual password authentication on the Unix socket used by the production client.
 const hba=w(['exec',container,'psql','-U','nine','-d','app','-Atc','SHOW hba_file']).out;
 assert.ok(hba.startsWith('/')&&!hba.includes('\n'));
 w(['exec',container,'sh','-c','sed -i \'/^local[[:space:]]/s/trust/scram-sha-256/g\' "$1"; psql -U nine -d app -v ON_ERROR_STOP=1 -c "SELECT pg_reload_conf()"','sh',hba]);
 await pause(300);
 const wrong=w(['exec','-e','PGPASSWORD=known-wrong-fixture-value',container,'psql','-U','nine','-d','app','-tAc','SELECT 1'],{allow:true});
 assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/password authentication failed/i);
 const credential=await api('/v1/databases/'+database.id+'/credentials');const secret=credential.password;assert.equal(typeof secret,'string');assert.ok(secret.length>10);
 const ids=[],connections=[];
 function attachCreated(s){
   const ws=new WebSocket(baseUrl.replace('http:','ws:')+s.attachPath,['ninedeploy.terminal.v1','ninedeploy.ticket.'+s.ticket]);ws.binaryType='arraybuffer';
   const state={ws,ready:false,closed:false,code:null,out:'',frames:[]};
   ws.addEventListener('message',({data})=>{if(typeof data==='string'){const frame=JSON.parse(data);state.frames.push(frame.t);if(frame.t==='ready')state.ready=true;}else state.out+=Buffer.from(data).toString();});
   ws.addEventListener('close',event=>{state.closed=true;state.code=event.code;});connections.push(state);return state;
 }
 async function openClient(){const s=await api('/v1/terminals',{method:'POST',body:{target:{kind:'database',databaseId:database.id,mode:'client'}}});ids.push(s.session.id);const c=attachCreated(s);await until(()=>c.ready||c.closed,'client ready',90000);assert.equal(c.ready,true);return{s,c};}
 async function sql(c,statement,want){c.ws.send(Buffer.from(statement+'\r'));await until(()=>c.out.includes(want),'actual SQL result',30000);}
 async function closeClient(s,c){await api('/v1/terminals/'+s.session.id,{method:'DELETE'});await until(()=>c.closed,'client close',15000);await until(async()=>{const row=await api('/v1/terminals/'+s.session.id);return row.status==='ended'||row.status==='failed';},'durable terminal end',15000);}
 const first=await openClient();first.c.ws.send(JSON.stringify({t:'resize',cols:100,rows:30}));
 const n=100000+Math.floor(Math.random()*100000);
 await sql(first.c,"SELECT value || '-' || ("+n+"+1) FROM owner_marker;",'REMOTE_ONLY-'+(n+1));
 assert.ok(!first.c.out.includes('LOCAL_ONLY'));
 const args=w(['top',container,'-eo','pid,args']).out;assert.ok(!args.includes(secret),'Credential must not appear in process argv');

 const replay=attachCreated(first.s);await until(()=>replay.closed,'single-use ticket replay refused',15000);assert.equal(replay.ready,false);assert.equal(replay.code,4401);
 await closeClient(first.s,first.c);
 assert.equal(m(['exec',container,'psql','-U','nine','-d','app','-tAc','SELECT value FROM owner_marker']).out,'LOCAL_ONLY');
 // A running, correctly labelled replacement cannot steal a ticket for the original immutable ID.
 const pending=await api('/v1/terminals',{method:'POST',body:{target:{kind:'database',databaseId:database.id,mode:'client'}}});ids.push(pending.session.id);
 const retained=container+'-original';w(['rename',container,retained]);
 w(['run','-d','--name',container,'--label','ninedeploy.managed=database','--label','ninedeploy.database.id='+database.id,'--label','ninedeploy.database.slug='+database.slug,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=nine','-e','POSTGRES_DB=app',pgImage]);
 await until(()=>w(['exec',container,'psql','-U','nine','-d','app','-tAc','SELECT 1'],{allow:true}).status===0,'running replacement database');
 const replacementId=w(['inspect',container,'--format','{{.Id}}']).out;assert.notEqual(replacementId,runtimeId);
 const stale=attachCreated(pending);await until(()=>stale.closed,'stale client refused',30000);assert.equal(stale.ready,false);assert.equal(stale.code,4502);
 await until(async()=>{const row=await api('/v1/terminals/'+pending.session.id);return row.status==='failed'?row:null;},'stale terminal recorded');
 w(['rm','-fv',container]);w(['rename',retained,container]);assert.equal(w(['inspect',container,'--format','{{.Id}}']).out,runtimeId);
 const restored=await openClient();await sql(restored.c,'SELECT '+n+'+2;',''+(n+2));await closeClient(restored.s,restored.c);

 replaceAgent(image,true);await connected();
 const disabledNode=(await api('/v1/servers')).find(s=>s.id===registration.id);assert.equal(disabledNode.features.databaseClients,false);
 const disabled=await request('/v1/terminals',{method:'POST',body:{target:{kind:'database',databaseId:database.id,mode:'client'}},allow:true});assert.ok([403,422].includes(disabled.status));
 assert.ok(['node_agent_outdated','node_feature_disabled'].includes(disabled.body.error.code));writeFileSync(proof+'/owner-switch-refusal.json',JSON.stringify(disabled,null,2));
 replaceAgent(image);await connected();
 const afterOwner=await openClient();await sql(afterOwner.c,'SELECT '+n+'+3;',''+(n+3));await closeClient(afterOwner.s,afterOwner.c);
 const sdkCode="import{readFileSync}from'node:fs';import assert from'node:assert/strict';import{createClient}from'/app/packages/sdk/dist/index.js';const input=JSON.parse(readFileSync(0,'utf8')),api=createClient({baseUrl:'http://127.0.0.1:3000',getToken:()=>input.token});const created=await api.terminals.create({target:{kind:'database',databaseId:input.databaseId,mode:'client'}});let ready=false,closed=false,out='';const conn=api.terminals.connect(created,{onReady:()=>{ready=true;},onData:b=>{out+=Buffer.from(b).toString();},onClose:()=>{closed=true;}});const wait=async(fn)=>{const end=Date.now()+30000;while(!fn()){assert.ok(Date.now()<end,'SDK channel deadline');await new Promise(r=>setTimeout(r,50));}};await wait(()=>ready);const n=100000+Math.floor(Math.random()*100000);conn.write(\"SELECT value || '-' || (\"+n+\"+1) FROM owner_marker;\\r\");await wait(()=>out.includes('REMOTE_ONLY-'+(n+1)));assert.ok(!out.includes('LOCAL_ONLY'));await api.terminals.terminate(created.session.id);await wait(()=>closed);conn.close();console.log(JSON.stringify({actualProductionSdk:true,authenticatedQuery:true,nodeOnly:true,sessionId:created.session.id}));";
 const sdk=docker(['exec','-i',panel,'node','--input-type=module','-e',sdkCode],{input:JSON.stringify({token,databaseId:database.id})});writeFileSync(proof+'/sdk-runtime.log',sdk.stdout);const sdkResult=JSON.parse(sdk.out);assert.equal(sdkResult.actualProductionSdk,true);ids.push(sdkResult.sessionId);
 const rows=await Promise.all(ids.map(id=>api('/v1/terminals/'+id))),audit=(await api('/v1/activity?action=terminal.session.create')).entries;
 assert.ok(!JSON.stringify({rows,audit}).includes(secret),'Credentials must not be persisted in terminal rows/audit');
 for(const name of[panel,agent]){const logs=docker(['logs',name],{allow:true});assert.ok(!((logs.stdout??'')+(logs.stderr??'')).includes(secret),'Credentials must not appear in logs');}
 const result={realApi:true,actualPublishedOldAgentRefused:true,actualPostgres:true,passwordRequired:true,wrongPasswordRefused:true,storedCredentialAuthenticated:true,independentDaemons:true,sameNamedLocalDatabaseUntouched:true,realEncryptedAgentChannel:true,actualSqlQuery:true,resizeAndTerminate:true,singleUseTicket:true,actualProductionSdk:true,actualOwnerSwitchAndReenable:true,realRunningNameReplacementRefused:true,originalRuntimeRestored:true,credentialsAbsentFromArgvAndSessionAudit:true,oldRuntimeId:runtimeId,replacementRuntimeId:replacementId,terminalSessionIds:ids,browser:false,releaseReady:false};
 writeFileSync(proof+'/postgres-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));

 return result;
}
