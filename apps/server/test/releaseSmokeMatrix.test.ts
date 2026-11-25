import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
type Step = { id?: string; run?: string; if?: string; 'continue-on-error'?: boolean; 'timeout-minutes'?: number; name?: string; uses?: string; with?: { path?: string } };
type Job = { needs?: string | string[]; if?: string; 'continue-on-error'?: boolean; permissions?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; 'max-parallel'?: number; matrix?: { suite?: string[]; group?: string[] } }; steps?: Step[] };
const jobs = () => (load(readFileSync(new URL('../../../.github/workflows/release-publish.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs;
const imageJob = () => (load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs['docker-image'];
const suites = ['upgrade-journey', 'agent-runtime', 'panel-lifecycle', 'public-canary', 'public-lifecycle', 'replica-databases', 'node-infrastructure', 'swarm-artifacts', 'node-sleep-wake'];
// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub shell variable in the actual smoke commands.
const image = 'ghcr.io/ninedeploy/ninedeploy:${RELEASE_TAG}';
const command = (name: string, flags = '') => `node scripts/${name}.mjs --image="${image}"${flags}`;
const expected = [
  'node scripts/smoke-upgrade.mjs --from="$FROM_TAG" --to="$RELEASE_TAG"',
  command('smoke-user-journey'), command('smoke-user-journey', ' --compose-release-only'),
  command('smoke-multinode', ' --node-operations-only --no-swarm'), command('smoke-container-readiness'), command('smoke-local-docker-readiness'),
  command('smoke-primary-network-readiness', ' --proof=.temp_files/release-primary-network-readiness'),
  command('smoke-serving-traffic', ' --proof=.temp_files/release-serving-traffic'),
  command('smoke-wake-catcher', ' --proof=.temp_files/release-wake-catcher'),
  command('smoke-wake-recovery', ' --proof=.temp_files/release-wake-recovery'),
  command('smoke-container-metrics'), command('smoke-container-lifecycle'), command('smoke-container-generation-stop'),
  command('smoke-agent-creation-drain'), command('smoke-node-lifecycle-controller'),
  command('smoke-node-lifecycle-fanout'), command('smoke-node-canary', ' --proof=.temp_files/release-node-smoke'),
  command('smoke-node-canary', ' --autoscale-only --proof=.temp_files/release-node-autoscale'),
  command('smoke-node-canary', ' --autoscale-rps-only --proof=.temp_files/release-node-autoscale-rps'),
  command('smoke-node-canary', ' --autoscale-database-only --proof=.temp_files/release-node-autoscale-database'),
  command('smoke-node-canary', ' --health-modes-only --proof=.temp_files/release-panel-health-modes'),
  command('smoke-node-canary', ' --lifecycle-only --proof=.temp_files/release-node-smoke'),
  command('smoke-node-canary', ' --initial-stop-only --proof=.temp_files/release-node-initial-stop'),
  command('smoke-node-canary', ' --mixed-agent-only --proof=.temp_files/release-node-mixed-agent'),
  command('smoke-node-limits', ' --proof=.temp_files/release-node-limits'),
  command('smoke-node-canary', ' --replica-databases-only --proof=.temp_files/release-node-smoke'),
  command('smoke-multinode', ' --new-node-features --no-swarm'), command('smoke-multinode', ' --swarm-only'),
  command('smoke-node-canary', ' --swarm-runtime-only --proof=.temp_files/release-swarm-runtime'),
  command('smoke-node-canary', ' --manual-wake-only --proof=.temp_files/release-manual-node-wake'),
  command('smoke-node-canary', ' --sleep-restoration-only --proof=.temp_files/release-sleep-restoration'),
  command('smoke-node-canary', ' --automatic-sleep-only --proof=.temp_files/release-automatic-node-sleep'),
];
describe('complete parallel release smoke gate', () => {
  it('requires staged catcher traffic acceptance and uploads only its public evidence in CI and release runs', () => {
    const ci = (load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs;
    for (const [steps, proof, condition] of [
      [ci['docker-image'].steps!, '.temp_files/ci-wake-recovery', "matrix.group == 'routing'"],
      [jobs()['smoke-published-image'].steps!, '.temp_files/release-wake-recovery', "matrix.suite == 'agent-runtime'"],
    ] as const) {
      const smoke = steps.find(step => step.run?.includes('scripts/smoke-wake-recovery.mjs'));
      expect(smoke).toBeDefined(); expect(smoke?.if).toBe(condition); expect(smoke?.['continue-on-error']).not.toBe(true);
      expect(smoke?.['timeout-minutes']).toBe(8); expect(smoke?.run).toContain(`--proof=${proof}`);
      const upload = steps.find(step => step.name === 'Preserve public catcher handoff evidence');
      expect(upload?.with?.path).toBe(`${proof}/public/`);
      expect(upload?.if).toContain('always()');
    }
  });
  it('requires isolated node autoscale routing before the main image can be published', () => {
    const ci = (load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs;
    const build = ci['docker-image'];
    const step = build.steps!.find(item => item.run?.includes('--autoscale-only'));
    expect(step?.run).toBe('node scripts/smoke-node-canary.mjs --image=ninedeploy:ci --autoscale-only --proof=.temp_files/ci-node-autoscale');
    expect(step?.if).toBe("matrix.group == 'autoscaling'");
    expect(step?.['continue-on-error']).not.toBe(true);
    const sql = build.steps!.find(item => item.run?.includes('--autoscale-database-only'));
    expect(sql?.run).toBe('node scripts/smoke-node-canary.mjs --image=ninedeploy:ci --autoscale-database-only --proof=.temp_files/ci-node-autoscale-database');
    expect(sql?.if).toBe("matrix.group == 'databases'");
    expect(sql?.['continue-on-error']).not.toBe(true);
    const rps = build.steps!.find(item => item.run?.includes('--autoscale-rps-only'));
    expect(rps?.run).toBe('node scripts/smoke-node-canary.mjs --image=ninedeploy:ci --autoscale-rps-only --proof=.temp_files/ci-node-autoscale-rps');
    expect(rps?.if).toBe("matrix.group == 'autoscaling-rps'");
    expect(rps?.['continue-on-error']).not.toBe(true);
    expect([ci['publish-image'].needs ?? []].flat()).toContain('docker-image');
  });
  it('runs the image job as six smoke groups, every smoke and its evidence in exactly one of them', () => {
    // One after another the smokes took 43 minutes of a runner on November 25, 2026, on every
    // push and every pull request. Each group's smokes own their Docker fixtures.
    const build = imageJob();
    const groups = build.strategy?.matrix?.group ?? [];
    expect(groups).toEqual(['canary', 'autoscaling', 'autoscaling-rps', 'databases', 'lifecycle', 'routing']);
    expect(build.strategy?.['fail-fast']).toBe(false);
    expect(build.strategy?.['max-parallel']).toBeUndefined();
    expect((build.strategy?.matrix as Record<string, unknown> | undefined)?.suite).toBeUndefined();
    const steps = build.steps ?? [];
    const setup = ['Verify Node security baseline', 'Setup pnpm', 'Install dependencies', 'Build the image'];
    const imageIsBuilt = steps.findIndex(step => step.name === 'Build the image');
    const smokes = new Set<string>();
    for (const [index, step] of steps.entries()) {
      const selected = /^(?:always\(\) && )?matrix\.group == '([a-z-]+)'$/.exec(step.if ?? '');
      if (!step.if) {
        // Only a checkout and the setup steps run in every group.
        expect(step.run === undefined || setup.includes(step.name ?? '')).toBe(true);
        continue;
      }
      expect(selected, `${step.name}: ${step.if}`).not.toBeNull();
      expect(groups).toContain(selected![1]);
      if (step.run?.startsWith('node scripts/smoke-')) {
        smokes.add(selected![1]);
        expect(step['continue-on-error']).not.toBe(true);
        expect(index).toBeGreaterThan(imageIsBuilt);
        expect(step['timeout-minutes']).toBeGreaterThan(0);
      }
      if (step.uses?.startsWith('actions/upload-artifact')) {
        // Evidence is kept when its smoke fails too.
        expect(step.if).toMatch(/^always\(\) && /);
        expect(step.name).toMatch(/^Preserve /);
      }
    }
    expect([...smokes].sort()).toEqual([...groups].sort());
  });
  it('starts every mandatory cohort at once, on one runner each', () => {
    const smoke = jobs()['smoke-published-image'];
    expect(smoke.strategy?.matrix?.suite).toEqual(suites);
    // Three at a time left the 26-minute node-sleep-wake cohort 27 minutes in the queue, on
    // November 18 and 25, 2026: the cohorts took 54 minutes where the longest one needs 26.
    expect(smoke.strategy?.['max-parallel']).toBe(smoke.strategy?.matrix?.suite?.length);
    expect(smoke.strategy?.['fail-fast']).toBe(false);
    expect(smoke['continue-on-error']).not.toBe(true); expect(smoke.if).toBeUndefined();
    expect(smoke.permissions).toEqual({ contents: 'read', packages: 'read' });
  });
  it('requires Swarm artifact recovery and retains enumerated public receipts even after failure', () => {
    const steps = jobs()['smoke-published-image'].steps!;
    const smoke = steps.find(step => step.run?.includes('--swarm-runtime-only'));
    expect(smoke?.if).toBe("matrix.suite == 'swarm-artifacts'");
    expect(smoke?.['continue-on-error']).not.toBe(true);
    expect(smoke?.['timeout-minutes']).toBe(15);
    const upload = steps.find(step => step.name === 'Preserve public Swarm artifact recovery receipts');
    expect(upload?.if).toBe("always() && matrix.suite == 'swarm-artifacts'");
    expect(upload?.with?.path?.trim().split('\n').map(path => path.trim())).toEqual([
      'runtime-result.json', 'runtime-cleanup.json', 'swarm-source-traffic.json',
      'swarm-target-traffic.json', 'swarm-failure-traffic.json', 'swarm-failure-state.json',
      'cases.json', 'failure-state.json',
    ].map(file => `.temp_files/release-swarm-runtime/${file}`));
  });
  it('requires public manual/automatic node wake and lost-routing restoration on the pushed image', () => {
    const steps = jobs()['smoke-published-image'].steps!;
    for (const mode of ['--manual-wake-only', '--sleep-restoration-only', '--automatic-sleep-only']) {
      const smoke = steps.find(step => step.run?.includes(mode));
      expect(smoke?.if).toBe("matrix.suite == 'node-sleep-wake'");
      expect(smoke?.['continue-on-error']).not.toBe(true);
      expect(smoke?.['timeout-minutes']).toBeGreaterThanOrEqual(12);
    }
    const upload = steps.find(step => step.name === 'Preserve public node sleep and wake receipts');
    expect(upload?.if).toBe("always() && matrix.suite == 'node-sleep-wake'");
    const paths = upload?.with?.path?.trim().split('\n').map(path => path.trim()) ?? [];
    expect(paths.length).toBeGreaterThanOrEqual(20);
    for (const path of paths) expect(path).toMatch(/^\.temp_files\/release-(?:manual-node-wake|sleep-restoration|automatic-node-sleep)\/[a-z-]+\.json$/);
    for (const name of ['manual-node-wake', 'sleep-restoration', 'automatic-node-sleep']) {
      expect(paths).toContain(`.temp_files/release-${name}/runtime-result.json`);
      expect(paths).toContain(`.temp_files/release-${name}/runtime-cleanup.json`);
    }
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
