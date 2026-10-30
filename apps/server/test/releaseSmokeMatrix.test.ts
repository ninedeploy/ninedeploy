import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
type Step = { id?: string; run?: string; if?: string; 'continue-on-error'?: boolean; 'timeout-minutes'?: number };
type Job = { needs?: string | string[]; if?: string; 'continue-on-error'?: boolean; permissions?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; 'max-parallel'?: number; matrix?: { suite?: string[] } }; steps?: Step[] };
const jobs = () => (load(readFileSync(new URL('../../../.github/workflows/release-publish.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs;
const suites = ['upgrade-journey', 'agent-runtime', 'panel-lifecycle', 'public-canary', 'public-lifecycle', 'replica-databases', 'node-infrastructure'];
// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub shell variable in the actual smoke commands.
const image = 'ghcr.io/ninedeploy/ninedeploy:${RELEASE_TAG}';
const command = (name: string, flags = '') => `node scripts/${name}.mjs --image="${image}"${flags}`;
const expected = [
  'node scripts/smoke-upgrade.mjs --from="$FROM_TAG" --to="$RELEASE_TAG"',
  command('smoke-user-journey'), command('smoke-user-journey', ' --compose-release-only'),
  command('smoke-multinode', ' --node-operations-only --no-swarm'), command('smoke-container-readiness'), command('smoke-local-docker-readiness'),
  command('smoke-container-metrics'), command('smoke-container-lifecycle'), command('smoke-container-generation-stop'),
  command('smoke-agent-creation-drain'), command('smoke-node-lifecycle-controller'),
  command('smoke-node-lifecycle-fanout'), command('smoke-node-canary', ' --proof=.temp_files/release-node-smoke'),
  command('smoke-node-canary', ' --autoscale-only --proof=.temp_files/release-node-autoscale'),
  command('smoke-node-canary', ' --lifecycle-only --proof=.temp_files/release-node-smoke'),
  command('smoke-node-canary', ' --initial-stop-only --proof=.temp_files/release-node-initial-stop'),
  command('smoke-node-canary', ' --mixed-agent-only --proof=.temp_files/release-node-mixed-agent'),
  command('smoke-node-limits', ' --proof=.temp_files/release-node-limits'),
  command('smoke-node-canary', ' --replica-databases-only --proof=.temp_files/release-node-smoke'),
  command('smoke-multinode', ' --new-node-features --no-swarm'), command('smoke-multinode', ' --swarm-only'),
];
describe('complete parallel release smoke gate', () => {
  it('requires isolated node autoscale routing before the main image can be published', () => {
    const ci = (load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs;
    const build = ci['docker-image'];
    const step = build.steps!.find(item => item.run?.includes('--autoscale-only'));
    expect(step?.run).toBe('node scripts/smoke-node-canary.mjs --image=ninedeploy:ci --autoscale-only --proof=.temp_files/ci-node-autoscale');
    expect(step?.['continue-on-error']).not.toBe(true);
    expect([ci['publish-image'].needs ?? []].flat()).toContain('docker-image');
  });
  it('keeps seven mandatory cohorts bounded to three independent runners', () => {
    const smoke = jobs()['smoke-published-image'];
    expect(smoke.strategy?.matrix?.suite).toEqual(suites);
    expect(smoke.strategy?.['max-parallel']).toBe(3);
    expect(smoke.strategy?.['fail-fast']).toBe(false);
    expect(smoke['continue-on-error']).not.toBe(true); expect(smoke.if).toBeUndefined();
    expect(smoke.permissions).toEqual({ contents: 'read', packages: 'read' });
  });
  it.each([true, false])('runs every required smoke exactly once when a previous release exists: %s', previousExists => {
    const smoke = jobs()['smoke-published-image'], scheduled: string[] = [];
    const steps = smoke.steps!.filter(step => step.run?.startsWith('node scripts/smoke-'));
    expect(steps.map(step => step.run).sort()).toEqual([...expected].sort());
    for (const step of steps) {
      expect(step['continue-on-error']).not.toBe(true);
      expect(step.if).toMatch(/^matrix[.]suite == '[a-z-]+'(?: && steps[.]previous[.]outputs[.]from != '')?$/);
      if (step.run!.includes('smoke-upgrade.mjs')) expect(step.if).toContain("&& steps.previous.outputs.from != ''");
      else expect(step.if).not.toContain('steps.previous');
    }
    for (const suite of smoke.strategy?.matrix?.suite ?? []) {
      for (const step of steps) {
        const selected = /^matrix[.]suite == '([a-z-]+)'/.exec(step.if!);
        if (selected?.[1] === suite && (previousExists || !step.if!.includes('steps.previous'))) scheduled.push(step.run!);
      }
    }
    expect(scheduled.sort()).toEqual(expected.filter(run => previousExists || !run.includes('smoke-upgrade.mjs')).sort());
    expect(new Set(scheduled).size).toBe(scheduled.length);
  });
  it('limits previous-release lookup to the upgrade cohort and gates publication on the entire matrix', () => {
    const all = jobs(), previous = all['smoke-published-image'].steps!.find(step => step.id === 'previous');
    expect(previous?.if).toBe("matrix.suite == 'upgrade-journey'");
    expect([all['promote-release'].needs ?? []].flat()).toEqual(expect.arrayContaining(['publish-image', 'smoke-published-image']));
    expect(all['promote-release'].if).toBeUndefined(); expect(all['promote-release']['continue-on-error']).not.toBe(true);
    expect([all['publish-npm'].needs ?? []].flat()).toContain('promote-release');
  });
  it('pulls the candidate on every fresh runner before any smoke command', () => {
    const steps = jobs()['smoke-published-image'].steps!;
    const pull = steps.findIndex(step => step.run === `docker pull "${image}"`);
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(steps[pull]!.if).toBeUndefined();
    for (const [index, step] of steps.entries()) {
      if (step.run?.startsWith('node scripts/smoke-')) expect(index).toBeGreaterThan(pull);
    }
  });
});
