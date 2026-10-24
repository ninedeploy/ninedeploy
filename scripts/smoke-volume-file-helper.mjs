#!/usr/bin/env node
// Real volume helper smoke: isolated Docker daemon; no host Docker volumes are mounted.
// node scripts/smoke-volume-file-helper.mjs --image=<built candidate>
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const image=process.argv.find(a=>a.startsWith('--image='))?.slice(8);
const inside=process.argv.includes('--inside');
function docker(args,allow=false){const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4<<20});if(!allow)assert.equal(r.status,0,r.stderr);return {...r,out:r.stdout?.trim()??''};}
if(inside){
  const volume=process.argv.at(-1);
  const {volumeFileTool}=await import('/app/apps/server/dist/engine/volumeFileTools.js');
  const seed=docker(['run','--rm','--mount','type=volume,source='+volume+',target=/v','alpine:3.21','sh','-c',
    'touch /v/empty.txt "/v/ leading " "/v/trailing "; mkdir /v/real; ln -s real /v/alias; ln -s /etc/passwd /v/real/outside; printf CONTROL > /v/real/control.txt; dd if=/dev/zero of=/v/oversized.bin bs=1048577 count=1 2>/dev/null']);
  assert.equal(seed.status,0);
  const entries=await volumeFileTool(volume,'list');
  assert.ok(entries.some(e=>e.name==='empty.txt'&&e.sizeBytes===0));
  assert.ok(entries.some(e=>e.name===' leading '));assert.ok(entries.some(e=>e.name==='trailing '));
  const bytes=Buffer.from([0,255,128,1,2,10,13]);
  await volumeFileTool(volume,'write',{path:'new/binary.bin',contentBase64:bytes.toString('base64')});
  assert.deepEqual(Buffer.from((await volumeFileTool(volume,'read',{path:'new/binary.bin'})).content,'base64'),bytes);
  const one=Buffer.alloc(1024*1024,234),encoded=one.toString('base64');
  await volumeFileTool(volume,'write',{path:'new/one.bin',contentBase64:encoded.match(/.{1,76}/g).join('\n')});
  assert.deepEqual(Buffer.from((await volumeFileTool(volume,'read',{path:'new/one.bin'})).content,'base64'),one);
  await assert.rejects(volumeFileTool(volume,'write',{path:'new/one.bin',contentBase64:Buffer.alloc(one.length+1).toString('base64')}),e=>e.statusCode===413);
  assert.deepEqual(Buffer.from((await volumeFileTool(volume,'read',{path:'new/one.bin'})).content,'base64'),one);
  await assert.rejects(volumeFileTool(volume,'read',{path:'oversized.bin'}),e=>e.statusCode===413);
  await assert.rejects(volumeFileTool(volume,'read',{path:'alias/outside'}),e=>e.code==='volume_path_escape');
  await volumeFileTool(volume,'delete',{path:'alias/outside'});
  assert.equal(Buffer.from((await volumeFileTool(volume,'read',{path:'alias/control.txt'})).content,'base64').toString(),'CONTROL');
  await volumeFileTool(volume,'mkdir',{path:'new/folder'});await volumeFileTool(volume,'delete',{path:'new/folder'});await volumeFileTool(volume,'delete',{path:'new/binary.bin'});
  assert.ok(!(await volumeFileTool(volume,'list',{path:'new'})).some(e=>e.name==='folder'||e.name==='binary.bin'));
  await assert.rejects(volumeFileTool(volume+'-missing','list'),e=>e.statusCode===404);
  assert.equal(docker(['volume','ls','--filter','name='+volume+'-missing','--format','{{.Name}}']).out,'');
  assert.equal(docker(['ps','-a','--filter','label=ninedeploy.volume-file-tool','--format','{{.ID}}']).out,'');
  console.log(JSON.stringify({actualDocker:true,allCrud:true,binary:true,wrappedOneMiB:true,oversizedReadWriteRefused:true,emptyAndWhitespaceNames:true,outsideSymlinkRefused:true,deleteLastSymlinkThroughAlias:true,unaffectedControl:true,missingNeverCreated:true,noRemainingHelpers:true}));
}else{
  assert.ok(image,'Pass --image=<built candidate>');
  const suffix=randomBytes(6).toString('hex'),label='volume-helper-'+suffix,net='nd-vfh-net-'+suffix,daemon='nd-vfh-daemon-'+suffix,runner='nd-vfh-runner-'+suffix,volume='nd-svc-vfh-'+suffix;
  let network=false;
  try{
    docker(['network','create','--label','ninedeploy.proof='+label,net]);network=true;
    docker(['run','-d','--privileged','--name',daemon,'--label','ninedeploy.proof='+label,'--network',net,'-e','DOCKER_TLS_CERTDIR=','docker:28-dind']);
    const deadline=Date.now()+90000;
    while(docker(['exec',daemon,'docker','info'],true).status!==0){if(Date.now()>deadline)throw Error('Owned Docker daemon unavailable');await new Promise(r=>setTimeout(r,250));}
    docker(['exec',daemon,'docker','volume','create','--label','ninedeploy.proof='+label,volume]);
    const result=docker(['run','--rm','--name',runner,'--label','ninedeploy.proof='+label,'--network',net,'--user','0','-e','DOCKER_HOST=tcp://'+daemon+':2375','--mount','type=bind,source='+fileURLToPath(import.meta.url)+',target=/volume-proof.mjs,readonly','--entrypoint','node',image,'/volume-proof.mjs','--inside',volume],true);
    process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');assert.equal(result.status,0,'Real volume helper smoke failed');
  }finally{
    for(const name of [runner,daemon]){const own=docker(['inspect',name,'--format','{{index .Config.Labels "ninedeploy.proof"}}'],true);if(own.status===0&&own.out===label)docker(['rm','-fv',name]);}
    if(network){assert.equal(docker(['network','inspect',net,'--format','{{index .Labels "ninedeploy.proof"}}']).out,label);docker(['network','rm',net]);}
  }
}
