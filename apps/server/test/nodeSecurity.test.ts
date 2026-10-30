import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { isSupportedNodeVersion, NODE_SECURITY_RANGE } from '../../../scripts/check-node-version.mjs';
import { fixtureBash, fixtureBashPath } from './bashFixture.js';

const bash = fixtureBash(spawnSync);
const installer = fixtureBashPath(spawnSync, fileURLToPath(new URL('../../../install.sh', import.meta.url)), bash);
const run = (script: string, ...args: string[]) => spawnSync(bash, ['-c', `NINEDEPLOY_INSTALL_SOURCE_ONLY=1 . "$1"\n${script}`, 'node-security-test', installer, ...args], { encoding: 'utf8', timeout: 10000 });

describe('Node security baseline', () => {
  it.each([
    ['22.23.3', false], ['22.23.4', true], ['22.24.0', true],
    ['24.22.0', false], ['24.22.1', true], ['24.22.2', true], ['24.23.0', true],
    ['26.9.0', false], ['26.12.0', false], ['26.12.1', true], ['v26.12.1', true], ['26.13.0', true],
    ['20.99.0', false], ['22.13.0', false], ['23.99.0', false], ['25.99.0', false], ['27.0.0', false], ['28.0.0', false],
    ['26.12.1-rc.1', false], ['26.12', false], ['', false], ['26.012.1', false], ['26.12.1 extra', false],
  ])('accepts %s = %s in both the release gate and standalone installer', (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
    const result = run('supported_node_version "$2"', version);
    expect(result.status, result.stderr).toBe(expected ? 0 : 1);
  });

  it('checks the actual runtime from the canonical release command', () => {
    const path = fileURLToPath(new URL('../../../scripts/check-node-version.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('security baseline satisfied');
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['release:check'].startsWith('node scripts/check-node-version.mjs && ')).toBe(true);
    for (const name of ['package.json', 'apps/server/package.json', 'apps/cli/package.json', 'packages/mcp/package.json']) {
      expect(JSON.parse(readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8')).engines.node).toBe(NODE_SECURITY_RANGE);
    }
  });

  it('pins every CI runtime and checks it before installing dependencies, including historical tags without the new script', () => {
    const version = readFileSync(new URL('../../../.node-version', import.meta.url), 'utf8').trim();
    expect(isSupportedNodeVersion(version)).toBe(true);
    let found = 0;
    for (const file of ['ci.yml', 'release-publish.yml', 'publish-npm.yml']) {
      const workflow = load(readFileSync(new URL(`../../../.github/workflows/${file}`, import.meta.url), 'utf8')) as { jobs: Record<string, { steps?: { uses?: string; name?: string; run?: string; with?: Record<string, unknown> }[] }> };
      for (const { steps = [] } of Object.values(workflow.jobs)) {
        const setup = steps.findIndex(s => s.uses?.startsWith('actions/setup-node@'));
        if (setup < 0) continue;
        found++;
        expect(steps[setup]!.with?.['node-version']).toBe(version);
        const check = steps.findIndex(s => s.name === 'Verify Node security baseline');
        expect(check).toBeGreaterThan(setup);
        expect(steps[check]!.run).toContain(`process.versions.node !== '${version}'`);
        const install = steps.findIndex(s => s.name === 'Install dependencies');
        if (install >= 0) expect(install).toBeGreaterThan(check);
      }
    }
    expect(found).toBe(6);
  });
});

describe('standalone installer Node upgrade', () => {
  const simulate = (current: string, next: string, installCode = '0', manager = 'apt') => run(`
task_node_version="$2"
task_next_node="$3"
task_install_result="$4"
task_manager="$5"
node() { printf '%s\\n' "$task_node_version"; }
command() {
  case "$*" in
    '-v node') [ "$task_node_version" != missing ] ;;
    '-v apt-get') [ "$task_manager" = apt ] ;;
    '-v brew') [ "$task_manager" = brew ] ;;
    *) builtin command "$@" ;;
  esac
}
install_node() { printf 'install-attempted major=%s\\n' "\${1:-unset}"; task_node_version="$task_next_node"; return "$task_install_result"; }
brew() { printf 'brew-attempted\\n'; task_node_version="$task_next_node"; return "$task_install_result"; }
ensure_node
`, current, next, installCode, manager);

  it('leaves a patched runtime in place', () => {
    const result = simulate('v22.23.4', 'v24.22.1');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('install-attempted');
  });

  it('upgrades an old runtime and verifies the newly selected executable', () => {
    const result = simulate('v26.9.0', 'v26.12.1');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('install-attempted');
    expect(result.stdout).toContain('major=26');
    expect(result.stdout).toContain('v26.12.1 meets the security baseline');
  });

  it('installs a patched LTS when Node is absent', () => {
    const result = simulate('missing', 'v24.22.1');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('install-attempted');
  });

  it('upgrades through Homebrew and verifies the Node selected on PATH', () => {
    const result = simulate('v24.22.0', 'v24.22.1', '0', 'brew');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('brew-attempted');
    expect(result.stdout).toContain('v24.22.1 meets the security baseline');
  });

  it('refuses a stale mirror or PATH even after the package manager reports success', () => {
    const result = simulate('v26.9.0', 'v26.12.0');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('still misses the security baseline');
  });

  it.each([['v22.23.3', 'v22.23.4', '22'], ['v24.22.0', 'v24.22.1', '24']])('keeps the existing supported major %s', (current, next, major) => {
    const result = simulate(current, next);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`major=${major}`);
  });

  it('refuses a package manager or PATH that switches a Node 26 host to Node 24', () => {
    const result = simulate('v26.9.0', 'v24.22.1');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('still misses the security baseline');
  });

  it('refuses to downgrade an unsupported future major', () => {
    const result = simulate('v27.0.0', 'v24.22.1');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('will not downgrade');
    expect(result.stdout).not.toContain('install-attempted');
  });

  it('moves an unsupported Node 25 host forward to Node 26', () => {
    const result = simulate('v25.9.0', 'v26.12.1');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('major=26');
  });

  it('tries only the requested NodeSource line, including its consented fallback', () => {
    const result = run('install_node_apt() { printf "apt-major=%s\\n" "$1"; return 1; }; run_vendor_script() { printf "vendor=%s\\n" "$1"; return 1; }; install_node 26');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apt-major=26');
    expect(result.stdout).toContain('setup_26.x');
    expect(result.stdout).not.toContain('setup_24.x');
    expect(result.stdout).not.toContain('setup_22.x');
  });

  it('stops after an unsuccessful runtime installation', () => {
    const result = simulate('v26.9.0', 'v24.22.1', '1');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Could not install a secure Node.js runtime');
  });

  it('gives a manual upgrade instruction when no supported package manager exists', () => {
    const result = simulate('v26.9.0', 'v24.22.1', '0', 'none');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Install Node.js');
    expect(result.stdout).not.toContain('install-attempted');
  });
});
