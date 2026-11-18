import { describe, expect, it } from 'vitest';
import { capacityChecks, limits, nearestRankP95, profile } from '../../../scripts/lib/capacity-baseline.mjs';

const valid = () => ({
  routes: Object.fromEntries(profile.routes.map(route => [route, { count: 120, p95Ms: 25 }])),
  requestFailures: 0,
  launchP95Ms: 5,
  panelLoopWindows: 59,
  panelLoopWindowP95Ms: 12,
  sqliteBusyLines: 0,
  storageGrowthBytes: 4096,
  deploymentsCompleted: 6,
  deploymentWaitP95Ms: 4000,
  logPendingEntries: 400,
  logFinalPendingEntries: 0,
  logMissingLines: 0,
  logDuplicateLines: 0,
  panelRestartMs: 2000,
});

describe('capacity baseline gates', () => {
  it('computes the nearest-rank p95 without changing samples or accepting missing measurements', () => {
    const values = Array.from({ length: 20 }, (_, index) => 20 - index);
    expect(nearestRankP95(values)).toBe(19);
    expect(values[0]).toBe(20);
    expect(nearestRankP95([])).toBeNull();
    expect(nearestRankP95([5, Number.NaN])).toBeNull();
  });

  it('passes a complete measurement within the predetermined budgets', () => {
    expect(capacityChecks(valid()).filter(check => !check.passed)).toEqual([]);
  });

  it('fails missing samples, queue loss, and an over-budget route independently', () => {
    const metrics = valid();
    const [first, missing] = profile.routes;
    metrics.routes[first]!.p95Ms = limits.routeP95Ms + 1;
    delete metrics.routes[missing];
    metrics.panelLoopWindows = 0;
    metrics.logMissingLines = 1;
    expect(capacityChecks(metrics).filter(check => !check.passed).map(check => check.name)).toEqual([
      `${first} p95 ms`,
      `${missing} samples`,
      `${missing} p95 ms`,
      'Panel event-loop samples',
      'Missing log lines',
    ]);
  });
});
