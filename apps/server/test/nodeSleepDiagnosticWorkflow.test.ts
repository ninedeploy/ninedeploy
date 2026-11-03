import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

type Step = { run?: string; if?: string; 'timeout-minutes'?: number; 'continue-on-error'?: boolean; with?: { path?: string } };
type Job = { if?: string; 'timeout-minutes'?: number; 'continue-on-error'?: boolean; env?: Record<string, string>; steps: Step[] };

it('reproduces the original sleep cohort on one hosted daemon with the same strict per-case deadlines', () => {
  const workflow = load(readFileSync(new URL('../../../.github/workflows/serving-traffic.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> };
  const job = workflow.jobs['automatic-sleep-cohort'];
  expect(job, 'The original manual → lost ACK → automatic sequence must be reproducible').toBeDefined();
  if (!job) throw new Error('Missing sleep diagnostic cohort');
  expect(job.if).toBe("github.event.inputs.sleep_cohort == 'true'");
  expect(job['timeout-minutes']).toBe(60); expect(job['continue-on-error']).not.toBe(true);
  expect(job.env).toMatchObject({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: 'default' });
  const cases = job.steps.filter(step => step.run?.startsWith('node scripts/smoke-node-canary.mjs'));
  expect(cases.map(step => step.run?.match(/--(manual-wake|sleep-restoration|automatic-sleep)-only/)?.[1]))
    .toEqual(['manual-wake', 'sleep-restoration', 'automatic-sleep']);
  expect(cases.map(step => step['timeout-minutes'])).toEqual([15, 12, 20]);
  for (const step of cases) { expect(step.run).toContain('--image="$SMOKE_IMAGE"'); expect(step['continue-on-error']).not.toBe(true); expect(step.if).toBeUndefined(); }
  const upload = job.steps.find(step => step.with?.path?.includes('automatic-sleep-failure.json'));
  expect(upload?.if).toBe('always()');
  const paths = upload?.with?.path?.trim().split('\n').map(path => path.trim()) ?? [];
  expect(paths).toContain('.temp_files/automatic-sleep-cohort/automatic/automatic-sleep-observations.json');
  expect(paths).toContain('.temp_files/automatic-sleep-cohort/automatic/automatic-sleep-journal.json');
  for (const path of paths) expect(path).toMatch(/^\.temp_files\/automatic-sleep-cohort\/(manual|restoration|automatic)\/[a-z-]+\.json$/);
});
