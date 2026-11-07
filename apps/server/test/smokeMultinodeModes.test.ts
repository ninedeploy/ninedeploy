import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

// v0.18.22 release run 42295423571: a Swarm redeploy never settled, deploy() waited its
// 30-minute default, and the step's own 30-minute timeout killed it first, so no log was
// printed. Every Swarm-mode deploy wait must end (and report) well inside the step.
describe('Swarm smoke deploy waits', () => {
  const source = readFileSync(script, 'utf8');
  const swarmBody = (name: string) => {
    const start = source.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf('\nasync function ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };

  it.each(['swarmChecks', 'swarmSupportChecks'])('%s waits only through the bounded swarmDeploy', (name) => {
    const body = swarmBody(name);
    expect(body).not.toMatch(/(?<![\w.])deploy\(/);
    expect(body).not.toMatch(/waitDeployment\(/);
  });

  it('bounds a Swarm deploy well below the 30-minute release step and attaches runtime evidence', () => {
    const m = source.match(/const SWARM_DEPLOY_MS = (\d+) \* 60_000;/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(10);
    const helper = source.slice(source.indexOf('const swarmDeploy ='), source.indexOf('async function swarmChecks('));
    expect(helper).toMatch(/ms: SWARM_DEPLOY_MS/);
    expect(helper).toMatch(/diagnose:/);
    expect(helper).toMatch(/'service', 'ps'/);
    // A journalled deploy left unsettled on purpose (SwarmRecoveryPending) looks like a
    // hang from outside; the recovery journal is what tells the two apart.
    expect(helper).toContain('/swarm/recovery');
  });
});
