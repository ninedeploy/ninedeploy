node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const read = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const data = {
  sha: read('git', ['rev-parse', 'HEAD']),
  eventSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  timestamp: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  macOS: read('sw_vers', ['-productVersion']),
  node: process.versions.node,
  pnpm: read('pnpm', ['--version']),
  git: read('git', ['--version']),
};
if (data.sha !== data.eventSha || data.platform !== 'darwin') throw new Error('Unexpected audit checkout or platform');
writeFileSync(join(process.env.AUDIT_LOG_DIR, 'environment.json'), `${JSON.stringify(data, null, 2)}\n`);
console.log(data);
NODE
node scripts/dev-macos.mjs --check
