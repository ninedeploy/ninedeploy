import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'nd-alias108-'));
try {
  const physical = join(root, 'physical');
  mkdirSync(physical);
  const alias = join(root, 'alias');
  symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(physical, 'probe.mjs'), "console.log('PROBE_READY');");
  for (const canonical of [false, true]) {
    const entry = canonical ? realpathSync(join(alias, 'probe.mjs')) : join(alias, 'probe.mjs');
    const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read='+entry, entry], { encoding: 'utf8' });
    console.log(JSON.stringify({ canonical, exitCode: r.status, stdout: r.stdout, stderr: r.stderr }));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
