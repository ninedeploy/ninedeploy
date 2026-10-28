import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<built NineDeploy image>');
const name = `nd-local-ready-proof-${randomBytes(5).toString('hex')}`;
const docker = (args, timeout = 30000) => spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
const checked = args => { const r = docker(args); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  checked(['run', '-d', '--name', name, '--label', 'ninedeploy.proof=local-readiness', '--entrypoint', 'node', image, '-e',
    "require('node:http').createServer((q,s)=>q.url==='/slow'?setTimeout(()=>s.end('ready'),1500):s.end('ready')).listen(8080,'0.0.0.0')"]);
  let up = false;
  for (let n = 0; n < 40 && !up; n++) {
    up = docker(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:8080/fast').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]).status === 0;
    if (!up) await pause(100);
  }
  assert.ok(up, 'fixture server did not start');
  const program = `import {dockerBuilder} from '/app/apps/server/dist/engine/builders/docker.js';
    const base={runtimeId:${JSON.stringify(name)},port:8080,healthCheck:'http-strict'};
    const fast=await dockerBuilder.isHealthy({...base,healthPath:'/fast'},5000);
    const slow=await dockerBuilder.isHealthy({...base,healthPath:'/slow'},200);
    const autoFast=await dockerBuilder.isHealthy({runtimeId:base.runtimeId,port:8080,healthPath:'/fast'},5000,10000);
    const autoSlow=await dockerBuilder.isHealthy({runtimeId:base.runtimeId,port:8080,healthPath:'/slow'},200,10000);
    let checks=0, cancelled=false;
    try { await dockerBuilder.isHealthy({...base,healthPath:'/fast'},5000,0,()=>{},{checkpoint:async()=>{if(++checks===2)throw Error('owner changed')}}); }
    catch(e){cancelled=e.message==='owner changed'}
    console.log(JSON.stringify({fast,slow,autoFast,autoSlow,cancelled}));`;
  const output = checked(['run', '--rm', '--label', 'ninedeploy.proof=local-readiness', '--user', '0', '--no-healthcheck', '-e', 'NODE_ENV=test',
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '--entrypoint', 'node', image, '--input-type=module', '-e', program]);
  const result = JSON.parse(output.split('\n').at(-1));
  assert.deepEqual(result, { fast: true, slow: false, autoFast: true, autoSlow: false, cancelled: true });
  console.log(JSON.stringify({ realDocker: true, panelBuilder: true, result }));
} finally {
  docker(['rm', '-f', name]);
}
