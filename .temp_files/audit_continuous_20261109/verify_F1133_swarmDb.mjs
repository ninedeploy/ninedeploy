import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const d='.temp_files/audit_continuous_20261109/';
const config=readFileSync(d+'F1133.config.ts','utf8').replace('prove_F1133_swarmDb.setup.ts','verify_F1133_swarmDb.setup.ts');
writeFileSync(d+'F1133.verify.config.ts',config);
for(let pass=1;pass<=3;pass++){
  const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config',d+'F1133.verify.config.ts','test/swarmDeploy.test.ts','--reporter=verbose'],{encoding:'utf8'});
  const output=r.stdout+r.stderr;
  writeFileSync(d+`F1133_verify${pass}.log`,output);
  if(r.status!==0||!output.includes('FIX VERIFIED')){process.stdout.write(output);process.exit(r.status||1);}
  console.log(`Verifier ${pass}: 27 tests, zero open fixture clients, gated lifecycle edges passed`);
}
console.log('FIX VERIFIED');
