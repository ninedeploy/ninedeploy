import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/smoke-multinode.mjs', import.meta.url));
describe('focused multi-node smoke modes', () => {
  it.each([
    ['--swarm-only', '--no-swarm'],
    ['--swarm-only', '--new-node-features'],
    ['--node-operations-only', '--new-node-features'],
  ])('rejects incompatible flags before creating Docker resources: %s %s', (...flags) => {
    const result = spawnSync(process.execPath, [script, '--image=fixture:local', ...flags], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Select one focused smoke mode/);
    expect(result.stdout).not.toContain('topology:');
  });
});
