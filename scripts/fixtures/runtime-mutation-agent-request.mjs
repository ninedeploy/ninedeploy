import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildAgentApp } from '/app/apps/server/dist/agentApp.js';
import { agentRoutes } from '/app/apps/server/dist/agent.js';
import { seal, open } from '/app/apps/server/dist/lib/agentSeal.js';
import { sha256 } from '/app/apps/server/dist/lib/crypto.js';
const hash=sha256('isolated-runtime-mutation-proof-only'), input=JSON.parse(process.env.PROOF_INPUT);
const app=await buildAgentApp();await app.register(agentRoutes,{tokenHash:hash,nonceFile:process.cwd()+'/seen-nonces'});
try {
 await app.listen({host:'127.0.0.1',port:0});
 const nonce=randomBytes(16).toString('hex');
 const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/agent/exec',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sealed:seal(hash,{...input,nonce})}),signal:AbortSignal.timeout(50_000)});
 const raw=await response.json();
 if(response.status!==200){console.log('RESULT '+JSON.stringify({status:response.status,error:raw.error}));}
 else{assert.ok(raw.sealed);const result=open(hash,raw.sealed);assert.equal(result.nonce,nonce);console.log('RESULT '+JSON.stringify({status:response.status,...result}));}
}finally{await app.close();}
