import { describe, expect, it } from 'vitest';
import type { BuildContext, Builder, DeployRuntime } from '../src/engine/types.js';

describe('engine types', () => {
  it('exposes the BuildContext / DeployRuntime / Builder contracts', async () => {
    const runtime: DeployRuntime = { runtimeId: 'c1', port: 3000, healthPath: '/health' };
    const ctx: BuildContext = {
      deploymentId: 7,
      service: {} as never,
      workDir: '/work',
      commitSha: 'abc',
      env: { K: 'V' },
      log: () => {},
    };
    const builder: Builder = {
      buildAndRun: async () => runtime,
      isHealthy: async () => true,
      stop: async () => {},
    };

    expect(runtime.runtimeId).toBe('c1');
    expect(runtime.port).toBe(3000);
    expect(runtime.healthPath).toBe('/health');
    expect(ctx.deploymentId).toBe(7);
    expect(ctx.env).toEqual({ K: 'V' });
    await expect(builder.buildAndRun(ctx)).resolves.toBe(runtime);
  });
});
