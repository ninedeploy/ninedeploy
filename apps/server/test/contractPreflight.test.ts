import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const temporaryRoot = realpathSync(tmpdir());
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(temporaryRoot, 'nd-contract-preflight-'));
  for (const part of ['scripts', 'apps/server', 'node_modules/vitest']) mkdirSync(join(directory, part), { recursive: true });
  copyFileSync(new URL('../../../scripts/check-contracts.mjs', import.meta.url), join(directory, 'scripts/check-contracts.mjs'));
});
afterEach(() => {
  if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('nd-contract-preflight-') || realpathSync(directory) !== directory) {
    throw new Error('Refusing cleanup outside the owned preflight fixture');
  }
  rmSync(directory, { recursive: true, force: true });
});

it.each([0, 42])('runs the installed runner without a shell and preserves its exit code %s', exitCode => {
  // Vitest is the external CLI boundary. Exercise our real launcher, including
  // cwd/path resolution and nonzero propagation, without running another suite.
  writeFileSync(join(directory, 'node_modules/vitest/vitest.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));",
    `process.exitCode = ${exitCode};`,
  ].join('\n'));
  const result = spawnSync(process.execPath, [join(directory, 'scripts/check-contracts.mjs')], {
    cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  expect(result.status, result.stdout + result.stderr).toBe(exitCode);
  const invocation = JSON.parse(readFileSync(join(directory, 'apps/server/invocation.json'), 'utf8')) as { args: string[]; cwd: string };
  expect(invocation.cwd).toBe(join(directory, 'apps/server'));
  expect(invocation.args).toEqual(expect.arrayContaining([
    'run', 'test/releaseNotes.test.ts', 'test/swarmRuntime.test.ts', 'test/turboCache.test.ts', 'test/auditCoverage.test.ts', 'test/proxySettingApplication.test.ts', 'test/maintenance.test.ts', 'test/engine/pitrCheckpoint.test.ts', 'test/lib/pitrRemote.test.ts', 'test/lib/pitrContinuous.test.ts', 'test/lib/pitrOrphans.test.ts', 'test/lib/nodePitr.test.ts', 'test/agentOpsPitr.test.ts', 'test/nodeFeatureRefusals.test.ts', '--no-coverage', '--maxWorkers=1',
  ]));
});
