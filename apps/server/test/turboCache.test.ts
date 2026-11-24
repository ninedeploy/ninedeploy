import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const turbo = createRequire(import.meta.url).resolve('turbo');
const config = readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8');
const manager = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).packageManager as string;
const temporaryRoot = realpathSync(tmpdir());
const COMMAND_TIMEOUT_MS = 15_000;
// The first test runs eight subprocesses. Keep the per-command deadline
// and give the outer test that total budget plus setup and teardown time.
const FIXTURE_TIMEOUT_MS = 8 * COMMAND_TIMEOUT_MS + 15_000;
let directory: string;

function write(file: string, text: string) {
  const target = join(directory, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [turbo, 'run', 'test', '--filter=@ninedeploy/server', '--cache=local:rw', ...args], {
    cwd: directory, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1', TURBO_TOKEN: '', TURBO_TEAM: '' },
  });
  if (result.error) throw result.error;
  return { ...result, output: result.stdout + result.stderr };
}

function hash() {
  const result = run('--dry=json');
  expect(result.status, result.output).toBe(0);
  const plan = JSON.parse(result.stdout) as { tasks: Array<{ taskId: string; hash: string }> };
  return plan.tasks.find(task => task.taskId === '@ninedeploy/server#test')!.hash;
}

beforeEach(() => {
  directory = mkdtempSync(join(temporaryRoot, 'nd-turbo-contract-'));
  write('package.json', JSON.stringify({ name: 'cache-contract', private: true, packageManager: manager }));
  write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
  write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  apps/server: {}\n");
  write('.gitignore', '.temp_files/\n.turbo/\nnode_modules/\n');
  write('turbo.json', config);
  write('apps/server/package.json', JSON.stringify({ name: '@ninedeploy/server', scripts: { test: 'node ../../scripts/cache-fixture.mjs' } }));
  write('docs/SUPPORT_MATRIX.md', 'valid support matrix\n');
  write('install.sh', '#!/bin/sh\nexit 0\n');
  write('.github/workflows/ci.yml', 'name: valid\n');
  write('scripts/cache-fixture.mjs', [
    "import { readFileSync } from 'node:fs';",
    "const text = readFileSync(new URL('../docs/SUPPORT_MATRIX.md', import.meta.url), 'utf8');",
    "if (text.includes('BROKEN')) { console.error('BROKEN_EXTERNAL_INPUT'); process.exit(42); }",
    "console.log('FIXTURE_EXECUTED');",
  ].join('\n'));
  for (const args of [['init', '--quiet'], ['add', '--all']]) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
  }
});

afterEach(() => {
  // The fixture contains its own .git/cache. Never recurse through another checkout.
  if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('nd-turbo-contract-') || realpathSync(directory) !== directory) {
    throw new Error('Refusing cleanup outside the owned cache fixture');
  }
  rmSync(directory, { recursive: true, force: true });
});

it('a cached green result cannot hide a broken root document consumed by the task', { timeout: FIXTURE_TIMEOUT_MS }, () => {
  // A cold pnpm invocation can normalize the minimal fixture lockfile. Warm
  // the cache only after that bootstrap and assert the inputs then stay fixed.
  const bootstrap = run();
  expect(bootstrap.status, bootstrap.output).toBe(0);
  const settled = hash();
  const warm = run();
  expect(warm.status, warm.output).toBe(0);
  expect(hash()).toBe(settled);
  const cached = run();
  expect(cached.status, cached.output).toBe(0);
  expect(cached.output).toMatch(/cache hit/);
  const before = hash();
  write('docs/SUPPORT_MATRIX.md', 'BROKEN root contract\n');
  const result = run();
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain('BROKEN_EXTERNAL_INPUT');
  expect(hash()).not.toBe(before);
});

it('hashes installer, workflow and script changes but ignores unrelated scratch environment files', { timeout: FIXTURE_TIMEOUT_MS }, () => {
  const before = hash();
  write('.temp_files/research/.env', 'UNRELATED_FIXTURE=1\n');
  write('.temp_files/unrelated.txt', 'scratch only\n');
  expect(hash()).toBe(before);
  write('install.sh', '#!/bin/sh\nexit 1\n');
  const installer = hash();
  expect(installer).not.toBe(before);
  write('.github/workflows/ci.yml', 'name: changed\n');
  const workflow = hash();
  expect(workflow).not.toBe(installer);
  write('scripts/new-contract.mjs', 'export const changed = true;\n');
  expect(hash()).not.toBe(workflow);
});
