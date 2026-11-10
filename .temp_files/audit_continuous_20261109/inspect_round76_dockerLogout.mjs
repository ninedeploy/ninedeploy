import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const docker='C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const roots=[];
const env=Object.fromEntries(['SystemRoot','PATH','TEMP','TMP','USERPROFILE'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
try {
 console.log('CLI',spawnSync(docker,['--version'],{encoding:'utf8',env}).stdout.trim());
 for(const server of ['docker.io','index.docker.io','registry-1.docker.io','Docker.IO','ghcr.io']) {
  const root=path.resolve(mkdtempSync(path.join(tmpdir(),'nd-registry-lock-audit-')));roots.push(root);
  const target=path.join(root,'config.json');writeFileSync(target,JSON.stringify({auths:{'https://index.docker.io/v1/':{auth:Buffer.from('invalid:invalid').toString('base64')}},credsStore:'',credHelpers:{}}));
  const result=spawnSync(docker,['--config',root,'logout',server],{encoding:'utf8',env,timeout:10000});
  console.log(JSON.stringify({server,exit:result.status,remainingKeys:Object.keys(JSON.parse(readFileSync(target,'utf8')).auths??{}),stdout:result.stdout.trim(),stderr:result.stderr.trim()}));
 }
} finally {for(const root of roots){if(!root.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(root).startsWith('nd-registry-lock-audit-'))throw new Error('Unowned cleanup');rmSync(root,{recursive:true,force:true});}}
