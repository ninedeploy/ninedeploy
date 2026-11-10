import {afterAll,expect,it} from 'vitest';
import {createService} from '@ninedeploy/schemas';
import {parseImageRef} from '../../src/lib/imageRef.js';
const cases = [
  {
    "image": "ghcr.io/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "REGISTRY/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "localhost:5000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "REGISTRY:5000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "[2001:4860:4860::8888]:5000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "registry.example.test:99999/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "ghcr.io?fixture=1/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr.io#fixture/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr.io\\extra/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr..io/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "-registry.example/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "registry_.example/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr.io:bad/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "[::1/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "bad%host.example/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "ghcr.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "index.docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "index.docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "registry-1.docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "registry-1.docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "REGISTRY/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "REGISTRY/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "[2001:4860:4860::8888]:5000/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "[2001:4860:4860::8888]:5000/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "reg--istry.example:0005000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "[::ffff:192.0.2.1]:5000/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "example.test./web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "foo_bar.example/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "[:::]:5000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "[::1%25eth0]:5000/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "REGISTRY.EXAMPLE/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "index.docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "index.docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "registry-1.docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "registry-1.docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  }
];
import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const root=path.resolve(mkdtempSync(path.join(tmpdir(),'nd-image-host-native-')));const observed:Array<{image:string|null;tag:string|null;username:string|null;serveraddress:string|null}>=[];writeFileSync(path.join(root,'config.json'),JSON.stringify({auths:{'https://index.docker.io/v1/':{auth:Buffer.from('fixture-hub:invalid').toString('base64')},LOCALHOST:{auth:Buffer.from('fixture-local:invalid').toString('base64')},REGISTRY:{auth:Buffer.from('fixture-registry:invalid').toString('base64')},Acme:{auth:Buffer.from('fixture-acme:invalid').toString('base64')},'ghcr.io':{auth:Buffer.from('fixture-ghcr:invalid').toString('base64')}},credsStore:'',credHelpers:{}}));
const api=createServer((req,res)=>{const url=new URL(req.url??'','http://fixture.invalid');if(req.method==='POST'&&url.pathname.endsWith('/images/create')){const raw=req.headers['x-registry-auth'];let auth:{username?:string;serveraddress?:string}={};try{auth=JSON.parse(Buffer.from(Array.isArray(raw)?raw[0]??'':raw??'','base64').toString('utf8'));}catch{}observed.push({image:url.searchParams.get('fromImage'),tag:url.searchParams.get('tag'),username:auth.username??null,serveraddress:auth.serveraddress??null});res.writeHead(200,{'content-type':'application/json'});res.end(`${JSON.stringify({status:'Fixture pull complete'})}\n`);}else{res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({message:'Unexpected controlled daemon request'}));}});await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));const address=api.address();if(!address||typeof address==='string')throw new Error('No fixture address');
const env={...Object.fromEntries(['SystemRoot','PATH','TEMP','TMP','USERPROFILE','HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),DOCKER_API_VERSION:'1.52'};
function run(image:string):Promise<{image:string;exit:number|null;error?:string;observations:typeof observed}>{return new Promise((resolve,reject)=>{const child=spawn('docker',['--host',`tcp://127.0.0.1:${address.port}`,'--config',root,'pull','--',image],{env,windowsHide:true});let err='';child.stdout.resume();child.stderr.on('data',c=>err+=c);const timer=setTimeout(()=>{child.kill();reject(new Error('Owned Docker fixture timeout'));},10000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);resolve({image,exit:code,error:code?err.trim():undefined,observations:observed.splice(0)});});child.stdin.end();});}

function removeFixture(){const resolved=path.resolve(root);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(resolved).startsWith('nd-image-host-native-'))throw new Error('Unowned cleanup');rmSync(resolved,{recursive:true,force:true});}
afterAll(async()=>{api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));removeFixture();});
for(const row of cases)it(`parser matches native CLI host/name acceptance for ${row.image}`,async()=>{const input=createService.parse({name:'Fixture',type:'docker',image:row.image}).image!;const result=await run(input);expect(result.exit).toBe(row.valid?0:1);const parsed=parseImageRef(input);if(row.valid){expect(result.observations).toHaveLength(1);expect(parsed).not.toBeNull();const actual=result.observations[0]!,repository=actual.image!.slice(actual.image!.indexOf('/')+1);expect(parsed!.tag).toBe(actual.tag);
 // Preserve the watch's existing Hub API alias expansion while validating
 // the input's native repository length before that HTTP representation.
 const watched=actual.image!.startsWith('registry-1.docker.io/')&&!repository.includes('/')?`library/${repository}`:repository;expect(parsed!.repository).toBe(watched);
 }else{expect(result.observations).toEqual([]);expect(parsed).toBeNull();}});
