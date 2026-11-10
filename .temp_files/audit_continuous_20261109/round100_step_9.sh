set -euo pipefail
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const files = execFileSync('git', ['ls-files', '-z', 'apps/server/test'], { encoding: 'utf8' })
  .split('\0').filter(p => p.endsWith('.test.ts') && !/^apps\/server\/test\/(integration|diag)\//.test(p) && !/(?:^|\/)(node_modules|dist)\//.test(p)).sort();
const manifest = {
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  configSha256: createHash('sha256').update(readFileSync('apps/server/vitest.config.ts')).digest('hex'),
  coverage: false,
  maxWorkers: 1,
  expectedFiles: files,
  expectedFileCount: files.length,
};
writeFileSync(join(process.env.AUDIT_LOG_DIR, 'unit-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
NODE
pnpm --dir apps/server exec vitest run --coverage=false --reporter=verbose --maxWorkers=1 2>&1 | tee "$AUDIT_LOG_DIR/unit.log"
