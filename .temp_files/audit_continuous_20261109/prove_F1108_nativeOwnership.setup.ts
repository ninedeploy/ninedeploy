import {afterAll,expect,vi} from 'vitest';
const owned=vi.hoisted(()=>({clients:[] as Array<{closed:boolean;close:()=>void}>}));
vi.mock('@ninedeploy/db',async(importOriginal)=>{const original=await importOriginal<typeof import('@ninedeploy/db')>();return{...original,createDb:(...args:Parameters<typeof original.createDb>)=>{const result=original.createDb(...args);if(result.client)owned.clients.push(result.client);return result;}};});
afterAll(()=>{const retained=owned.clients.filter(client=>!client.closed).length;console.log('EXPECTED unclosed owned native clients:0 ACTUAL:',retained,'opened',owned.clients.length);console.log(retained?'PROBLEM CONFIRMED':'PROBLEM NOT REPRODUCED');try{expect(retained).toBe(0);}finally{for(const client of owned.clients)client.close();}});
