import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const source='apps/server/src/lib/imageWatch.ts',dir='.temp_files/audit_continuous_20261109/';const fixed=fs.readFileSync(source),old=fs.readFileSync(dir+'F1102_imageWatch_before.ts');
fs.writeFileSync(source,old);
try{const result=spawnSync('pnpm.cmd',['--dir','apps/server','exec','vitest','run','test/lib/imageWatchIntegrity.test.ts','--coverage=false','--reporter=verbose'],{encoding:'utf8',shell:true});fs.writeFileSync(dir+'F1102_permanent_red.log',(result.stdout??'')+(result.stderr??'')+'\nEXIT '+result.status);if(result.status===0)throw Error('Regression did not fail');}
finally{if(!fs.readFileSync(source).equals(old))throw Error('Source drift: do not restore');fs.writeFileSync(source,fixed);}
