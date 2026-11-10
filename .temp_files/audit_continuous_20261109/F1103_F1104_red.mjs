import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const p='apps/server/src/lib/backupDrill.ts',dir='.temp_files/audit_continuous_20261109/';const fixed=fs.readFileSync(p),old=fs.readFileSync(dir+'F1103_F1104_backupDrill_before.ts');fs.writeFileSync(p,old);
try{const r=spawnSync('cmd.exe',['/d','/s','/c','pnpm.cmd --dir apps/server exec vitest run test/lib/backupDrillHelperLifecycle.test.ts --coverage=false --reporter=verbose'],{encoding:'utf8'});fs.writeFileSync(dir+'F1103_F1104_permanent_red.log',(r.stdout??'')+(r.stderr??'')+'\nEXIT '+r.status);if(r.status===0)throw Error('Regression unexpectedly passed');}
finally{if(!fs.readFileSync(p).equals(old))throw Error('Source drift: preserve current file');fs.writeFileSync(p,fixed);}
