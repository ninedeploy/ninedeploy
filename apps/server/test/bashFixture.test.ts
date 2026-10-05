import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureBash, fixtureBashPath, runFixtureWrapper } from './bashFixture.js';

const bash = fixtureBash(spawnSync);
const available = spawnSync(bash, ['-c', 'command -v bash >/dev/null'], { timeout: 10000 }).status === 0;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)('Bash fixture isolation', () => {
  it('selects a shell that can read the repository fixture', () => {
    const installer = fileURLToPath(new URL('../../../install.sh', import.meta.url));
    const result = spawnSync(bash, ['-c', 'test -r "$1"', 'test', fixtureBashPath(spawnSync, installer)]);
    expect(result.status).toBe(0);
  });

  it('finds fixture binaries and preserves paths containing spaces and apostrophes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nd-bash fixture'-"));
    dirs.push(dir);
    const bin = path.join(dir, "bin ' tools");
    mkdirSync(bin);
    const script = path.join(dir, "run ' fixture.sh");
    const marker = path.join(dir, 'ran');
    writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nprintf fixture\n', { mode: 0o755 });
    const markerPath = fixtureBashPath(spawnSync, marker);
    writeFileSync(script, `#!/usr/bin/env bash\ncurl > "${markerPath}"\n`);

    const result = runFixtureWrapper(spawnSync, bin, script, process.env);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('refuses to execute the wrapper when curl would escape to the host binary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-bash-missing-'));
    dirs.push(dir);
    const bin = path.join(dir, 'empty-bin');
    mkdirSync(bin);
    const script = path.join(dir, 'run.sh');
    const marker = path.join(dir, 'ran');
    writeFileSync(script, `#!/usr/bin/env bash\ntouch "${fixtureBashPath(spawnSync, marker)}"\n`);

    const result = runFixtureWrapper(spawnSync, bin, script, process.env);
    expect(result.status).toBe(90);
    expect(existsSync(marker)).toBe(false);
  });
});
