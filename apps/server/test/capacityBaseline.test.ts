import { describe, expect, it } from 'vitest';
import { capacityChecks, limits, nearestRankP95, profile } from '../../../scripts/lib/capacity-baseline.mjs';
import { faultChecks, faultProfiles, fullDiskProbe } from '../../../scripts/lib/capacity-resilience.mjs';

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

  it('keeps the healthy queue budget and applies the separate slow-node budget', () => {
    const metrics = { ...valid(), deploymentWaitP95Ms: 40_000 };
    const slow = { ...limits, deploymentWaitP95Ms: faultProfiles['slow-node'].deploymentWaitP95Ms };
    expect(capacityChecks(metrics).filter(check => !check.passed).map(check => check.name))
      .toEqual(['Deployment queue wait p95 ms']);
    expect(capacityChecks(metrics, slow).every(check => check.passed)).toBe(true);
  });

  it('requires real fault evidence and bounded recovery', () => {
    const faults = {
      'slow-node': { delayedChunks: 1, slowProbeMs: 750, recoveryMs: 8001 },
      'full-disk': { errno: 'ENOSPC', fullFreeBytes: 0, writeRejected: true, noPartialWrite: true,
        writeRetried: true, sqliteFullLines: 0, observedHoldMs: 8000, recoveryMs: 2000 },
      'log-outage': { offlineConnectionRefused: true, deliveredBeforeRestore: 0, pendingBeforeRestore: 0, recoveryMs: 2000 },
    };
    for (const [scenario, metrics] of Object.entries(faults)) {
      expect(faultChecks(scenario, metrics).filter(check => !check.passed)).toHaveLength(1);
      expect(faultChecks(scenario, {}).every(check => !check.passed)).toBe(true);
    }
  });

  it('releases the bounded disk filler if the public write probe throws', async () => {
    const attempts: string[] = [];
    const aborted = new Error('fixture request aborted');
    await expect(fullDiskProbe({
      disk: async (action: string) => {
        attempts.push(action);
        return { errno: 'ENOSPC', after: { freeBytes: 0 } };
      },
      call: async () => { throw aborted; },
      inventory: async () => [],
    }, {})).rejects.toBe(aborted);
    expect(attempts).toEqual(['fill', 'release']);
  });
});
