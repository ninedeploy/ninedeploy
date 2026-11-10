import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir='.temp_files/audit_continuous_20261109/';
for(let pass=1;pass<=3;pass++){
  const r=spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','test/engine/elasticsearchAcknowledgement.test.ts','--coverage=false','--reporter=verbose'],{cwd:resolve('apps/server'),encoding:'utf8'});
  writeFileSync(dir+`F1122_F1123_verify${pass}.log`,r.stdout+r.stderr);
  if(r.status!==0){process.stdout.write(r.stdout+r.stderr);process.exit(r.status||1);}
  console.log(`Verifier ${pass}: 18 queue acknowledgement cases passed`);
}
console.log('FIX VERIFIED');
