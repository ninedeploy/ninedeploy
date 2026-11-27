import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
type Step = { id?: string; run?: string; if?: string; 'continue-on-error'?: boolean; 'timeout-minutes'?: number; name?: string; uses?: string; with?: { path?: string } };
type Job = { needs?: string | string[]; if?: string; 'continue-on-error'?: boolean; permissions?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; 'max-parallel'?: number; matrix?: { suite?: string[]; group?: string[] } }; steps?: Step[] };
const jobs = () => (load(readFileSync(new URL('../../../.github/workflows/release-publish.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs;
const imageJob = () => (load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs['docker-image'];
const suites = ['upgrade', 'user-journey', 'agent-runtime', 'panel-lifecycle', 'node-canary', 'node-autoscaling', 'public-lifecycle', 'replica-databases', 'node-infrastructure', 'swarm-artifacts', 'node-sleep', 'node-wake', 'sleep-restoration'];
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
  command('smoke-panel-domain', ' --proof=.temp_files/release-panel-domain'),
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
// What each smoke took in the 0.20.0 release run (November 25, 2026), in seconds. A new smoke
// is measured on its first release run and entered here, so the bound below stays honest.
const measured: Array<[string, number]> = [
  ['node scripts/smoke-upgrade.mjs --from="$FROM_TAG" --to="$RELEASE_TAG"', 166],
  [command('smoke-user-journey'), 683], [command('smoke-user-journey', ' --compose-release-only'), 68],
  [command('smoke-multinode', ' --node-operations-only --no-swarm'), 122], [command('smoke-container-readiness'), 53], [command('smoke-local-docker-readiness'), 27],
  [command('smoke-primary-network-readiness', ' --proof=.temp_files/release-primary-network-readiness'), 31],
  [command('smoke-serving-traffic', ' --proof=.temp_files/release-serving-traffic'), 129],
  [command('smoke-wake-catcher', ' --proof=.temp_files/release-wake-catcher'), 2],
  [command('smoke-wake-recovery', ' --proof=.temp_files/release-wake-recovery'), 26],
  [command('smoke-container-metrics'), 22], [command('smoke-container-lifecycle'), 45], [command('smoke-container-generation-stop'), 17],
  [command('smoke-agent-creation-drain'), 26],
  // Not in 0.20.0: 42 seconds on a GitHub-hosted runner on November 27, 2026 (CI run 45988797231; the
  // image travels into an isolated daemon), 90 on a developer machine.
  [command('smoke-panel-domain', ' --proof=.temp_files/release-panel-domain'), 42], [command('smoke-node-lifecycle-controller'), 212],
  [command('smoke-node-lifecycle-fanout'), 236], [command('smoke-node-canary', ' --proof=.temp_files/release-node-smoke'), 676],
  [command('smoke-node-canary', ' --autoscale-only --proof=.temp_files/release-node-autoscale'), 327],
  [command('smoke-node-canary', ' --autoscale-rps-only --proof=.temp_files/release-node-autoscale-rps'), 487],
  [command('smoke-node-canary', ' --autoscale-database-only --proof=.temp_files/release-node-autoscale-database'), 363],
  [command('smoke-node-canary', ' --health-modes-only --proof=.temp_files/release-panel-health-modes'), 235],
  [command('smoke-node-canary', ' --lifecycle-only --proof=.temp_files/release-node-smoke'), 357],
  [command('smoke-node-canary', ' --initial-stop-only --proof=.temp_files/release-node-initial-stop'), 116],
  [command('smoke-node-canary', ' --mixed-agent-only --proof=.temp_files/release-node-mixed-agent'), 120],
  [command('smoke-node-limits', ' --proof=.temp_files/release-node-limits'), 134],
  [command('smoke-node-canary', ' --replica-databases-only --proof=.temp_files/release-node-smoke'), 148],
  [command('smoke-multinode', ' --new-node-features --no-swarm'), 146], [command('smoke-multinode', ' --swarm-only'), 463],
  [command('smoke-node-canary', ' --swarm-runtime-only --proof=.temp_files/release-swarm-runtime'), 346],
  [command('smoke-node-canary', ' --manual-wake-only --proof=.temp_files/release-manual-node-wake'), 473],
  [command('smoke-node-canary', ' --sleep-restoration-only --proof=.temp_files/release-sleep-restoration'), 430],
  [command('smoke-node-canary', ' --automatic-sleep-only --proof=.temp_files/release-automatic-node-sleep'), 609],
];
// The cohorts' themes: until November 27, 2026 four cohorts held two or three themes each, and
// the longest took 25.9 minutes where the longest single theme takes 13.6.
const LONGEST_COHORT_SECONDS = 14 * 60;
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
  it('requires public manual/automatic node wake and lost-routing restoration on the pushed image, each in a cohort of its own', () => {
    const steps = jobs()['smoke-published-image'].steps!;
    const uploads = [
      ['--manual-wake-only', 'node-wake', 'Preserve public manual node wake receipts', 'release-node-sleep-wake-manual-wake', 'manual-node-wake'],
      ['--sleep-restoration-only', 'sleep-restoration', 'Preserve lost-routing restoration receipts', 'release-node-sleep-wake-sleep-restoration', 'sleep-restoration'],
      ['--automatic-sleep-only', 'node-sleep', 'Preserve public automatic node sleep receipts', 'release-node-sleep-wake-automatic-sleep', 'automatic-node-sleep'],
    ] as const;
    const kept = new Set<string>();
    for (const [mode, suite, uploadName, artifact, proof] of uploads) {
      const smoke = steps.find(step => step.run?.includes(mode));
      expect(smoke?.if).toBe(`matrix.suite == '${suite}'`);
      expect(smoke?.['continue-on-error']).not.toBe(true);
      expect(smoke?.['timeout-minutes']).toBeGreaterThanOrEqual(12);
      // The smoke's receipts leave with it, also when it fails.
      const upload = steps.find(step => step.name === uploadName);
      expect(upload?.if).toBe(`always() && matrix.suite == '${suite}'`);
      const inputs = upload?.with as { name?: string; path?: string } | undefined;
      expect(inputs?.name).toBe(artifact);
      const paths = inputs?.path?.trim().split('\n').map(path => path.trim()) ?? [];
      for (const path of paths) {
        expect(path).toMatch(new RegExp(`^\\.temp_files/release-${proof}/[a-z-]+\\.json$`));
        kept.add(path);
      }
      expect(paths).toContain(`.temp_files/release-${proof}/runtime-result.json`);
      expect(paths).toContain(`.temp_files/release-${proof}/runtime-cleanup.json`);
    }
    expect(kept.size).toBeGreaterThanOrEqual(20);
  });
  it('keeps every cohort short: each smoke has its measured time, and no cohort holds more than 14 minutes of it', () => {
    const smoke = jobs()['smoke-published-image'];
    const seconds = new Map(measured);
    expect(new Set(measured.map(([run]) => run)).size).toBe(measured.length);
    expect([...seconds.keys()].sort()).toEqual(expected.slice().sort());
    const perSuite = new Map<string, number>();
    for (const step of smoke.steps!.filter(step => step.run?.startsWith('node scripts/smoke-'))) {
      // A new smoke is measured on its first release run and entered above.
      const time = seconds.get(step.run!);
      expect(time, step.run).toBeDefined();
      const suite = /^matrix[.]suite == '([a-z-]+)'/.exec(step.if!)![1]!;
      perSuite.set(suite, (perSuite.get(suite) ?? 0) + time!);
    }
    expect([...perSuite.keys()].sort()).toEqual(suites.slice().sort());
    expect(Math.max(...perSuite.values())).toBeLessThanOrEqual(LONGEST_COHORT_SECONDS);
  });
  it('serves the panel domain through the proxy network, on the published image and on every CI image', () => {
    // The panel's own domain does not depend on the address its port is published on.
    const steps = jobs()['smoke-published-image'].steps!;
    const smoke = steps.find(step => step.run?.includes('scripts/smoke-panel-domain.mjs'));
    expect(smoke?.if).toBe("matrix.suite == 'agent-runtime'");
    expect(smoke?.['continue-on-error']).not.toBe(true);
    expect(smoke?.['timeout-minutes']).toBe(8);
    const upload = steps.find(step => step.name === 'Preserve panel domain evidence');
    expect(upload?.if).toBe("always() && matrix.suite == 'agent-runtime'");
    expect((upload?.with as { name?: string } | undefined)?.name).toBe('release-panel-domain');
    const ci = (load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }).jobs['docker-image'].steps!;
    expect(ci.find(step => step.run?.includes('scripts/smoke-panel-domain.mjs'))?.if).toBe("matrix.group == 'routing'");
  });
  it('keeps the failure diagnostics on the cohorts whose proof folders it lists', () => {
    const diagnostics = jobs()['smoke-published-image'].steps!.find(step => step.name === 'Preserve failed node smoke diagnostics')!;
    const listed = ['node-canary', 'node-autoscaling', 'public-lifecycle', 'replica-databases'];
    for (const suite of listed) expect(diagnostics.if).toContain(`matrix.suite == '${suite}'`);
    for (const [name, suite] of [['--proof=.temp_files/release-node-smoke', 'node-canary'], ['--autoscale-rps-only', 'node-autoscaling'], ['--initial-stop-only', 'public-lifecycle'], ['--replica-databases-only', 'replica-databases']] as const) {
      expect(jobs()['smoke-published-image'].steps!.find(step => step.run?.includes(name) && step.if === `matrix.suite == '${suite}'`)).toBeDefined();
    }
    expect(diagnostics.if).toMatch(/^failure\(\) && /);
    expect(diagnostics['if']).not.toContain('public-canary');
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
    expect(previous?.if).toBe("matrix.suite == 'upgrade'");
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
