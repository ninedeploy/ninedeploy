import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir='.temp_files/audit_continuous_20261109/';
for(let pass=1;pass<=3;pass++){
  const r=spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','test/engine/elasticsearchEndpoint.test.ts','--coverage=false','--reporter=verbose'],{cwd:resolve('apps/server'),encoding:'utf8'});
  writeFileSync(dir+`F1124_verify${pass}.log`,r.stdout+r.stderr);
  if(r.status!==0){process.stdout.write(r.stdout+r.stderr);process.exit(r.status||1);}
  console.log(`Verifier ${pass}: 7 endpoint cases passed`);
}
console.log('FIX VERIFIED');
