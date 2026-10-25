import { describe, expect, it } from 'vitest';
import { run } from '../../src/lib/exec.js';
import { abortDeployment, deployAborted, outsideDeployScope, runInDeployScope } from '../../src/lib/deployAbort.js';

// A step that would outlive any test timeout unless the abort kills it.
const longStep = () => run(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 120_000 }, () => {});

describe('deploy abort scope', () => {
  it('kills the step a cancelled deploy is running instead of waiting for it', async () => {
    const started = Date.now();
    const result = runInDeployScope(9001, async () => {
      const step = longStep().then(() => 'finished', (err: Error) => err.message);
      setTimeout(() => expect(abortDeployment(9001)).toBe(true), 200);
      return { step: await step, aborted: deployAborted() };
    });
    const { step, aborted } = await result;
    expect(step).toMatch(/killed by signal/);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('lets the failure path run its cleanup after the abort', async () => {
    const out = await runInDeployScope(9002, async () => {
      abortDeployment(9002);
      // Started after the abort: cleanup (docker rm, rollback probe) must complete.
      await run(process.execPath, ['-e', 'process.exit(0)'], {}, () => {});
      return outsideDeployScope(async () => deployAborted());
    });
    expect(out).toBe(false);
  });

  it('reports no running pipeline for an unknown or finished deploy', async () => {
    expect(abortDeployment(9003)).toBe(false);
    await runInDeployScope(9003, async () => undefined);
    expect(abortDeployment(9003)).toBe(false);
  });

  it('never touches commands outside a deploy', async () => {
    abortDeployment(9004);
    expect(deployAborted()).toBe(false);
    await expect(run(process.execPath, ['-e', 'process.exit(0)'], {}, () => {})).resolves.toBeUndefined();
  });
});
