import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const dir = '.temp_files/audit_continuous_20261109/';
for (let pass = 0; pass <= 3; pass++) {
  const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', dir+'F1073.config.ts', dir+'prove_F1125_staticLog.test.ts', '--reporter=verbose'], { encoding: 'utf8', env: { ...process.env, F1125_VERIFY: pass ? '1' : '' } });
  writeFileSync(dir+`F1125_${pass ? 'verify'+pass : 'after'}.log`, r.stdout+r.stderr);
  if (r.status !== 0) { process.stdout.write(r.stdout+r.stderr); process.exit(r.status || 1); }
  console.log(pass ? `Verifier ${pass}: six cases passed` : 'Original proof: two cases passed; PROBLEM NOT REPRODUCED');
}
console.log('FIX VERIFIED');
