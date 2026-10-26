// Native protocol acceptance; panel producer integration remains a separate gate.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const image=process.argv.find(arg=>arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image),'Pass --image=<built NineDeploy image>');
const proof=resolve(process.argv.find(arg=>arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/runtime-mutation-'+randomBytes(6).toString('hex'));
mkdirSync(proof,{recursive:true});
writeFileSync(proof+'/agent-request.mjs',readFileSync(fileURLToPath(new URL('./fixtures/runtime-mutation-agent-request.mjs',import.meta.url))));
const owner='runtime-mutation-'+randomBytes(5).toString('hex'), daemon='nd-'+owner, volume=daemon+'-home', home='/var/lib/ninedeploy-agent';
const runners=[], jobs=[], cases=[]; const wrapperImage='ninedeploy-proof:'+owner;
const docker='docker';
const cli=args=>spawnSync(docker,args,{encoding:'utf8',windowsHide:true,timeout:90_000,maxBuffer:4<<20});
const check=args=>{const r=cli(args);assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim();};
const inner=args=>check(['exec',daemon,'docker',...args]);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,message)=>{const end=Date.now()+30_000;while(!fn()){assert.ok(Date.now()<end,message);await pause(100);}};
const report=name=>{cases.push({name,passed:true});writeFileSync(proof+'/cases.json',JSON.stringify({image,realDocker:true,realSqlite:true,sealedHttp:true,independentAgentProcesses:true,publicPanelIntegration:false,cases},null,2));console.log('PASS '+name);};
function request(op,params,hold=false){
 const name=daemon+'-request-'+runners.length;runners.push(name);
 const args=['run','--rm','--name',name,'--label','ninedeploy.proof='+owner,'--network','container:'+daemon,'--user','0','--no-healthcheck','-v',volume+':'+home,'-w',home,
 '--mount','type=bind,source='+proof+'/agent-request.mjs,target=/proof/request.mjs,readonly','-e','NODE_ENV=test','-e','NINEDEPLOY_DATA_DIR='+home+'/data','-e','DOCKER_HOST=tcp://127.0.0.1:2375','-e','PROOF_INPUT='+JSON.stringify({op,params})];
 if(hold)args.push('-e','PATH=/proof/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','-e','PROOF_BARRIER='+home+'/start-barrier-'+params.serviceId);
 args.push('--entrypoint','node',hold?wrapperImage:image,'/proof/request.mjs');return{name,args};
}
function parse(result,label){
 writeFileSync(proof+'/'+label+'.log',(result.stdout??'')+'\n'+(result.stderr??''));assert.equal(result.status,0,result.stderr||result.stdout);
 const lines=(result.stdout??'').split('\n').filter(x=>x.startsWith('RESULT '));assert.equal(lines.length,1,result.stdout);return JSON.parse(lines[0].slice(7));
}
const run=(op,params)=>{const r=request(op,params);return parse(cli(r.args),r.name);};
function launch(op,params,hold){
 const r=request(op,params,hold),job={name:r.name,done:false,out:'',err:''};const c=spawn(docker,r.args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
 c.stdout.on('data',b=>{job.out=(job.out+b).slice(-(1<<20));});c.stderr.on('data',b=>{job.err=(job.err+b).slice(-(1<<20));});
 job.promise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.kill();reject(Error('Owned runtime fixture deadline'));},65_000);c.once('error',e=>{clearTimeout(timer);reject(e);});c.once('close',status=>{clearTimeout(timer);job.done=true;resolve({status,stdout:job.out,stderr:job.err});});});jobs.push(job.promise);return job;
}
function receipt(result,prefix,input){assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.exitCode,0,result.lines.join('\n'));const lines=result.lines.filter(x=>x.startsWith(prefix));assert.equal(lines.length,1);const data=JSON.parse(lines[0].slice(prefix.length));assert.equal(data.requestId,input.requestId);assert.equal(data.serviceId,input.serviceId);assert.equal(data.revision,input.revision);assert.equal(data.complete,true);return data;}
function refused(result,pattern){assert.equal(result.status,400,JSON.stringify(result));assert.match(result.error.message,pattern);}
const head=(revision,serviceId=7)=>({requestId:revision.toString(16).padStart(32,'0'),serviceId,revision,timeoutMs:30_000});
const state=id=>JSON.parse(inner(['inspect',id,'--format','{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"networks":{{json .NetworkSettings.Networks}}}']));
let appImage;
const batch=(revision,deploymentId,serviceId=7)=>({...head(revision,serviceId),deploymentId,startNames:['proof-web-'+deploymentId,'proof-web-'+deploymentId+'-r2'],specs:['','-r2','-r3'].map(suffix=>({name:'proof-web-'+deploymentId+suffix,image:appImage,serviceId,deploymentId,extraNetworks:['nd-extra'],cmd:['sh','-c','trap "exit 0" TERM; while :; do sleep 1; done']}))});
try{
 check(['image','inspect',image]);check(['image','inspect','busybox:1.36']);
 mkdirSync(proof+'/wrapper',{recursive:true});writeFileSync(proof+'/wrapper/Dockerfile','FROM '+image+'\nUSER root\nCOPY docker /proof/bin/docker\nRUN chmod 755 /proof/bin/docker\n');
 writeFileSync(proof+'/wrapper/docker','#!/bin/sh\nset -eu\nif [ "$1" = start ]; then touch "$PROOF_BARRIER-entered"; until [ -f "$PROOF_BARRIER-release" ]; do sleep 0.05; done; fi\nexec /usr/bin/docker "$@"\n');
 check(['build','-t',wrapperImage,proof+'/wrapper']);
 check(['volume','create','--label','ninedeploy.proof='+owner,volume]);
 check(['run','-d','--name',daemon,'--label','ninedeploy.proof='+owner,'--privileged','--network','none','-e','DOCKER_TLS_CERTDIR=','docker:28-dind','dockerd','--host=unix:///var/run/docker.sock','--host=tcp://127.0.0.1:2375','--tls=false']);
 await until(()=>cli(['exec',daemon,'docker','info']).status===0,'Private Docker daemon readiness');
 check(['save','-o',proof+'/fixture.tar','busybox:1.36']);check(['cp',proof+'/fixture.tar',daemon+':/root/fixture.tar']);inner(['load','-i','/root/fixture.tar']);
 for(const network of ['ninedeploy','nd-extra','nd-dbnet-proof'])inner(['network','create',network]);appImage=inner(['image','inspect','busybox:1.36','--format','{{.Id}}']);
 const first=batch(5,10);const prepared=receipt(run('docker.prepare',first),'ND-PREPARED ',first);
 assert.equal(prepared.items.length,3);assert.equal(new Set(prepared.items.map(x=>x.id)).size,3);
 for(const item of prepared.items){const actual=state(item.id);assert.equal(actual.running,!item.name.endsWith('-r3'));assert.equal(item.running,actual.running);assert.ok(actual.networks.ninedeploy&&actual.networks['nd-extra']);}
 report('sealed-prepare-binds-three-immutable-replicas-and-keeps-spare-stopped');
 assert.equal(run('file.writeEnv',{name:'legacy-replay',env:{FIXTURE:'1'}}).status,200);
 const fence=head(6);receipt(run('docker.runtimeFence',fence),'ND-RUNTIME-FENCE ',fence);
 const targets=prepared.items.map(({running,...target})=>target),stop={...head(7),deploymentId:10,action:'stop',targets};
 receipt(run('docker.lifecycle',stop),'ND-LIFECYCLE ',stop);assert.ok(targets.every(t=>!state(t.id).running));
 refused(run('docker.prepare',first),/stale|superseded/);
 refused(run('docker.runSpec',{...first.specs[0],name:'proof-delayed-legacy'}),/Unversioned.*fenced/);
 refused(run('docker.runEnv',{name:'proof-delayed-env',image:appImage,serviceId:7,deploymentId:12,envFile:'.agent-env/legacy-replay.env'}),/Unversioned.*fenced/);
 assert.equal(inner(['ps','-aq','--filter','name=^/proof-delayed']),'');report('fresh-agent-process-refuses-delayed-creation-after-completed-stop');
 const next=batch(9,11),selected=receipt(run('docker.prepare',next),'ND-PREPARED ',next);assert.ok(selected.items.slice(0,2).every(t=>state(t.id).running));
 const selectedTargets=selected.items.map(({running,...t})=>t),net={...head(10),action:'connect',networks:['nd-dbnet-proof'],targets:selectedTargets};
 receipt(run('docker.networkSet',net),'ND-NETWORKS ',net);for(const t of selectedTargets)assert.ok(state(t.id).networks['nd-dbnet-proof']);assert.equal(state(selectedTargets[2].id).running,false);
 report('newer-deploy-still-works-and-database-membership-includes-stopped-capacity');
 const retired={...head(11),graceSeconds:1,targets};receipt(run('docker.retireSet',retired),'ND-RETIRED-SET ',retired);assert.ok(targets.every(t=>cli(['exec',daemon,'docker','inspect',t.id]).status!==0));
 const replacement=inner(['run','-d','--name',targets[0].name,'--network','ninedeploy','--label','ninedeploy.managed=service','--label','ninedeploy.service=7','--label','ninedeploy.deployment=99',appImage,'sleep','300']);
 receipt(run('docker.retireSet',retired),'ND-RETIRED-SET ',retired);assert.equal(state(replacement).running,true);
 refused(run('docker.networkSet',net),/stale|superseded/);refused(run('docker.rm',{name:selectedTargets[0].name}),/Unversioned.*fenced/);assert.equal(state(selectedTargets[0].id).running,true);
 report('retirement-retry-preserves-same-name-replacement-and-refuses-stale-network-and-legacy-cleanup');
 const interrupted=batch(5,20,8);const creating=launch('docker.prepare',interrupted,true);
 await until(()=>{assert.ok(!creating.done,creating.err);return cli(['exec',creating.name,'test','-f',home+'/start-barrier-8-entered']).status===0;},'Real Docker Start barrier');
 const retained=inner(['inspect',interrupted.specs[0].name,'--format','{{.Id}}']);assert.equal(state(retained).running,false);
 check(['kill',creating.name]);await creating.promise;const recovered=receipt(run('docker.prepare',interrupted),'ND-PREPARED ',interrupted);assert.equal(recovered.items[0].id,retained);assert.equal(state(retained).running,true);
 report('hard-agent-crash-replays-only-the-nonce-bound-created-id');
 // Separate native processes contend for the same SQL journal while an actual Docker child is admitted.
 const ordered=batch(5,30,9);const pending=launch('docker.prepare',ordered,true);
 await until(()=>{assert.ok(!pending.done,pending.err);return cli(['exec',pending.name,'test','-f',home+'/start-barrier-9-entered']).status===0;},'Independent admitted creation');
 const newer=head(6,9),fencing=launch('docker.runtimeFence',newer,false);await pause(1200);assert.equal(fencing.done,false,'Fence overtook admitted Docker Start');
 check(['exec',pending.name,'touch',home+'/start-barrier-9-release']);receipt(parse(await pending.promise,pending.name),'ND-PREPARED ',ordered);receipt(parse(await fencing.promise,fencing.name),'ND-RUNTIME-FENCE ',newer);
 refused(run('docker.prepare',ordered),/stale|superseded/);report('native-sqlite-fence-drains-admitted-start-across-separate-sealed-http-agents');
}finally{
 for(const name of runners){const r=cli(['inspect',name,'--format','{{index .Config.Labels "ninedeploy.proof"}}']);if(r.status===0){assert.equal(r.stdout.trim(),owner);check(['rm','-fv',name]);}}
 await Promise.allSettled(jobs);
 const d=cli(['inspect',daemon,'--format','{{index .Config.Labels "ninedeploy.proof"}}']);if(d.status===0){assert.equal(d.stdout.trim(),owner);check(['rm','-fv',daemon]);}
 const v=cli(['volume','inspect',volume,'--format','{{index .Labels "ninedeploy.proof"}}']);if(v.status===0){assert.equal(v.stdout.trim(),owner);check(['volume','rm',volume]);}
 rmSync(proof+'/fixture.tar',{force:true});writeFileSync(proof+'/cleanup.json',JSON.stringify({owner,containers:check(['ps','-aq','--filter','label=ninedeploy.proof='+owner]),volumes:check(['volume','ls','-q','--filter','label=ninedeploy.proof='+owner])},null,2));
}
