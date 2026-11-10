import {afterAll,expect,it} from 'vitest';
import {createService} from '@ninedeploy/schemas';
import {parseImageRef} from '../../src/lib/imageRef.js';
const cases = [
  {
    "image": "ghcr.io/acme/app__one--two.v3:v1_2.3-4",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme/../../outside:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme//app:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/./app:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/-app:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/.app:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app_:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/a___b:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/a..b:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme/:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app_v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app__v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app-v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app--v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app.v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme/deep/web:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme/web:_valid",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:_",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:9",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:a.b-c_d",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:..",
    "valid": false,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:-bad",
    "valid": false,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:.bad",
    "valid": false,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "valid": false,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:",
    "valid": false,
    "kind": "tag"
  }
];
import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const root=path.resolve(mkdtempSync(path.join(tmpdir(),'nd-image-validation-native-')));const observed:Array<{image:string|null;tag:string|null;username:string|null;serveraddress:string|null}>=[];writeFileSync(path.join(root,'config.json'),JSON.stringify({auths:{'https://index.docker.io/v1/':{auth:Buffer.from('fixture-hub:invalid').toString('base64')},LOCALHOST:{auth:Buffer.from('fixture-local:invalid').toString('base64')},REGISTRY:{auth:Buffer.from('fixture-registry:invalid').toString('base64')},Acme:{auth:Buffer.from('fixture-acme:invalid').toString('base64')},'ghcr.io':{auth:Buffer.from('fixture-ghcr:invalid').toString('base64')}},credsStore:'',credHelpers:{}}));
const api=createServer((req,res)=>{const url=new URL(req.url??'','http://fixture.invalid');if(req.method==='POST'&&url.pathname.endsWith('/images/create')){const raw=req.headers['x-registry-auth'];let auth:{username?:string;serveraddress?:string}={};try{auth=JSON.parse(Buffer.from(Array.isArray(raw)?raw[0]??'':raw??'','base64').toString('utf8'));}catch{}observed.push({image:url.searchParams.get('fromImage'),tag:url.searchParams.get('tag'),username:auth.username??null,serveraddress:auth.serveraddress??null});res.writeHead(200,{'content-type':'application/json'});res.end(`${JSON.stringify({status:'Fixture pull complete'})}\n`);}else{res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({message:'Unexpected controlled daemon request'}));}});await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));const address=api.address();if(!address||typeof address==='string')throw new Error('No fixture address');
const env={...Object.fromEntries(['SystemRoot','PATH','TEMP','TMP','USERPROFILE','HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),DOCKER_API_VERSION:'1.52'};
function run(image:string):Promise<{image:string;exit:number|null;error?:string;observations:typeof observed}>{return new Promise((resolve,reject)=>{const child=spawn('docker',['--host',`tcp://127.0.0.1:${address.port}`,'--config',root,'pull',image],{env,windowsHide:true});let err='';child.stdout.resume();child.stderr.on('data',c=>err+=c);const timer=setTimeout(()=>{child.kill();reject(new Error('Owned Docker fixture timeout'));},10000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);resolve({image,exit:code,error:code?err.trim():undefined,observations:observed.splice(0)});});child.stdin.end();});}

function removeFixture(){const resolved=path.resolve(root);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(resolved).startsWith('nd-image-validation-native-'))throw new Error('Unowned cleanup');rmSync(resolved,{recursive:true,force:true});}
afterAll(async()=>{api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));removeFixture();});
for(const row of cases)it(`watch parser matches native CLI acceptance for ${row.image}`,async()=>{const input=createService.parse({name:'Fixture',type:'docker',image:row.image}).image!;const result=await run(input);expect(result.exit).toBe(row.valid?0:1);const parsed=parseImageRef(input);if(row.valid){expect(result.observations).toHaveLength(1);expect(parsed).not.toBeNull();const actual=result.observations[0]!;expect(parsed!.repository).toBe(actual.image!.slice(actual.image!.indexOf('/')+1));expect(parsed!.tag).toBe(actual.tag);}else{expect(result.observations).toEqual([]);expect(parsed).toBeNull();}});
