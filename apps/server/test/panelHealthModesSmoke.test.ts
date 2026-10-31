import { expect, it, vi } from 'vitest';
import { smokePanelHealthModes } from '../../../scripts/lib/smoke-panel-health-modes.mjs';

function fixture(fail = false) {
  const traffic: Array<{ status: number; body: string }> = [];
  let mode = 'http', deploymentId = 0;
  const report = vi.fn(), saveTraffic = vi.fn();
  const api = vi.fn(async (path: string, options: { body?: Record<string, unknown> } = {}) => {
    if (path.endsWith('/deploys')) {
      traffic.push(...Array.from({ length: 30 }, (_, n) => ({ status: fail && mode === 'running' && n === 0 ? 502 : 200, body: mode })));
      return { deploymentId: ++deploymentId };
    }
    if (options.body?.healthCheck) mode = String(options.body.healthCheck);
    return { id: 1 };
  });
  return { report, saveTraffic, args: { api, primary: () => ({ status: 0, out: JSON.stringify(traffic) }), id: 1,
    fixtureImage: 'fixture:1', domain: { hostname: 'app.test' },
    until: async (fn: () => unknown) => { if (!await fn()) throw Error('Expected fixture state'); },
    success: async () => {}, report, saveTraffic } };
}

it('requires successful traffic across all five normal deployment healthcheck modes', async () => {
  const f = fixture();
  await smokePanelHealthModes(f.args);
  expect(f.report.mock.calls.map(call => call[0].case)).toEqual(['panel-health-http', 'panel-health-http-strict', 'panel-health-tcp', 'panel-health-running', 'panel-health-command']);
  expect(f.saveTraffic).toHaveBeenCalledTimes(5);
});

it('retains every mode result but rejects even one deployment 502', async () => {
  const f = fixture(true);
  await expect(smokePanelHealthModes(f.args)).rejects.toThrow(/preserve successful routed traffic/);
  expect(f.report).toHaveBeenCalledTimes(5);
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ case: 'panel-health-running', unexpected502: 1, errors: 1 }));
});
