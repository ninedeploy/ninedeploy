import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
const readWorkflow = (name: string) => load(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8')) as Workflow;

describe('release delivery invariants', () => {
  it('never deletes historical registry versions during publication', () => {
    const workflow = readWorkflow('release-publish.yml');
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) expect(step.run ?? '').not.toMatch(/gh api --method DELETE/);
    }
  });

  it('runs real database integration checks before publishing a release image', () => {
    const steps = readWorkflow('release-publish.yml').jobs['publish-image']!.steps;
    const integration = steps.findIndex((step) => step.run?.includes('vitest.integration.config.ts'));
    const push = steps.findIndex((step) => step.with?.['push'] === true);
    expect(integration).toBeGreaterThan(-1);
    expect(steps[integration]!.env?.['RUN_INTEGRATION']).toBe('1');
    expect(push).toBeGreaterThan(integration);
  });

  it('uses lowercase OCI repository names on the main publishing path', () => {
    const steps = readWorkflow('ci.yml').jobs['publish-image']!.steps;
    const push = steps.find((step) => step.with?.['push'] === true)!;
    const tags = String(push.with?.['tags']);
    expect(tags).not.toContain('github.repository');
    expect(tags).toContain('ghcr.io/ninedeploy/ninedeploy:edge');
  });
});
