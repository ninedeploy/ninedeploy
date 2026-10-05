import { existsSync } from 'node:fs';
import path from 'node:path';

type SpawnSync = typeof import('node:child_process').spawnSync;

/** Use the Git installation's native shell rather than a WSL launcher on Windows. */
export function fixtureBash(spawnSync: SpawnSync): string {
  if (process.platform === 'win32') {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 10000 });
    if (git.status === 0) {
      const bash = path.resolve(git.stdout.trim(), '../../../bin/bash.exe');
      if (existsSync(bash)) return bash;
    }
  }
  return 'bash';
}

export function fixtureBashPath(spawnSync: SpawnSync, file: string, bash = fixtureBash(spawnSync)): string {
  const result = spawnSync(bash, [
    '-c', 'cygpath -u "$1" 2>/dev/null || printf "%s" "$1"', 'ninedeploy-test', file,
  ], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not resolve fixture path for Bash: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
}

export function runFixtureWrapper(
  spawnSync: SpawnSync,
  bin: string,
  script: string,
  env: NodeJS.ProcessEnv,
) {
  const bash = fixtureBash(spawnSync);
  // Windows' semicolon-separated PATH must first be normalized by Bash itself.
  return spawnSync(bash, [
    '-c', 'export PATH="$1:$PATH"; [ "$(command -v curl)" = "$1/curl" ] || exit 90; exec bash "$2"',
    'ninedeploy-test', fixtureBashPath(spawnSync, bin, bash), fixtureBashPath(spawnSync, script, bash),
  ], { env, encoding: 'utf8', timeout: 30000 });
}
