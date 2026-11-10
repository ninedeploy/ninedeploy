import {spawnSync} from 'node:child_process';
const result=spawnSync('cmd.exe',['/d','/s','/c','pnpm.cmd exec vitest run --config .temp_files/audit_continuous_20261109/F1073.config.ts .temp_files/audit_continuous_20261109/prove_F1102_manifestBody.test.ts apps/server/test/lib/imageWatchIntegrity.test.ts --reporter=verbose'],{encoding:'utf8'});
process.stdout.write((result.stdout??'')+(result.stderr??''));if(result.status!==0)process.exit(result.status??1);console.log('FIX VERIFIED');
